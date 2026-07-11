#!/usr/bin/env node
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { findSkillsRoot, maybeHandleSkillflag } from "skillflag";
import { renderPatchPlan } from "./apply.js";
import { writeReviewerReviews, type ReviewerStrategy } from "./codex-review.js";
import { aggregateFromFiles, combineAggregates, deriveFinalGraph, runConvergence } from "./convergence.js";
import { diffGraphs, renderGraphDiff } from "./diff.js";
import { extractGraph } from "./extract/index.js";
import { readJson, readText, resolvePath, writeJson, writeText } from "./files.js";
import { writeReviewJobs, type FieldPromptOptions, type RunHistoryEntry } from "./jobs.js";
import { renderReport, renderRunReport, type ReductionArtifact } from "./report.js";
import { writeDeterministicReviews } from "./review.js";
import type { AggregateReview, ModelGraph } from "./types.js";
import { validateAggregateReview, validateFieldReview, validateModelGraph } from "./validate.js";

await maybeHandleSkillflag(process.argv, {
  skillsRoot: findSkillsRoot(import.meta.url),
  includeBundledSkill: false,
});

const program = new Command();

program
  .name("schemator")
  .description("Extract, challenge, and simplify data models until stable.")
  .version("0.1.0");

program
  .command("extract")
  .requiredOption("--source <path>", "schema or proposal source")
  .requiredOption("--out <path>", "model graph JSON output")
  .action(async (options: { source: string; out: string }) => {
    await runCommand(async () => {
      const graph = await extractGraph(resolvePath(options.source));
      const validation = validateModelGraph(graph);
      if (!validation.ok) {
        throw new Error(`extracted graph is invalid:\n${validation.errors.join("\n")}`);
      }
      await writeJson(resolvePath(options.out), graph);
    });
  });

program
  .command("create-jobs")
  .requiredOption("--graph <path>", "model graph JSON")
  .option("--context <path>", "project/task context Markdown")
  .requiredOption("--out <dir>", "field prompt output directory")
  .action(async (options: { graph: string; context?: string; out: string }) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      const projectContext = await readProjectContext(options.context);
      await writeReviewJobs(graph, resolvePath(options.out), reviewContextOptions(projectContext));
    });
  });

program
  .command("review")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--out <dir>", "review output directory")
  .option("--context <path>", "project/task context Markdown")
  .option("--jobs <dir>", "also write independent field-review prompts")
  .option("--strategy <name>", "review strategy: codex, pi, command, or local", "codex")
  .option("--reviewer-command <path>", "reviewer executable for codex, pi, or command strategy")
  .option("--reviewer-model <name>", "provider/model or model name passed to the reviewer")
  .option("--reviewer-timeout-ms <n>", "per-field reviewer timeout in milliseconds", "120000")
  .option("--reviewer-concurrency <n>", "maximum concurrent external reviewers", "4")
  .option("--reviewer-arg <arg>", "extra reviewer argument; repeat for multiple args", collectOption, [])
  .option("--codex-command <path>", "deprecated alias for --reviewer-command with --strategy codex")
  .option("--codex-model <name>", "deprecated alias for --reviewer-model with --strategy codex")
  .option("--codex-timeout-ms <n>", "deprecated alias for --reviewer-timeout-ms")
  .option("--codex-concurrency <n>", "deprecated alias for --reviewer-concurrency")
  .action(async (options: ReviewCommandOptions) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      const projectContext = await readProjectContext(options.context);
      if (options.jobs) {
        await writeReviewJobs(graph, resolvePath(options.jobs), reviewContextOptions(projectContext));
      }
      const reviews = options.strategy === "local"
        ? await writeDeterministicReviews(graph, resolvePath(options.out), {
          strategy: "local",
          ...reviewContextOptions(projectContext),
        })
        : isReviewerStrategy(options.strategy)
          ? await writeReviewerReviews(graph, resolvePath(options.out), {
            ...reviewerOptions(options),
            strategy: options.strategy,
            ...reviewContextOptions(projectContext),
          })
          : unsupportedStrategy(options.strategy);
      for (const review of reviews) {
        const validation = validateFieldReview(review);
        if (!validation.ok) {
          throw new Error(`generated review is invalid:\n${validation.errors.join("\n")}`);
        }
      }
    });
  });

