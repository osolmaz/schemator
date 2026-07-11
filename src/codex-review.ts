import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeJson } from "./files.js";
import { renderFieldPrompt, type RunHistoryEntry } from "./jobs.js";
import type { FieldReview, ModelGraph } from "./types.js";
import { validateFieldReview } from "./validate.js";

export type ReviewerStrategy = "codex" | "pi" | "command";

export type ReviewerOptions = {
  strategy?: ReviewerStrategy;
  command?: string;
  args?: string[];
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  concurrency?: number;
  projectContext?: string;
  runHistory?: RunHistoryEntry[];
};

export type CodexReviewOptions = Omit<ReviewerOptions, "strategy" | "args">;

export async function writeCodexReviews(
  graph: ModelGraph,
  outputDir: string,
  options: CodexReviewOptions = {},
): Promise<FieldReview[]> {
  return writeReviewerReviews(graph, outputDir, { ...options, strategy: "codex" });
}

export async function writeReviewerReviews(
  graph: ModelGraph,
  outputDir: string,
  options: ReviewerOptions = {},
): Promise<FieldReview[]> {
  await prepareGeneratedOutputDir(outputDir, ".review.json");
  const strategy = options.strategy ?? "codex";
  const jobs = graph.models.flatMap((model) => model.fields.map((field) => ({ model, field })));
  const reviews = new Array<FieldReview>(jobs.length);
  let cursor = 0;
  let firstError: unknown;
  const abortController = new AbortController();
  const workerCount = Math.min(Math.max(1, options.concurrency ?? 4), Math.max(1, jobs.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!abortController.signal.aborted && cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (!job) {
        continue;
      }
      try {
        const { model, field } = job;
        const prompt = renderFieldPrompt(
          graph,
          model,
          field,
          {
            ...(options.projectContext === undefined ? {} : { projectContext: options.projectContext }),
            ...(options.runHistory === undefined ? {} : { runHistory: options.runHistory }),
          },
        );
        const review = bindReviewIdentity(
          await runFieldReview(prompt, { ...options, strategy }, abortController.signal),
          model.id,
          field.path,
        );
        const validation = validateFieldReview(review);
        if (!validation.ok) {
          throw new Error(
            `${strategy} review for ${model.id}.${field.path} is invalid:\n${validation.errors.join("\n")}`,
          );
        }
        reviews[index] = review;
        const fileName = `${pathToFileNamePart(model.id)}.${pathToFileNamePart(field.path)}.review.json`;
        await writeJson(join(outputDir, fileName), review);
      } catch (error) {
        firstError ??= error;
        abortController.abort();
        throw error;
      }
    }
  });
  try {
    await Promise.all(workers);
  } catch (error) {
    throw firstError ?? error;
  }
  for (const review of reviews) {
    if (!review) {
      throw new Error(`${strategy} review worker finished without writing every review.`);
    }
  }
  return reviews;
}

function bindReviewIdentity(review: FieldReview, model: string, fieldPath: string): FieldReview {
  return {
    ...review,
    model,
    fieldPath,
  };
}

async function runFieldReview(
  prompt: string,
  options: ReviewerOptions & { strategy: ReviewerStrategy },
  signal?: AbortSignal,
): Promise<FieldReview> {
  const output = options.strategy === "codex"
    ? await runCodexFieldReview(prompt, options, signal)
    : options.strategy === "pi"
      ? await runPiFieldReview(prompt, options, signal)
      : await runCommandFieldReview(prompt, options, signal);
  return parseFieldReviewOutput(output, options.strategy);
}

async function runCodexFieldReview(
  prompt: string,
  options: ReviewerOptions,
  signal?: AbortSignal,
): Promise<string> {
  const command = options.command ?? "codex";
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-schema",
    fieldReviewSchemaPath(),
    "--color",
    "never",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.args ?? []),
    "-",
  ];
  return execWithInput(command, args, prompt, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function runPiFieldReview(
  prompt: string,
  options: ReviewerOptions,
  signal?: AbortSignal,
): Promise<string> {
  const command = options.command ?? "pi";
  const args = [
    "--print",
    "--no-session",
    "--source",
    "child-agent",
    "--no-tools",
    "--no-context-files",
    "--no-skills",
    "--mode",
    "text",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.args ?? []),
    prompt,
  ];
  return execWithInput(command, args, "", {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function runCommandFieldReview(
  prompt: string,
  options: ReviewerOptions,
  signal?: AbortSignal,
): Promise<string> {
  const command = options.command;
  if (!command) {
    throw new Error("--reviewer-command is required for --strategy command");
  }
  return execWithInput(command, options.args ?? [], prompt, {
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(signal === undefined ? {} : { signal }),
  });
}

function fieldReviewSchemaPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "field-review.codex-output.schema.json");
}

function execWithInput(
  command: string,
  args: string[],
  input: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${command} aborted before start`));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (output: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(output);
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      fail(new Error(`${command} aborted`));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        fail(new Error(`${command} exited with ${code ?? "unknown"}:\n${stderr || stdout}`));
        return;
      }
      succeed(stdout);
    });
    child.stdin.end(input);
  });
}

function parseFieldReviewOutput(output: string, strategy: string): FieldReview {
  const trimmed = output.trim();
  const direct = tryParseJson(trimmed);
  if (direct) {
    return normalizeFieldReview(direct);
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(output);
  const fencedJson = fenced?.[1] ? tryParseJson(fenced[1].trim()) : null;
  if (fencedJson) {
    return normalizeFieldReview(fencedJson);
  }

  const objectText = firstJsonObject(output);
  const objectJson = objectText ? tryParseJson(objectText) : null;
  if (objectJson) {
    return normalizeFieldReview(objectJson);
  }

  throw new Error(`${strategy} review did not return a JSON object`);
}

function normalizeFieldReview(value: unknown): FieldReview {
  if (!isRecord(value)) {
    return value as FieldReview;
  }
  const review = { ...value };
  if (review["finalPath"] === null) {
    delete review["finalPath"];
  }
  if (review["ownerBoundary"] === null) {
    delete review["ownerBoundary"];
  }
  return review as FieldReview;
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function firstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