program
  .command("aggregate")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--reviews <dir>", "review JSON directory")
  .requiredOption("--out <path>", "aggregate JSON output")
  .action(async (options: { graph: string; reviews: string; out: string }) => {
    await runCommand(async () => {
      const aggregate = await aggregateFromFiles(resolvePath(options.graph), resolvePath(options.reviews));
      await writeJson(resolvePath(options.out), aggregate);
      if (!aggregate.ok) {
        process.exitCode = 1;
      }
    });
  });

program
  .command("validate")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--reviews <dir>", "review JSON directory")
  .action(async (options: { graph: string; reviews: string }) => {
    await runCommand(async () => {
      const aggregate = await aggregateFromFiles(resolvePath(options.graph), resolvePath(options.reviews));
      if (!aggregate.ok) {
        for (const finding of aggregate.findings) {
          console.error(`${finding.severity}: ${finding.model ?? ""} ${finding.fieldPath ?? ""} ${finding.message}`);
        }
        process.exitCode = 1;
      }
    });
  });

program
  .command("apply")
  .requiredOption("--graph <path>", "model graph JSON")
  .requiredOption("--aggregate <path>", "aggregate review JSON")
  .requiredOption("--out <path>", "patch plan output")
  .action(async (options: { graph: string; aggregate: string; out: string }) => {
    await runCommand(async () => {
      const graph = assertModelGraph(await readJson(resolvePath(options.graph)));
      const aggregate = assertAggregateReview(await readJson(resolvePath(options.aggregate)));
      if (!aggregate.ok) {
        throw new Error(
          `cannot render patch plan for invalid aggregate:\n${aggregate.findings.map((finding) => finding.message).join("\n")}`,
        );
      }
      await writeText(resolvePath(options.out), renderPatchPlan(graph, aggregate));
    });
  });

program
  .command("report")
  .option("--run <dir>", "schemator run directory")
  .option("--graph <path>", "model graph JSON")
  .option("--aggregate <path>", "aggregate review JSON")
  .requiredOption("--out <path>", "Markdown report output")
  .action(async (options: { run?: string; graph?: string; aggregate?: string; out: string }) => {
    await runCommand(async () => {
      const paths = await reportPaths(options);
      const graph = assertModelGraph(await readJson(paths.graph));
      const aggregates = paths.aggregatePaths ? await Promise.all(paths.aggregatePaths.map(readAggregate)) : null;
      const aggregate = aggregates ? combineAggregates(aggregates) : await readAggregate(paths.aggregate);
      const hasFinalGraph = paths.finalGraph ? await pathExists(paths.finalGraph) : false;
      const finalGraph = paths.finalGraph && hasFinalGraph
        ? assertModelGraph(await readJson(paths.finalGraph))
        : aggregate.ok
          ? deriveFinalGraph(graph, aggregates ?? [aggregate])
          : undefined;
      const reductions = paths.reductionPaths ? await Promise.all(paths.reductionPaths.map(readReduction)) : null;
      const report = aggregates && reductions && finalGraph
        ? renderRunReport({
          initialGraph: graph,
          finalGraph,
          aggregates,
          reductions,
          stableIteration: reductions.length,
          stable: reductions.at(-1)?.changed === false,
        })
        : renderReport(graph, aggregate, finalGraph);
      await writeText(resolvePath(options.out), report);
    });
  });

program
  .command("diff")
  .requiredOption("--run <dir>", "schemator run directory")
  .option("--out <path>", "Markdown diff output; prints to stdout when omitted")
  .action(async (options: { run: string; out?: string }) => {
    await runCommand(async () => {
      const paths = await reportPaths({ run: options.run });
      const graph = assertModelGraph(await readJson(paths.graph));
      if (!paths.finalGraph || !(await pathExists(paths.finalGraph))) {
        throw new Error(`run directory has no final graph: ${resolvePath(options.run)}`);
      }
      const finalGraph = assertModelGraph(await readJson(paths.finalGraph));
      const diff = renderGraphDiff(diffGraphs(graph, finalGraph));
      if (options.out) {
        await writeText(resolvePath(options.out), diff);
      } else {
        process.stdout.write(diff);
      }
    });
  });

program
  .command("run")
  .requiredOption("--source <path>", "schema or proposal source")
  .requiredOption("--out <dir>", "run output directory")
  .option("--context <path>", "project/task context Markdown")
  .option("--max-iterations <n>", "maximum simplification iterations", "4")
  .option("--strategy <name>", "review strategy: codex, pi, command, or local", "codex")
  .option("--reviewer-command <path>", "reviewer executable for codex, pi, or command strategy")
  .option("--reviewer-model <name>", "provider/model or model name passed to the reviewer")
  .option("--reviewer-timeout-ms <n>", "per-field reviewer timeout in milliseconds", "120000")
  .option("--reviewer-concurrency <n>", "maximum concurrent external reviewers", "4")
  .option("--reviewer-arg <arg>", "extra reviewer argument; repeat for multiple args", collectOption, [])
  .option("--codex-command <path>", "deprecated alias for --reviewer-command with --strategy codex")
  .option("--codex-model <name>", "deprecated alias for --reviewer-model with --strategy codex")
  .option("--codex-timeout-ms <n>", "deprecated alias for --reviewer-timeout-ms")
  .option("--codex-concurrency <n>", "deprecated alias for --reviewer-concurrency")
  .action(async (options: RunCommandOptions) => {
    await runCommand(async () => {
      const source = resolvePath(options.source);
      const out = resolvePath(options.out);
      const maxIterations = Number.parseInt(options.maxIterations, 10);
      if (!Number.isInteger(maxIterations) || maxIterations < 1) {
        throw new Error("--max-iterations must be a positive integer");
      }
      const projectContext = await readProjectContext(options.context);
      if (options.strategy !== "local" && !isReviewerStrategy(options.strategy)) {
        unsupportedStrategy(options.strategy);
      }
      await runConvergence({
        source,
        out,
        maxIterations,
        strategy: options.strategy,
        ...(projectContext === undefined ? {} : { projectContext }),
        reviewer: reviewerOptions(options),
      });
    });
  });

await program.parseAsync();

type ReviewCommandOptions = {
  graph: string;
  out: string;
  context?: string;
  jobs?: string;
  strategy: string;
  reviewerCommand?: string;
  reviewerModel?: string;
  reviewerTimeoutMs?: string;
  reviewerConcurrency?: string;
  reviewerArg?: string[];
  codexCommand?: string;
  codexModel?: string;
  codexTimeoutMs?: string;
  codexConcurrency?: string;
};

type RunCommandOptions = {
  source: string;
  out: string;
  context?: string;
  maxIterations: string;
  strategy: string;
  reviewerCommand?: string;
  reviewerModel?: string;
  reviewerTimeoutMs?: string;
  reviewerConcurrency?: string;
  reviewerArg?: string[];
  codexCommand?: string;
  codexModel?: string;
  codexTimeoutMs?: string;
  codexConcurrency?: string;
};

type ReviewerCommandOptions = Pick<
  ReviewCommandOptions,
  | "strategy"
  | "reviewerCommand"
  | "reviewerModel"
  | "reviewerTimeoutMs"
  | "reviewerConcurrency"
  | "reviewerArg"
  | "codexCommand"
  | "codexModel"
  | "codexTimeoutMs"
  | "codexConcurrency"
>;

function reviewerOptions(options: ReviewerCommandOptions): {
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs: number;
  concurrency: number;
} {
  const timeoutRaw = options.reviewerTimeoutMs ?? options.codexTimeoutMs ?? "120000";
  const timeoutMs = Number.parseInt(timeoutRaw, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("--reviewer-timeout-ms must be a positive integer");
  }
  const concurrencyRaw = options.reviewerConcurrency ?? options.codexConcurrency ?? "4";
  const concurrency = Number.parseInt(concurrencyRaw, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--reviewer-concurrency must be a positive integer");
  }
  const command = options.reviewerCommand ?? options.codexCommand;
  const model = options.reviewerModel ?? options.codexModel;
  return {
    ...(command ? { command } : {}),
    ...(options.reviewerArg && options.reviewerArg.length > 0 ? { args: options.reviewerArg } : {}),
    ...(model ? { model } : {}),
    timeoutMs,
    concurrency,
  };
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function isReviewerStrategy(strategy: string): strategy is ReviewerStrategy {
  return strategy === "codex" || strategy === "pi" || strategy === "command";
}

function unsupportedStrategy(strategy: string): never {
  throw new Error(`unsupported review strategy: ${strategy}`);
}

async function readProjectContext(path: string | undefined): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }
  const resolved = resolvePath(path);
  try {
    return await readText(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read --context file ${resolved}: ${message}`);
  }
}

function reviewContextOptions(
  projectContext: string | undefined,
  runHistory: RunHistoryEntry[] = [],
): FieldPromptOptions {
  return {
    ...(projectContext === undefined ? {} : { projectContext }),
    ...(runHistory.length === 0 ? {} : { runHistory }),
  };
}

async function readAggregate(path: string): Promise<AggregateReview> {
  return assertAggregateReview(await readJson(path));
}

async function readReduction(path: string): Promise<ReductionArtifact> {
  const value = await readJson(path);
  if (!isRecord(value) || typeof value["changed"] !== "boolean") {
    throw new Error(`invalid reduction artifact: ${path}`);
  }
  const applied = value["applied"];
  const skipped = value["skipped"];
  if (!Array.isArray(applied) || !Array.isArray(skipped)) {
    throw new Error(`invalid reduction artifact: ${path}`);
  }
  return value as ReductionArtifact;
}

async function reportPaths(options: { run?: string; graph?: string; aggregate?: string }): Promise<{
  graph: string;
  aggregate: string;
  aggregatePaths?: string[];
  reductionPaths?: string[];
  finalGraph?: string;
}> {
  if (options.run) {
    const runDir = resolvePath(options.run);
    const iteration = await currentRunIteration(runDir);
    const reductionPaths = reductionPathsThrough(runDir, iteration);
    const hasReductions = (await Promise.all(reductionPaths.map(pathExists))).every(Boolean);
    return {
      graph: join(runDir, "graph.iteration-1.json"),
      aggregate: join(runDir, `aggregate.iteration-${iteration}.json`),
      aggregatePaths: aggregatePathsThrough(runDir, iteration),
      ...(hasReductions ? { reductionPaths } : {}),
      finalGraph: join(runDir, "graph.final.json"),
    };
  }
  if (!options.graph || !options.aggregate) {
    throw new Error("report needs either --run or both --graph and --aggregate");
  }
  return {
    graph: resolvePath(options.graph),
    aggregate: resolvePath(options.aggregate),
  };
}

function aggregatePathsThrough(runDir: string, iteration: number): string[] {
  return Array.from({ length: iteration }, (_, index) => join(runDir, `aggregate.iteration-${index + 1}.json`));
}

function reductionPathsThrough(runDir: string, iteration: number): string[] {
  return Array.from({ length: iteration }, (_, index) => join(runDir, `reduction.iteration-${index + 1}.json`));
}

async function currentRunIteration(runDir: string): Promise<number> {
  const summaryPath = join(runDir, "run-summary.json");
  if (await pathExists(summaryPath)) {
    const summary = await readJson(summaryPath);
    const stableIteration = isRecord(summary) ? summary["stableIteration"] : null;
    if (typeof stableIteration === "number" && Number.isInteger(stableIteration) && stableIteration > 0) {
      return stableIteration;
    }
  }
  return latestRunIteration(runDir);
}

async function latestRunIteration(runDir: string): Promise<number> {
  const entries = await readdir(runDir);
  const iterations = entries
    .map((entry) => /^aggregate\.iteration-(\d+)\.json$/.exec(entry)?.[1])
    .filter((iteration): iteration is string => Boolean(iteration))
    .map((iteration) => Number.parseInt(iteration, 10))
    .filter(Number.isInteger)
    .sort((left, right) => right - left);
  const latest = iterations[0];
  if (!latest) {
    throw new Error(`run directory has no aggregate.iteration-*.json files: ${runDir}`);
  }
  return latest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertModelGraph(value: unknown): ModelGraph {
  const validation = validateModelGraph(value);
  if (!validation.ok) {
    throw new Error(`invalid model graph:\n${validation.errors.join("\n")}`);
  }
  return value as ModelGraph;
}

function assertAggregateReview(value: unknown): AggregateReview {
  const validation = validateAggregateReview(value);
  if (!validation.ok) {
    throw new Error(`invalid aggregate review:\n${validation.errors.join("\n")}`);
  }
  return value as AggregateReview;
}

async function runCommand(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
