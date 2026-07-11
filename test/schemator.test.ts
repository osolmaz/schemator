import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { aggregateReviews } from "../src/aggregate.js";
import { renderPatchPlan } from "../src/apply.js";
import { writeCodexReviews, writeReviewerReviews } from "../src/codex-review.js";
import { extractGraph } from "../src/extract/index.js";
import { pathToFileNamePart } from "../src/files.js";
import { applyAggregateToGraph, graphDecisionKey, hasGraphChange, hasSimplification, reduceAggregateGraph } from "../src/graph.js";
import { renderFieldPrompt, writeReviewJobs } from "../src/jobs.js";
import { renderReport, renderRunReport } from "../src/report.js";
import { writeDeterministicReviews } from "../src/review.js";
import type { AggregateReview, ModelGraph } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("schemator", () => {
  test("extracts nested TypeScript fields from Markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type ModelProfilePolicy = {",
          "  promptRecipe?: \"standard-v1\" | \"gpt-5-v1\";",
          "  nested?: {",
          "    value: string;",
          "  };",
          "};",
          "```",
        ].join("\n"),
      );

      const graph = await extractGraph(source);
      const policy = graph.models.find((model) => model.id === "ModelProfilePolicy");
      expect(policy?.fields.map((field) => field.path)).toEqual([
        "promptRecipe",
        "nested",
        "nested.value",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript module source extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      for (const extension of [".mts", ".cts"]) {
        const source = join(dir, `schema${extension}`);
        await writeFile(source, "type Policy = { id: string };\n");
        const graph = await extractGraph(source);

        expect(graph.models.map((model) => model.id)).toEqual(["Policy"]);
        expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts SQL create table columns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.sql");
      await writeFile(
        source,
        [
          "CREATE TABLE public.customer_accounts (",
          "  id uuid PRIMARY KEY,",
          "  display_name text NOT NULL,",
          "  billing_email text,",
          "  marketing_email_opt_in boolean DEFAULT false,",
          "  created_at timestamptz NOT NULL,",
          "  CONSTRAINT customer_accounts_email_check CHECK (billing_email <> '')",
          ");",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.id)).toEqual(["customer_accounts"]);
      expect(graph.models[0]?.kind).toBe("table");
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "id",
        "display_name",
        "billing_email",
        "marketing_email_opt_in",
        "created_at",
      ]);
      expect(graph.models[0]?.fields.find((field) => field.path === "id")?.required).toBe(true);
      expect(graph.models[0]?.fields.find((field) => field.path === "id")?.source.span.startLine).toBe(2);
      expect(graph.models[0]?.fields.find((field) => field.path === "billing_email")?.required).toBe(false);
      expect(graph.models[0]?.fields.find((field) => field.path === "billing_email")?.source.span.startLine).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips MySQL INDEX, FULLTEXT KEY, and SPATIAL INDEX table definitions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.sql");
      await writeFile(
        source,
        [
          "CREATE TABLE articles (",
          "  id int PRIMARY KEY,",
          "  title varchar(255) NOT NULL,",
          "  body text,",
          "  location point,",
          "  INDEX idx_email (email),",
          "  FULLTEXT KEY idx_body (body),",
          "  SPATIAL INDEX idx_location (location)",
          ");",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.id)).toEqual(["articles"]);
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "id",
        "title",
        "body",
        "location",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges duplicate TypeScript model declarations inside Markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "interface Policy {",
          "  id: string;",
          "}",
          "interface Policy {",
          "  variant?: string;",
          "}",
          "```",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.id)).toEqual(["Policy"]);
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id", "variant"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts indented Markdown fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "- model",
          "  ```ts",
          "  type ModelProfilePolicy = {",
          "    promptRecipe?: string;",
          "  };",
          "  ```",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts CommonMark backtick and tilde fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "````typescript",
          "type BacktickPolicy = {",
          "  promptRecipe?: string;",
          "};",
          "````",
          "~~~json",
          "{ \"properties\": { \"contextPosture\": { \"type\": \"string\" } } }",
          "~~~",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.id)).toEqual(["BacktickPolicy", "JsonBlock1"]);
      expect(graph.models.flatMap((model) => model.fields.map((field) => field.path))).toEqual([
        "promptRecipe",
        "contextPosture",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts SQL create table columns around comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.sql");
      await writeFile(
        source,
        [
          "-- leading comment with ;",
          "CREATE TABLE account_events (",
          "  id uuid PRIMARY KEY, -- comma, paren ) in comment",
          "  account_id uuid NOT NULL,",
          "  /* comma, and paren ) in block comment */",
          "  event_type text NOT NULL",
          ");",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.id)).toEqual(["account_events"]);
      expect(graph.models[0]?.source.span.startLine).toBe(2);
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id", "account_id", "event_type"]);
      expect(graph.models[0]?.fields.find((field) => field.path === "id")?.source.span.startLine).toBe(3);
      expect(graph.models[0]?.fields.find((field) => field.path === "event_type")?.source.span.startLine).toBe(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts SQL fences from Markdown proposals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```sql",
          "CREATE TABLE account_events (",
          "  id uuid PRIMARY KEY,",
          "  account_id uuid NOT NULL,",
          "  event_type text NOT NULL",
          ");",
          "```",
        ].join("\n"),
      );

      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.id)).toEqual(["account_events"]);
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id", "account_id", "event_type"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("local fallback does not make field-specific semantic renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.ts", revision: null },
        models: [
          {
            id: "ModelProfilePolicy",
            kind: "object",
            source: { path: "schema.ts", span: { startLine: 1, endLine: 4 } },
            fields: [
              field("promptRecipe", "promptRecipe", "string", false),
              field("extends", "extends", "string", false),
            ],
          },
        ],
      };
      const reviews = await writeDeterministicReviews(graph, join(dir, "reviews"));
      const aggregate = aggregateReviews(graph, reviews);
      const promptReview = aggregate.decisions.find((review) => review.fieldPath === "promptRecipe");
      const extendsReview = aggregate.decisions.find((review) => review.fieldPath === "extends");

      expect(promptReview?.decision).toBe("keep");
      expect(promptReview?.finalName).toBe("promptRecipe");
      expect(extendsReview?.decision).toBe("keep");
      expect(extendsReview?.finalName).toBe("extends");
      expect(hasSimplification(aggregate)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs codex review strategy through one external reviewer per field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeCodex = join(dir, "fake-codex.js");
      const reviewsDir = join(dir, "reviews");
      await writeFakeModelReviewer(fakeCodex);
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.ts", revision: null },
        models: [
          {
            id: "Policy",
            kind: "object",
            source: { path: "schema.ts", span: { startLine: 1, endLine: 3 } },
            fields: [
              {
                path: "promptRecipe",
                name: "promptRecipe",
                type: "string",
                required: false,
                nullable: false,
                parent: "Policy",
                objectLike: false,
                source: { path: "schema.ts", span: { startLine: 2, endLine: 2 } },
              },
              {
                path: "extends",
                name: "extends",
                type: "string",
                required: false,
                nullable: false,
                parent: "Policy",
                objectLike: false,
                source: { path: "schema.ts", span: { startLine: 3, endLine: 3 } },
              },
            ],
          },
        ],
      };

      const reviews = await writeCodexReviews(graph, reviewsDir, { command: fakeCodex, timeoutMs: 5_000 });
      const reviewFiles = await readdirFileNames(reviewsDir);

      expect(reviews).toHaveLength(2);
      expect(reviews.find((review) => review.fieldPath === "promptRecipe")?.decision).toBe("rename");
      expect(reviews.find((review) => review.fieldPath === "promptRecipe")?.finalName).toBe("systemPromptVariant");
      expect(reviews.find((review) => review.fieldPath === "extends")?.decision).toBe("keep");
      expect(reviews.find((review) => review.fieldPath === "extends")?.finalName).toBe("extends");
      expect(reviews[0]).not.toHaveProperty("ownerBoundary");
      expect(reviewFiles).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs command review strategy through a stdin reviewer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeReviewer = join(dir, "fake-reviewer.js");
      const promptPath = join(dir, "prompt.txt");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakeReviewer,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "let prompt = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { prompt += chunk; });",
          "process.stdin.on('end', () => {",
          "  fs.writeFileSync(process.env.SCHEMATOR_PROMPT_PATH, prompt);",
          "  console.log(JSON.stringify({",
          "    schemaVersion: 1,",
          "    model: 'Policy',",
          "    fieldPath: 'id',",
          "    decision: 'keep',",
          "    finalName: 'id',",
          "    finalType: 'string',",
          "    required: true,",
          "    rationale: 'test',",
          "    alternatives: ['id'],",
          "    simplestChoice: 'id',",
          "    confidence: 'high',",
          "    questions: []",
          "  }));",
          "});",
        ].join("\n"),
      );
      await chmod(fakeReviewer, 0o755);
      const originalPromptPath = process.env["SCHEMATOR_PROMPT_PATH"];
      process.env["SCHEMATOR_PROMPT_PATH"] = promptPath;
      try {
        const reviews = await writeReviewerReviews(graphWithOneField("Policy", "id", "id"), reviewsDir, {
          strategy: "command",
          command: fakeReviewer,
          timeoutMs: 5_000,
        });
        const prompt = await readFile(promptPath, "utf8");

        expect(reviews[0]?.decision).toBe("keep");
        expect(prompt).toContain("# Schemator Field Review");
        expect(prompt).toContain("Allowed `decision` values");
      } finally {
        if (originalPromptPath === undefined) {
          delete process.env["SCHEMATOR_PROMPT_PATH"];
        } else {
          process.env["SCHEMATOR_PROMPT_PATH"] = originalPromptPath;
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs pi review strategy with model and extra args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakePi = join(dir, "fake-pi.js");
      const argsPath = join(dir, "args.json");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakePi,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "fs.writeFileSync(process.env.SCHEMATOR_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
          "console.log(JSON.stringify({",
          "  schemaVersion: 1,",
          "  model: 'Policy',",
          "  fieldPath: 'id',",
          "  decision: 'keep',",
          "  finalName: 'id',",
          "  finalType: 'string',",
          "  required: true,",
          "  rationale: 'test',",
          "  alternatives: ['id'],",
          "  simplestChoice: 'id',",
          "  confidence: 'high',",
          "  questions: []",
          "}));",
        ].join("\n"),
      );
      await chmod(fakePi, 0o755);
      const originalArgsPath = process.env["SCHEMATOR_ARGS_PATH"];
      process.env["SCHEMATOR_ARGS_PATH"] = argsPath;
      try {
        await writeReviewerReviews(graphWithOneField("Policy", "id", "id"), reviewsDir, {
          strategy: "pi",
          command: fakePi,
          model: "claude-bridge/claude-sonnet-4-6",
          args: ["--thinking", "off"],
          timeoutMs: 5_000,
        });
        const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];

        expect(args.slice(0, 9)).toEqual([
          "--print",
          "--no-session",
          "--source",
          "child-agent",
          "--no-tools",
          "--no-context-files",
          "--no-skills",
          "--mode",
          "text",
        ]);
        expect(args).toContain("--model");
        expect(args).toContain("claude-bridge/claude-sonnet-4-6");
        expect(args).toContain("--thinking");
        expect(args.at(-1)).toContain("# Schemator Field Review");
      } finally {
        if (originalArgsPath === undefined) {
          delete process.env["SCHEMATOR_ARGS_PATH"];
        } else {
          process.env["SCHEMATOR_ARGS_PATH"] = originalArgsPath;
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("binds Codex review identity to the reviewed field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeCodex = join(dir, "fake-codex.js");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify({",
          "  schemaVersion: 1,",
          "  model: 'WrongModel',",
          "  fieldPath: 'Policy.id',",
          "  decision: 'keep',",
          "  finalName: 'id',",
          "  finalType: 'string',",
          "  required: true,",
          "  rationale: 'test',",
          "  alternatives: ['id'],",
          "  simplestChoice: 'id',",
          "  confidence: 'high',",
          "  questions: []",
          "}));",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);
      const graph = graphWithOneField("Policy", "id", "id");

      const reviews = await writeCodexReviews(graph, reviewsDir, { command: fakeCodex, timeoutMs: 5_000 });
      const reviewFiles = await readdirFileNames(reviewsDir);
      const written = JSON.parse(await readFile(join(reviewsDir, reviewFiles[0] ?? ""), "utf8")) as {
        model: string;
        fieldPath: string;
      };

      expect(reviews[0]?.model).toBe("Policy");
      expect(reviews[0]?.fieldPath).toBe("id");
      expect(written.model).toBe("Policy");
      expect(written.fieldPath).toBe("id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes project context in generated field prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const jobsDir = join(dir, "jobs");
      const graph = graphWithOneField("Policy", "extends", "extends");
      await writeReviewJobs(graph, jobsDir, {
        projectContext: [
          "This schema uses durable declarative configuration vocabulary.",
          "Profiles may be optimized with GEPA.",
        ].join("\n"),
      });
      const jobFiles = await readdirFileNames(jobsDir);
      const prompt = await readFile(join(jobsDir, jobFiles[0] ?? ""), "utf8");

      expect(prompt).toContain("## Project And Task Context");
      expect(prompt).toContain("durable declarative configuration vocabulary");
      expect(prompt).toContain("Profiles may be optimized with GEPA.");
      expect(prompt.indexOf("## Project And Task Context")).toBeLessThan(prompt.indexOf("## Field Under Review"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes accepted run decisions in generated field prompts", () => {
    const graph = graphWithOneField("Policy", "systemPromptVariant", "systemPromptVariant");
    const model = graph.models[0];
    const field = model?.fields[0];
    if (!model || !field) {
      throw new Error("test graph has no field");
    }

    const prompt = renderFieldPrompt(graph, model, field, {
      runHistory: [
        {
          iteration: 1,
          model: "Policy",
          fieldPath: "promptRecipe",
          decision: "rename",
          finalPath: "systemPromptVariant",
        },
      ],
    });

    expect(prompt).toContain("## Accepted Run Decisions");
    expect(prompt).toContain("`Policy.promptRecipe` was renamed to `systemPromptVariant`");
    expect(prompt).toContain("avoid synonym churn");
    expect(prompt.indexOf("## Accepted Run Decisions")).toBeLessThan(prompt.indexOf("## Field Under Review"));
  });

  test("omits project context section when no context is supplied", async () => {
    const graph = graphWithOneField("Policy", "id", "id");
    const prompt = await promptForGraph(graph);

    expect(prompt).not.toContain("## Project And Task Context");
  });

  test("does not inject unrelated field-specific rename hints into prompts", async () => {
    const graph = graphWithOneField("Policy", "id", "id");
    const prompt = await promptForGraph(graph);

    expect(prompt).not.toContain("promptRecipe");
    expect(prompt).not.toContain("contextPosture");
    expect(prompt).not.toContain("baseProfileId");
  });

  test("discourages longer explicit names without real ambiguity", async () => {
    const graph = graphWithOneField("Policy", "profile", "profile");
    const prompt = await promptForGraph(graph);

    expect(prompt).toContain("Prefer the shortest clear name");
    expect(prompt).toContain("Do not add suffixes like `Id`, `Mode`, `Policy`, `Preset`, `Default`, or `Config`");
    expect(prompt).toContain("only when the suffix changes the meaning or prevents a real ambiguity");
  });

  test("includes referenced model fields in generated field prompts", async () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.ts", revision: null },
      models: [
        {
          id: "Parent",
          kind: "object",
          source: { path: "schema.ts", span: { startLine: 1, endLine: 3 } },
          fields: [
            {
              path: "child",
              name: "child",
              type: "Child",
              required: true,
              nullable: false,
              parent: "Parent",
              objectLike: true,
              ref: "Child",
              source: { path: "schema.ts", span: { startLine: 2, endLine: 2 } },
            },
          ],
        },
        {
          id: "Child",
          kind: "object",
          source: { path: "schema.ts", span: { startLine: 4, endLine: 6 } },
          fields: [
            {
              path: "name",
              name: "name",
              type: "string",
              required: true,
              nullable: false,
              parent: "Child",
              objectLike: false,
              source: { path: "schema.ts", span: { startLine: 5, endLine: 5 } },
            },
          ],
        },
      ],
    };
    const prompt = await promptForGraph(graph);

    expect(prompt).toContain("- `Child`:");
    expect(prompt).toContain("  - `name`: `string`");
  });

  test("passes project context through the Codex review adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeCodex = join(dir, "fake-codex.js");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "let prompt = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { prompt += chunk; });",
          "process.stdin.on('end', () => {",
          "  if (!prompt.includes('Profiles may be optimized with GEPA.')) {",
          "    console.error('missing project context');",
          "    process.exit(1);",
          "  }",
          "  const model = /- Model: `([^`]+)`/.exec(prompt)?.[1] ?? 'Unknown';",
          "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
          "  const fieldName = /- Field name: `([^`]+)`/.exec(prompt)?.[1] ?? fieldPath;",
          "  console.log(JSON.stringify({",
          "    schemaVersion: 1,",
          "    model,",
          "    fieldPath,",
          "    decision: 'keep',",
          "    finalName: fieldName,",
          "    finalPath: null,",
          "    finalType: 'string',",
          "    required: false,",
          "    rationale: 'Fake reviewer received project context.',",
          "    alternatives: [fieldName, 'remove'],",
          "    simplestChoice: fieldName,",
          "    confidence: 'high',",
          "    questions: [],",
          "    ownerBoundary: null",
          "  }));",
          "});",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);
      const graph = graphWithOneField("Policy", "id", "id");

      const reviews = await writeCodexReviews(graph, reviewsDir, {
        command: fakeCodex,
        timeoutMs: 5_000,
        projectContext: "Profiles may be optimized with GEPA.",
      });

      expect(reviews).toHaveLength(1);
      expect(reviews[0]?.rationale).toBe("Fake reviewer received project context.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes accepted run decisions through the Codex review adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeCodex = join(dir, "fake-codex.js");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "let prompt = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { prompt += chunk; });",
          "process.stdin.on('end', () => {",
          "  if (!prompt.includes('## Accepted Run Decisions')) {",
          "    console.error('missing run history');",
          "    process.exit(1);",
          "  }",
          "  const model = /- Model: `([^`]+)`/.exec(prompt)?.[1] ?? 'Unknown';",
          "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
          "  const fieldName = /- Field name: `([^`]+)`/.exec(prompt)?.[1] ?? fieldPath;",
          "  console.log(JSON.stringify({",
          "    schemaVersion: 1,",
          "    model,",
          "    fieldPath,",
          "    decision: 'keep',",
          "    finalName: fieldName,",
          "    finalPath: null,",
          "    finalType: 'string',",
          "    required: false,",
          "    rationale: 'Fake reviewer received run history.',",
          "    alternatives: [fieldName, 'remove'],",
          "    simplestChoice: fieldName,",
          "    confidence: 'high',",
          "    questions: [],",
          "    ownerBoundary: null",
          "  }));",
          "});",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);
      const graph = graphWithOneField("Policy", "systemPromptVariant", "systemPromptVariant");

      const reviews = await writeCodexReviews(graph, reviewsDir, {
        command: fakeCodex,
        timeoutMs: 5_000,
        runHistory: [
          {
            iteration: 1,
            model: "Policy",
            fieldPath: "promptRecipe",
            decision: "rename",
            finalPath: "systemPromptVariant",
          },
        ],
      });

      expect(reviews[0]?.rationale).toBe("Fake reviewer received run history.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cancels in-flight Codex reviewers after a worker failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const fakeCodex = join(dir, "cancellable-codex.js");
      const logPath = join(dir, "events.log");
      const reviewsDir = join(dir, "reviews");
      await writeFile(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "const logPath = process.env.SCHEMATOR_FAKE_CODEX_LOG;",
          "let prompt = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { prompt += chunk; });",
          "process.stdin.on('end', () => {",
          "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
          "  fs.appendFileSync(logPath, `start:${fieldPath}\\n`);",
          "  if (fieldPath === 'bad') {",
          "    setTimeout(() => {",
          "      fs.appendFileSync(logPath, 'fail:bad\\n');",
          "      process.exit(1);",
          "    }, 200);",
          "    return;",
          "  }",
          "  process.on('SIGTERM', () => {",
          "    fs.appendFileSync(logPath, `terminated:${fieldPath}\\n`);",
          "    process.exit(0);",
          "  });",
          "  setTimeout(() => {",
          "    console.log(JSON.stringify({",
          "      schemaVersion: 1,",
          "      model: 'Policy',",
          "      fieldPath,",
          "      decision: 'keep',",
          "      finalName: fieldPath,",
          "      finalPath: null,",
          "      finalType: 'string',",
          "      required: false,",
          "      rationale: 'slow success',",
          "      alternatives: [fieldPath],",
          "      simplestChoice: fieldPath,",
          "      confidence: 'high',",
          "      questions: [],",
          "      ownerBoundary: null",
          "    }));",
          "  }, 10000);",
          "});",
        ].join("\n"),
      );
      await chmod(fakeCodex, 0o755);
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.ts", revision: null },
        models: [
          {
            id: "Policy",
            kind: "object",
            source: { path: "schema.ts", span: { startLine: 1, endLine: 4 } },
            fields: [
              fieldForModel("Policy", "bad", "bad"),
              fieldForModel("Policy", "slow", "slow"),
            ],
          },
        ],
      };
      const originalLog = process.env["SCHEMATOR_FAKE_CODEX_LOG"];
      process.env["SCHEMATOR_FAKE_CODEX_LOG"] = logPath;
      try {
        await expect(
          writeCodexReviews(graph, reviewsDir, {
            command: fakeCodex,
            timeoutMs: 5_000,
            concurrency: 2,
          }),
        ).rejects.toThrow(/exited with 1|aborted/);
      } finally {
        if (originalLog === undefined) {
          delete process.env["SCHEMATOR_FAKE_CODEX_LOG"];
        } else {
          process.env["SCHEMATOR_FAKE_CODEX_LOG"] = originalLog;
        }
      }

      const log = await readFile(logPath, "utf8");
      expect(log).toContain("start:bad");
      expect(log).toContain("start:slow");
      expect(log).toContain("terminated:slow");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aggregates JSON Schema reviews and keeps nested coverage valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            policy: {
              type: "object",
              properties: {
                promptRecipe: { type: "string" },
              },
            },
          },
          required: ["policy"],
        }),
      );
      const graph = await extractGraph(source);
      const reviews = await writeDeterministicReviews(graph, join(dir, "reviews"));
      const aggregate = aggregateReviews(graph, reviews);

      expect(aggregate.ok).toBe(true);
      expect(aggregate.decisions.every((review) => review.decision === "keep")).toBe(true);
      await writeFile(join(dir, "aggregate.json"), JSON.stringify(aggregate, null, 2));
      const saved = JSON.parse(await readFile(join(dir, "aggregate.json"), "utf8")) as { ok: boolean };
      expect(saved.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps generated reviews valid for empty object leaves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          settings: {},
        }),
      );
      const graph = await extractGraph(source);
      const reviews = await writeDeterministicReviews(graph, join(dir, "reviews"));
      const aggregate = aggregateReviews(graph, reviews);

      expect(aggregate.ok).toBe(true);
      expect(aggregate.decisions.find((review) => review.fieldPath === "settings")?.decision).toBe("opaque");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects opaque reviews without owner boundaries", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("settings", "settings", "object", true)],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("settings", "settings"),
        decision: "opaque",
      },
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Opaque review decisions require an ownerBoundary.",
    );
  });

  test("accepts owner-bounded object-like leaf renames", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("settings", "settings", "object", true)],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("settings", "parameters"),
        ownerBoundary: "The owner validates keys inside this object.",
      },
    ]);

    expect(aggregate.ok).toBe(true);
  });

  test("accepts removal-like decisions for object-like leaves", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("settings", "settings", "object", true)],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("settings", "settings"),
        decision: "remove",
        simplestChoice: "remove",
      },
    ]);

    expect(aggregate.ok).toBe(true);
  });

  test("extracts JSON Schema array item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema map object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["additionalProperties", true, true],
        ["additionalProperties.id", true, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema map scalar values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          additionalProperties: { type: "string" },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["additionalProperties", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects metadata-backed root JSON Schema map values without explicit type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          additionalProperties: { type: "string" },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["additionalProperties", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts permissive JSON Schema map values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          additionalProperties: true,
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike, field.nullable])).toEqual([
        ["additionalProperties", "unknown", true, true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts empty-schema JSON Schema map values as permissive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          additionalProperties: {},
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike, field.nullable])).toEqual([
        ["additionalProperties", "unknown", true, true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks unconstrained JSON Schema properties nullable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            anything: {},
            described: { description: "any JSON value" },
          },
          required: ["anything", "described"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.nullable])).toEqual([
        ["anything", true],
        ["described", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema pattern property scalar values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          patternProperties: {
            "^S_": { type: "string" },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.name, field.type, field.objectLike])).toEqual([
        ["patternProperties.^S_", "^S_", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema pattern property object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          patternProperties: {
            "^profile\\.": {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["patternProperties.^profile\\~1", true, true],
        ["patternProperties.^profile\\~1.id", true, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses fallback model id for empty JSON Schema titles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          title: "  ",
          type: "object",
          properties: {
            id: { type: "string" },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.id).toBe("JsonSchema");
      expect(graph.models[0]?.fields[0]?.parent).toBe("JsonSchema");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates required JSON Schema array parents to item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
              },
            },
          },
          required: ["entries"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["entries", true],
        ["entries[].value", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates optional JSON Schema parents to nested required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["config", false],
        ["config.id", false],
        ["entries", false],
        ["entries[].value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable JSON Schema parents to nested required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              type: ["object", "null"],
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, true],
        ["config.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks JSON Schema enum and const null fields nullable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            maybe: { enum: [null, "enabled"] },
            literal: { const: null },
          },
          required: ["maybe", "literal"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.nullable])).toEqual([
        ["maybe", true],
        ["literal", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps JSON Schema enum and const fields non-nullable when type excludes null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            status: { type: "string", enum: [null, "enabled"] },
            literal: { type: "string", const: null },
          },
          required: ["status", "literal"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.nullable])).toEqual([
        ["status", false],
        ["literal", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates JSON Schema combinator nullability to nested required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                  },
                  required: ["id"],
                },
                { type: "null" },
              ],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, true],
        ["config.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates JSON Schema allOf nullability through unconstrained branches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              allOf: [
                { type: ["object", "null"] },
                {
                  properties: {
                    id: { type: "string" },
                  },
                  required: ["id"],
                },
              ],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, true],
        ["config.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps JSON Schema allOf enum and const exclusions non-nullable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            status: { allOf: [{ enum: ["enabled"] }] },
            literal: { allOf: [{ const: "enabled" }] },
          },
          required: ["status", "literal"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.nullable])).toEqual([
        ["status", false],
        ["literal", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks JSON Schema descendants optional when object schemas can be scalar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["payload"],
          properties: {
            payload: {
              type: ["object", "string"],
              required: ["id"],
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["payload", true],
        ["payload.id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema object and array descendants from mixed containers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["payload"],
          properties: {
            payload: {
              type: ["object", "array"],
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
              items: {
                type: "object",
                properties: {
                  code: { type: "string" },
                },
                required: ["code"],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["payload", true],
        ["payload.id", false],
        ["payload[].code", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable JSON Schema roots to required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: ["object", "null"],
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema array item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema arrays without metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["items", "array", true],
        ["items[].id", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects root JSON Schema arrays without explicit type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["items", true, true],
        ["items[].id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts boolean JSON Schema array items as unconstrained", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "array",
          items: true,
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.nullable])).toEqual([
        ["items", "unknown", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema prefix item object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "array",
          prefixItems: [
            {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["items", true, true],
        ["items[].id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema tuple item object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "array",
          items: [
            {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
            {
              type: "object",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["items", true, true],
        ["items[].id", false, false],
        ["items[].name", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts primitive root JSON Schema array items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "array",
          items: {
            type: "string",
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["items", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable primitive root JSON Schema array items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "array",
          items: {
            type: ["string", "null"],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.nullable])).toEqual([
        ["items", "string | null", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema array item fields when type is omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            rows: {
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
                required: ["id"],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["rows", "array", true],
        ["rows[].id", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level JSON Schema refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $ref: "#/$defs/Profile",
          $defs: {
            Profile: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema ref sibling fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            thing: {
              $ref: "#/$defs/Base",
              properties: {
                name: { type: "string" },
              },
              required: ["name"],
            },
          },
          required: ["thing"],
          $defs: {
            Base: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["thing", true],
        ["thing.id", true],
        ["thing.name", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema combinator object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          allOf: [
            {
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          ],
          anyOf: [
            {
              properties: {
                promptRecipe: { type: "string" },
              },
              required: ["promptRecipe"],
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["id", true],
        ["promptRecipe", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges JSON Schema alternative field types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          anyOf: [
            {
              type: "object",
              properties: {
                value: { type: "string" },
              },
            },
            {
              type: "object",
              properties: {
                value: { type: "number" },
              },
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type])).toEqual([
        ["value", "string | number"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates JSON Schema allOf required fields across branches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          allOf: [
            { required: ["id"] },
            {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["id", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps typed JSON Schema combinators non-nullable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["config"],
          properties: {
            config: {
              type: "object",
              allOf: [{}],
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, false],
        ["config.id", true, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema child combinator object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              allOf: [
                {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                  },
                  required: ["id"],
                },
              ],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike, field.required])).toEqual([
        ["config", true, true],
        ["config.id", false, true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects YAML JSON Schema documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.yaml");
      await writeFile(
        source,
        [
          "type: object",
          "properties:",
          "  promptRecipe:",
          "    type: string",
          "required:",
          "  - promptRecipe",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
      expect(graph.models[0]?.fields[0]?.required).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects Markdown YAML JSON Schema fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```yaml",
          "type: object",
          "properties:",
          "  promptRecipe:",
          "    type: string",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stops ordinary YAML extraction at recursive anchor boundaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.yaml");
      await writeFile(source, ["a: &a", "  b: *a"].join("\n"));
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike])).toEqual([
        ["a", true],
        ["a.b", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable JSON Schema array item fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            items: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
      expect(graph.models[0]?.fields[0]?.nullable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks nullable JSON Schema array item fields optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
                required: ["id"],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["items", true, true],
        ["items[].id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks scalar-capable JSON Schema array item fields optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["items"],
          properties: {
            items: {
              type: ["array", "string"],
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
                required: ["id"],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema local ref object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            policy: {
              $ref: "#/$defs/Policy",
            },
          },
          $defs: {
            Policy: {
              type: "object",
              properties: {
                promptRecipe: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["policy", "policy.promptRecipe"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts URI-escaped JSON Schema local ref object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            policy: {
              $ref: "#/$defs/policy%20schema",
            },
          },
          $defs: {
            "policy schema": {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike])).toEqual([
        ["policy", true],
        ["policy.id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable JSON Schema ref targets to nested required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["child"],
          properties: {
            child: { $ref: "#/$defs/MaybeChild" },
          },
          $defs: {
            MaybeChild: {
              type: ["object", "null"],
              required: ["id"],
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["child", true, true],
        ["child.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies JSON Schema ref sibling constraints to nullability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["child"],
          properties: {
            child: {
              $ref: "#/$defs/MaybeChild",
              type: "object",
            },
          },
          $defs: {
            MaybeChild: {
              type: ["object", "null"],
              required: ["id"],
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["child", true, false],
        ["child.id", true, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("applies JSON Schema ref sibling enum constraints to nullability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          required: ["child"],
          properties: {
            child: {
              $ref: "#/$defs/MaybeChild",
              enum: [{ id: "one" }],
            },
          },
          $defs: {
            MaybeChild: {
              type: ["object", "null"],
              required: ["id"],
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["child", true, false],
        ["child.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable root JSON Schema ref targets to required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $ref: "#/$defs/MaybePolicy",
          $defs: {
            MaybePolicy: {
              type: ["object", "null"],
              required: ["id"],
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([["id", false]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema array item ref fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                $ref: "#/$defs/Item",
              },
            },
          },
          $defs: {
            Item: {
              type: "object",
              properties: {
                id: { type: "string" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema array item combinator fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                anyOf: [
                  {
                    type: "object",
                    required: ["id"],
                    properties: {
                      id: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", false],
        ["items[].id", false],
      ]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts root JSON Schema array item combinator fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "array",
          items: {
            allOf: [
              {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                },
              },
            ],
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", true],
      ]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts JSON Schema refs to array schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            children: {
              $ref: "#/$defs/ChildList",
            },
          },
          $defs: {
            ChildList: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["children", "children[].id"]);
      expect(graph.models[0]?.fields[0]?.objectLike).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves array kind for root JSON Schema array refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $ref: "#/$defs/ChildList",
          $defs: {
            ChildList: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounds recursive JSON Schema local refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            child: { $ref: "#/$defs/Node" },
          },
          $defs: {
            Node: {
              type: "object",
              properties: {
                child: { $ref: "#/$defs/Node" },
              },
            },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["child", "child.child"]);
      expect(graph.models[0]?.fields.map((field) => field.objectLike)).toEqual([true, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts bare root JSON Schema refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            child: { $ref: "#" },
            name: { type: "string" },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "child",
        "child.child",
        "child.name",
        "name",
      ]);
      expect(graph.models[0]?.fields.map((field) => field.objectLike)).toEqual([true, true, false, false]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts Markdown JSONC fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```jsonc",
          "{",
          "  // comments and trailing commas are valid JSONC",
          '  "promptRecipe": "standard-v1",',
          "}",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips invalid Markdown JSONC expressions instead of coercing null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```jsonc",
          "{",
          '  "validNull": null,',
          "}",
          "```",
          "```jsonc",
          "{",
          '  "invalidExpression": undefined,',
          "}",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models.map((model) => model.fields.map((field) => [field.path, field.nullable]))).toEqual([
        [["validNull", true]],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts Markdown JSONC array fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```jsonc",
          "[",
          '  { "id": "a" },',
          "  // comments and trailing commas are valid JSONC",
          '  { "name": "b" },',
          "]",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id", "items[].name"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts Markdown fences with info strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts title=\"schema.ts\"",
          "type Profile = {",
          "  id: string;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes property-only JSON Schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([["id", true]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates required nested property-only JSON Schemas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          properties: {
            config: {
              properties: {
                id: { type: "string" },
              },
              required: ["id"],
            },
          },
          required: ["config"],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["config", true],
        ["config.id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes metadata-backed typeless JSON Schema properties", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          properties: {
            foo: {},
            bar: { description: "metadata-only child schema" },
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["foo", "bar"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat ordinary JSON properties bags as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          id: "example",
          properties: {
            promptRecipe: "standard-v1",
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "id",
        "properties",
        "properties.promptRecipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat single-key ordinary JSON properties bags as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          properties: {
            promptRecipe: "standard-v1",
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "properties",
        "properties.promptRecipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat ordinary JSON schema metadata as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          $schema: "https://example.com/schema.json",
          promptRecipe: "standard-v1",
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["$schema", "promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not treat ordinary JSON type field as JSON Schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          type: "object",
          name: "Profile",
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["type", "name"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("escapes ordinary JSON field path separators", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          "a.b": 1,
          "array[]": 2,
          a: {
            b: 3,
          },
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.name])).toEqual([
        ["a~1b", "a.b"],
        ["array~2~3", "array[]"],
        ["a", "a"],
        ["a.b", "b"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              id: "a",
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual(["items", "items[].id"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            id: "a",
          },
          {
            promptRecipe: "standard-v1",
          },
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "items[].promptRecipe",
      ]);
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
        ["items[].promptRecipe", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts unioned ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              id: "a",
            },
            {
              promptRecipe: "standard-v1",
              nested: {
                value: "x",
              },
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "items[].promptRecipe",
        "items[].nested",
        "items[].nested.value",
      ]);
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
        ["items[].promptRecipe", false],
        ["items[].nested", false],
        ["items[].nested.value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves null alternatives in ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              nested: {
                value: "x",
              },
            },
            {
              nested: null,
            },
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["items", true, false],
        ["items[].nested", true, true],
        ["items[].nested.value", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves scalar alternatives in ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            maybe: null,
            value: "a",
          },
          {
            maybe: "x",
            value: 1,
          },
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.nullable])).toEqual([
        ["items", "array", false],
        ["items[].maybe", "string", true],
        ["items[].value", "number | string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves structured and scalar alternatives in ordinary JSON array object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            value: "a",
          },
          {
            value: {
              id: 1,
            },
          },
          {
            rows: "compact",
          },
          {
            rows: [
              {
                id: "row",
              },
            ],
          },
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.required])).toEqual([
        ["items", "array", true],
        ["items[].value", "object | string", false],
        ["items[].value.id", "number", false],
        ["items[].rows", "array | string", false],
        ["items[].rows[].id", "string", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks ordinary JSON array object fields optional when entries are not objects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify({
          items: [
            {
              nested: {
                id: "a",
              },
            },
            null,
            "loose",
          ],
        }),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].nested", false],
        ["items[].nested.id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks ordinary JSON array descendants optional when samples are not arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            items: [
              {
                id: 1,
              },
            ],
          },
          {
            items: null,
          },
          {
            items: "loose",
          },
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["items", true, false],
        ["items[].items", true, true],
        ["items[].items[].id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks ordinary JSON array descendants optional when array samples contain scalars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            items: [
              {
                id: 1,
              },
            ],
            mixed: [
              {
                value: "x",
              },
              "loose",
            ],
          },
          {
            items: ["loose"],
            mixed: [],
          },
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].items", true],
        ["items[].items[].id", false],
        ["items[].mixed", true],
        ["items[].mixed[].value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks escaped ordinary JSON array descendants optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "document.json");
      await writeFile(
        source,
        JSON.stringify([
          {
            arr: [
              {
                "a.b": 1,
              },
            ],
          },
          {},
        ]),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].arr", false],
        ["items[].arr[].a~1b", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps nullable TypeScript model references object-like", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  id: string;",
          "};",
          "type Parent = {",
          "  child?: Child | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const child = parent?.fields.find((field) => field.path === "child");

      expect(child?.objectLike).toBe(true);
      expect(child?.ref).toBe("Child");
      expect(child?.nullable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks TypeScript Record fields as object-like boundaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Policy = {",
          "  extra: Record<string, unknown>;",
          "  metadata?: Readonly<Record<string, string>> | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike, field.nullable])).toEqual([
        ["extra", true, false],
        ["extra.additionalProperties", false, false],
        ["metadata", true, true],
        ["metadata.additionalProperties", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks opaque TypeScript object fields as object-like boundaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Policy = {",
          "  metadata: object;",
          "  data?: Object;",
          "  payload: unknown;",
          "  anyValue: any;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike])).toEqual([
        ["metadata", true],
        ["data", true],
        ["payload", false],
        ["anyValue", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps parenthesized nullable TypeScript model references object-like", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  child?: (Child | null);",
          "  children?: (Array<Child> | null);",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref, field.nullable])).toEqual([
        ["child", true, "Child", true],
        ["children", true, "Child", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves TypeScript model refs across Markdown fences", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type Child = {",
          "  id: string;",
          "};",
          "```",
          "",
          "```ts",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const child = parent?.fields.find((field) => field.path === "child");

      expect(child?.objectLike).toBe(true);
      expect(child?.ref).toBe("Child");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript object aliases as model refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  id: string;",
          "};",
          "type Parent = Child;",
          "type Wrapper = {",
          "  parent: Parent;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const wrapper = graph.models.find((model) => model.id === "Wrapper");

      expect(parent?.kind).toBe("object");
      expect(parent?.fields.map((field) => field.path)).toEqual(["id"]);
      expect(wrapper?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["parent", true, "Parent"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rewrites duplicate Markdown TypeScript model refs within the same occurrence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type Child = {",
          "  a: string;",
          "};",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
          "",
          "```ts",
          "type Child = {",
          "  b: string;",
          "};",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const secondParent = graph.models.find((model) => model.id === "Parent#2");
      const secondChild = secondParent?.fields.find((field) => field.path === "child");

      expect(graph.models.map((model) => model.id)).toEqual(["Child", "Parent", "Child#2", "Parent#2"]);
      expect(secondChild?.parent).toBe("Parent#2");
      expect(secondChild?.ref).toBe("Child#2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rewrites duplicate Markdown TypeScript refs by declaration scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(
        source,
        [
          "```ts",
          "type Child = {",
          "  a: string;",
          "};",
          "```",
          "",
          "```ts",
          "type Child = {",
          "  b: string;",
          "};",
          "type Parent = {",
          "  child: Child;",
          "};",
          "```",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");
      const child = parent?.fields.find((field) => field.path === "child");

      expect(graph.models.map((model) => model.id)).toEqual(["Child", "Child#2", "Parent"]);
      expect(child?.ref).toBe("Child#2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts inherited TypeScript interface fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Base {",
          "  id: string;",
          "  settings?: {",
          "    promptRecipe?: string;",
          "  };",
          "}",
          "interface User extends Base {",
          "  name: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => field.path)).toEqual([
        "id",
        "settings",
        "settings.promptRecipe",
        "name",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts transitive inherited TypeScript interface fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Entity {",
          "  id: string;",
          "}",
          "interface Named extends Entity {",
          "  name: string;",
          "}",
          "interface User extends Named {",
          "  promptRecipe?: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => field.path)).toEqual(["id", "name", "promptRecipe"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges direct TypeScript interface declarations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Foo {",
          "  a: string;",
          "}",
          "interface Foo {",
          "  b: number;",
          "}",
          "type Parent = {",
          "  f: Foo;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const foo = graph.models.find((model) => model.id === "Foo");
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(graph.models.map((model) => model.id)).toEqual(["Foo", "Parent"]);
      expect(foo?.fields.map((field) => field.path)).toEqual(["a", "b"]);
      expect(parent?.fields.map((field) => [field.path, field.ref])).toEqual([["f", "Foo"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("inherits merged TypeScript base interface fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Base {",
          "  a: string;",
          "}",
          "interface Base {",
          "  b: string;",
          "}",
          "interface Child extends Base {",
          "  c: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const child = graph.models.find((model) => model.id === "Child");

      expect(child?.fields.map((field) => field.path)).toEqual(["a", "b", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lets TypeScript child interfaces override inherited fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "interface Base {",
          "  value?: string;",
          "  settings: {",
          "    id: string;",
          "  };",
          "}",
          "interface User extends Base {",
          "  value: string;",
          "  settings: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => [field.path, field.type, field.required])).toEqual([
        ["value", "string", true],
        ["settings", "string", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript interface fields inherited from type aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Base = {",
          "  id: string;",
          "  settings?: {",
          "    promptRecipe?: string;",
          "  };",
          "};",
          "interface User extends Base {",
          "  name: string;",
          "}",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.fields.map((field) => field.path)).toEqual([
        "id",
        "settings",
        "settings.promptRecipe",
        "name",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript intersection alias fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Base = {",
          "  id: string;",
          "  settings?: {",
          "    promptRecipe?: string;",
          "  };",
          "};",
          "type User = Base & {",
          "  name: string;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const user = graph.models.find((model) => model.id === "User");

      expect(user?.kind).toBe("object");
      expect(user?.fields.map((field) => field.path)).toEqual([
        "id",
        "settings",
        "settings.promptRecipe",
        "name",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript inline intersection property fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type User = {",
          "  config: {",
          "    promptRecipe: string;",
          "  } & {",
          "    retries: number;",
          "  };",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["config", true],
        ["config.promptRecipe", true],
        ["config.retries", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level TypeScript object union aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event =",
          "  | {",
          "      kind: \"created\";",
          "      id: string;",
          "    }",
          "  | {",
          "      kind: \"deleted\";",
          "      reason?: string;",
          "    };",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("object");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["kind", true],
        ["id", false],
        ["reason", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks top-level TypeScript object union fields optional when aliases can be scalar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(source, "type Event = { id: string } | string;\n");
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([["id", false]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable top-level TypeScript object aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(source, "type Profile = { id: string } | null;\n");
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([["id", false]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts every TypeScript nested object union variant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event = {",
          "  payload: {",
          "    kind: \"a\";",
          "    a: string;",
          "  } | {",
          "    kind: \"b\";",
          "    b: string;",
          "  };",
          "  items: Array<{",
          "    x: string;",
          "  } | {",
          "    y: string;",
          "  }>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["payload", true],
        ["payload.kind", true],
        ["payload.a", false],
        ["payload.b", false],
        ["items", true],
        ["items[].x", false],
        ["items[].y", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("merges TypeScript object union property metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event =",
          "  | {",
          "      value: string;",
          "    }",
          "  | {",
          "      value: number | null;",
          "    };",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.type, field.required, field.nullable])).toEqual([
        ["value", "string | number | null", true, true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks nested TypeScript fields optional when unions include scalar branches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event = {",
          "  payload: {",
          "    a: string;",
          "  } | string;",
          "  items: Array<{",
          "    b: string;",
          "  } | number>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["payload", true],
        ["payload.a", false],
        ["items", true],
        ["items[].b", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks TypeScript array descendants optional when parent can be scalar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Event = {",
          "  items: Array<{",
          "    b: string;",
          "  }> | string;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].b", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses AST nullish branches for TypeScript nullable metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type nullableString = string;",
          "type Foo = {",
          "  status: \"null\" | \"ok\";",
          "  value: nullableString;",
          "  maybe: string | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const foo = graph.models.find((model) => model.id === "Foo");

      expect(foo?.fields.map((field) => [field.path, field.nullable])).toEqual([
        ["status", false],
        ["value", false],
        ["maybe", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates optional TypeScript parents to inline children", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Parent = {",
          "  config?: {",
          "    id: string;",
          "  };",
          "  items?: {",
          "    value: string;",
          "  }[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["config", false],
        ["config.id", false],
        ["items", false],
        ["items[].value", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("propagates nullable TypeScript parents to inline children", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Parent = {",
          "  config: {",
          "    id: string;",
          "  } | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["config", true, true],
        ["config.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable TypeScript inline object unions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  item?: {",
          "    id: string;",
          "  } | null;",
          "  items?: {",
          "    sku: string;",
          "  }[] | null;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "item",
        "item.id",
        "items",
        "items[].sku",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable TypeScript array element object unions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items?: Array<{",
          "    id: string;",
          "  } | null>;",
          "  entries?: ({",
          "    sku: string;",
          "  } | null)[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "entries",
        "entries[].sku",
      ]);
      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", false],
        ["items[].id", false],
        ["entries", false],
        ["entries[].sku", false],
      ]);
      expect(graph.models[0]?.fields.filter((field) => field.path === "items" || field.path === "entries").map((field) => field.objectLike)).toEqual([
        true,
        true,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks top-level nullable TypeScript array element fields optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Items = Array<{",
          "  id: string;",
          "} | null>;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["items", true],
        ["items[].id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript tuple object fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  name: string;",
          "};",
          "type Cart = {",
          "  items: [{ id: string }];",
          "  children: [Child];",
          "  named: [item: { sku: string }];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const cart = graph.models.find((model) => model.id === "Cart");

      expect(cart?.fields.map((field) => [field.path, field.required, field.objectLike, field.ref ?? null])).toEqual([
        ["items", true, true, null],
        ["items[].id", true, false, null],
        ["children", true, true, "Child"],
        ["named", true, true, null],
        ["named[].sku", true, false, null],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts readonly TypeScript inline object arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items: readonly {",
          "    id: string;",
          "  }[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike])).toEqual([
        ["items", true],
        ["items[].id", false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level TypeScript array aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Profiles = Array<{",
          "  id: string;",
          "  promptRecipe?: string;",
          "} | null>;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => field.path)).toEqual([
        "items",
        "items[].id",
        "items[].promptRecipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts object branches from unioned top-level TypeScript array aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Rows = string[] | {",
          "  id: string;",
          "}[];",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.kind).toBe("array");
      expect(graph.models[0]?.fields.map((field) => [field.path, field.objectLike, field.required])).toEqual([
        ["items", true, true],
        ["items[].id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("composes duplicate TypeScript intersection properties", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type User = {",
          "  settings: {",
          "    promptRecipe: string;",
          "  };",
          "} & {",
          "  settings: {",
          "    retries: number;",
          "  };",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["settings", true],
        ["settings.promptRecipe", true],
        ["settings.retries", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps optional TypeScript intersection property descendants optional", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type User = {",
          "  settings?: {",
          "    promptRecipe: string;",
          "  };",
          "} & {",
          "  settings: {",
          "    retries: number;",
          "  };",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required])).toEqual([
        ["settings", true],
        ["settings.promptRecipe", false],
        ["settings.retries", true],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript index signatures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Headers = {",
          "  [name: string]: string;",
          "};",
          "type Registry = {",
          "  fixed: string;",
          "  [name: string]: {",
          "    promptRecipe?: string;",
          "  };",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const headers = graph.models.find((model) => model.id === "Headers");
      const registry = graph.models.find((model) => model.id === "Registry");

      expect(headers?.fields.map((field) => [field.path, field.type, field.objectLike])).toEqual([
        ["additionalProperties", "string", false],
      ]);
      expect(registry?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["fixed", true, false],
        ["additionalProperties", true, true],
        ["additionalProperties.promptRecipe", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks TypeScript union index signatures nullable when any branch is nullable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Bag =",
          "  | { [key: string]: { id: string } }",
          "  | { [key: string]: { id: string } | null };",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.nullable])).toEqual([
        ["additionalProperties", true, true],
        ["additionalProperties.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript Record value fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Model = {",
          "  settings: Record<string, {",
          "    promptRecipe: string;",
          "  }>;",
          "  readonlySettings?: Readonly<Record<string, {",
          "    id: string;",
          "  }>>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["settings", true, true],
        ["settings.additionalProperties", true, true],
        ["settings.additionalProperties.promptRecipe", true, false],
        ["readonlySettings", false, true],
        ["readonlySettings.additionalProperties", false, true],
        ["readonlySettings.additionalProperties.id", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts top-level TypeScript Record aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Headers = Record<string, {",
          "  id: string;",
          "  recipe?: string;",
          "}>;",
          "type Labels = Record<string, string>;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const headers = graph.models.find((model) => model.id === "Headers");
      const labels = graph.models.find((model) => model.id === "Labels");

      expect(headers?.kind).toBe("object");
      expect(headers?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["additionalProperties", true, true],
        ["additionalProperties.id", true, false],
        ["additionalProperties.recipe", false, false],
      ]);
      expect(labels?.kind).toBe("object");
      expect(labels?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["additionalProperties", true, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript Record value fields inside arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Rows = Array<Record<string, {",
          "  id: string;",
          "  recipe?: string;",
          "}>>;",
          "type Model = {",
          "  rows: Array<Record<string, {",
          "    id: string;",
          "  }>>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const rows = graph.models.find((model) => model.id === "Rows");
      const model = graph.models.find((candidate) => candidate.id === "Model");

      expect(rows?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["items", true, true],
        ["items[].additionalProperties", true, true],
        ["items[].additionalProperties.id", true, false],
        ["items[].additionalProperties.recipe", false, false],
      ]);
      expect(model?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["rows", true, true],
        ["rows[].additionalProperties", true, true],
        ["rows[].additionalProperties.id", true, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript Record value fields inside union branches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Model =",
          "  | { settings: Record<string, { id: string }> }",
          "  | { settings: Record<string, { name: string }> };",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((field) => [field.path, field.required, field.objectLike])).toEqual([
        ["settings", true, true],
        ["settings.additionalProperties", true, true],
        ["settings.additionalProperties.id", false, false],
        ["settings.additionalProperties.name", false, false],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts nullable top-level TypeScript array aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = {",
          "  id: string;",
          "};",
          "type Children = Child[] | null;",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const children = graph.models.find((model) => model.id === "Children");

      expect(children?.kind).toBe("array");
      expect(children?.fields.map((field) => [field.path, field.nullable, field.objectLike, field.ref])).toEqual([
        ["items", true, true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript array aliases as model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Children = Child[];",
          "type Parent = {",
          "  children: Children;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Children"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses collision-free artifact filename parts", () => {
    expect(pathToFileNamePart("a/b")).not.toBe(pathToFileNamePart("a_b"));
    expect(pathToFileNamePart("a".repeat(300)).length).toBeLessThan(80);
  });

  test("rejects duplicate field reviews", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("promptRecipe", "promptRecipe", "string", false)],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [
      reviewWithoutFinalPath("promptRecipe", "systemPromptVariant"),
      reviewWithoutFinalPath("promptRecipe", "promptVariant"),
    ]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain("Duplicate review for extracted field.");
  });

  test("refuses unsafe non-empty generated output directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      await writeFile(source, ["```ts", "type ModelProfilePolicy = {", "  promptRecipe?: string;", "};", "```"].join("\n"));
      const graph = await extractGraph(source);
      const unsafe = join(dir, "unsafe");
      await mkdir(unsafe);
      await writeFile(join(unsafe, "keep.txt"), "do not delete\n");

      await expect(writeDeterministicReviews(graph, unsafe)).rejects.toThrow("refusing to clear");
      await expect(writeReviewJobs(graph, unsafe)).rejects.toThrow("refusing to clear");
      await expect(readFile(join(unsafe, "keep.txt"), "utf8")).resolves.toBe("do not delete\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports manual run directories without final graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "proposal.md");
      const runDir = join(dir, "run");
      await mkdir(runDir);
      await writeFile(source, ["```ts", "type ModelProfilePolicy = {", "  promptRecipe?: string;", "};", "```"].join("\n"));
      const graph = await extractGraph(source);
      await writeFile(join(runDir, "graph.iteration-1.json"), JSON.stringify(graph, null, 2));
      const reviews = await writeDeterministicReviews(graph, join(runDir, "reviews.iteration-1"));
      const aggregate = aggregateReviews(graph, reviews);
      await writeFile(join(runDir, "aggregate.iteration-1.json"), JSON.stringify(aggregate, null, 2));

      await execFileAsync(tsxBin(), ["src/cli.ts", "report", "--run", runDir, "--out", join(runDir, "final-report.md")], {
        cwd: process.cwd(),
      });

      const report = await readFile(join(runDir, "final-report.md"), "utf8");
      expect(report).toContain("Schemator Data Model Review");
      expect(report).toContain("| `promptRecipe` | `string` | no | no |");
      expect(report).not.toContain("| `systemPromptVariant` | `string` | no | no |");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("replays manual run aggregate history when final graph is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const runDir = join(dir, "run");
      await mkdir(runDir);
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.json", revision: null },
        models: [
          {
            id: "JsonSchema",
            kind: "object",
            source: sourceSpan(),
            fields: [
              field("config", "config", "object", true),
              field("config.token", "token", "string", false),
            ],
          },
        ],
      };
      const firstAggregate: AggregateReview = {
        schemaVersion: 1,
        ok: true,
        summary: {
          totalFields: 2,
          keep: 1,
          rename: 1,
          merge: 0,
          derive: 0,
          move: 0,
          defer: 0,
          remove: 0,
          opaque: 0,
        },
        findings: [],
        decisions: [
          review("config", "settings"),
          {
            ...review("config.token", "config.token"),
            decision: "keep",
            finalName: "token",
          },
        ],
      };
      const secondAggregate: AggregateReview = {
        schemaVersion: 1,
        ok: true,
        summary: {
          totalFields: 2,
          keep: 1,
          rename: 0,
          merge: 0,
          derive: 0,
          move: 0,
          defer: 0,
          remove: 1,
          opaque: 0,
        },
        findings: [],
        decisions: [
          {
            ...review("settings", "settings"),
            decision: "keep",
            finalName: "settings",
          },
          {
            ...review("settings.token", "settings.token"),
            decision: "remove",
            finalName: "token",
          },
        ],
      };
      await writeFile(join(runDir, "graph.iteration-1.json"), JSON.stringify(graph, null, 2));
      await writeFile(join(runDir, "aggregate.iteration-1.json"), JSON.stringify(firstAggregate, null, 2));
      await writeFile(join(runDir, "aggregate.iteration-2.json"), JSON.stringify(secondAggregate, null, 2));
      await writeFile(join(runDir, "run-summary.json"), JSON.stringify({ schemaVersion: 1, stableIteration: 2 }, null, 2));

      await execFileAsync(tsxBin(), ["src/cli.ts", "report", "--run", runDir, "--out", join(runDir, "final-report.md")], {
        cwd: process.cwd(),
      });
      const report = await readFile(join(runDir, "final-report.md"), "utf8");

      expect(report).toContain("| `settings` | `object` | yes | yes |");
      expect(report).not.toContain("| `settings.token` | `string` | yes | no |");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the converged iteration for run directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const reportPath = join(runDir, "report.md");
      const fakeCodex = join(dir, "fake-codex.js");
      await writeFakeModelReviewer(fakeCodex);
      await writeFile(source, "type T = { promptRecipe: string };\n");

      await execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--out", runDir, "--codex-command", fakeCodex], {
        cwd: process.cwd(),
      });
      await execFileAsync(tsxBin(), ["src/cli.ts", "report", "--run", runDir, "--out", reportPath], {
        cwd: process.cwd(),
      });

      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("- Applied changes: 1");
      expect(report).toContain("| 1 | `T` | `promptRecipe` | rename | `systemPromptVariant` |");
      expect(report).toContain("| `systemPromptVariant` | `string` | yes | no |");
      expect(report).not.toContain("| `T` | `systemPromptVariant` | keep |");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the current run summary when output directories are reused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const reportPath = join(runDir, "report.md");
      await writeFile(source, "type T = { recipe: string };\n");

      await execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--out", runDir, "--strategy", "local"], {
        cwd: process.cwd(),
      });
      await writeFile(source, "type T = { id: string };\n");
      await execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--out", runDir, "--strategy", "local"], {
        cwd: process.cwd(),
      });
      await execFileAsync(tsxBin(), ["src/cli.ts", "report", "--run", runDir, "--out", reportPath], {
        cwd: process.cwd(),
      });

      const report = await readFile(reportPath, "utf8");
      expect(report).toContain("- Applied changes: 0");
      expect(report).toContain("| `id` | `string` | yes | no |");
      expect(report).not.toContain("variant");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("diff reports initial and final run graph changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const diffPath = join(runDir, "diff.md");
      const fakeCodex = join(dir, "fake-codex.js");
      await writeFakeModelReviewer(fakeCodex);
      await writeFile(source, "type T = { promptRecipe: string };\n");

      await execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--out", runDir, "--codex-command", fakeCodex], {
        cwd: process.cwd(),
      });
      await execFileAsync(tsxBin(), ["src/cli.ts", "diff", "--run", runDir, "--out", diffPath], {
        cwd: process.cwd(),
      });

      const diff = await readFile(diffPath, "utf8");
      expect(diff).toContain("- Initial fields: 1");
      expect(diff).toContain("- Final fields: 1");
      expect(diff).toContain("| `T` | `promptRecipe` | `string` |");
      expect(diff).toContain("| `T` | `systemPromptVariant` | `string` |");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run copies project context and records its hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const context = join(dir, "project-context.md");
      const runDir = join(dir, "run");
      const contextText = [
        "Model harness profiles are user-facing declarative configuration.",
        "Third parties can customize how models are called.",
      ].join("\n");
      await writeFile(source, "type T = { id: string };\n");
      await writeFile(context, contextText);

      await execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--context", context, "--out", runDir, "--strategy", "local"], {
        cwd: process.cwd(),
      });

      const copiedContext = await readFile(join(runDir, "project-context.md"), "utf8");
      const summary = JSON.parse(await readFile(join(runDir, "run-summary.json"), "utf8")) as Record<string, unknown>;
      const jobFiles = await readdirFileNames(join(runDir, "jobs.iteration-1"));
      const prompt = await readFile(join(runDir, "jobs.iteration-1", jobFiles[0] ?? ""), "utf8");

      expect(copiedContext).toBe(contextText);
      expect(summary["projectContext"]).toBe("project-context.md");
      expect(summary["projectContextSha256"]).toBe(sha256(contextText));
      expect(prompt).toContain("## Project And Task Context");
      expect(prompt).toContain("Third parties can customize how models are called.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("create-jobs fails clearly when project context cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const graphPath = join(dir, "graph.json");
      const missingContext = join(dir, "missing.md");
      await writeFile(graphPath, JSON.stringify(graphWithOneField("Policy", "id", "id"), null, 2));

      await expect(
        execFileAsync(tsxBin(), [
          "src/cli.ts",
          "create-jobs",
          "--graph",
          graphPath,
          "--context",
          missingContext,
          "--out",
          join(dir, "jobs"),
        ], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("unable to read --context file"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("apply refuses invalid aggregates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const graphPath = join(dir, "graph.json");
      const aggregatePath = join(dir, "aggregate.json");
      const outPath = join(dir, "patch.md");
      const graph: ModelGraph = {
        schemaVersion: 1,
        source: { path: "schema.json", revision: null },
        models: [
          {
            id: "JsonSchema",
            kind: "object",
            source: sourceSpan(),
            fields: [field("promptRecipe", "promptRecipe", "string", false)],
          },
        ],
      };
      const aggregate: AggregateReview = {
        schemaVersion: 1,
        ok: false,
        summary: {
          totalFields: 0,
          keep: 0,
          rename: 0,
          merge: 0,
          derive: 0,
          move: 0,
          defer: 0,
          remove: 0,
          opaque: 0,
        },
        decisions: [],
        findings: [
          {
            severity: "error",
            model: "JsonSchema",
            fieldPath: "promptRecipe",
            message: "Extracted field is missing a review.",
          },
        ],
      };
      await writeFile(graphPath, JSON.stringify(graph, null, 2));
      await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2));

      await expect(
        execFileAsync(tsxBin(), ["src/cli.ts", "apply", "--graph", graphPath, "--aggregate", aggregatePath, "--out", outPath], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({ code: 2 });
      await expect(readFile(outPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run fails when max iterations stop before convergence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const fakeCodex = join(dir, "fake-codex.js");
      await writeFakeModelReviewer(fakeCodex);
      await writeFile(source, ["type ModelProfilePolicy = {", "  promptRecipe?: string;", "};"].join("\n"));

      await expect(
        execFileAsync(tsxBin(), [
          "src/cli.ts",
          "run",
          "--source",
          source,
          "--out",
          runDir,
          "--max-iterations",
          "1",
          "--codex-command",
          fakeCodex,
        ], {
          cwd: process.cwd(),
        }),
      ).rejects.toMatchObject({ code: 2 });
      await expect(readFile(join(runDir, "run-summary.json"), "utf8")).resolves.toContain('"stable": false');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run converges when a reviewer tries to rename an accepted name again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const fakeCodex = join(dir, "oscillating-codex.js");
      await writeOscillatingRenameReviewer(fakeCodex);
      await writeFile(source, "type Policy = { promptRecipe?: string };\n");

      await execFileAsync(tsxBin(), [
        "src/cli.ts",
        "run",
        "--source",
        source,
        "--out",
        runDir,
        "--max-iterations",
        "3",
        "--codex-command",
        fakeCodex,
      ], {
        cwd: process.cwd(),
      });

      const summary = JSON.parse(await readFile(join(runDir, "run-summary.json"), "utf8")) as { stable: boolean; stableIteration: number };
      const finalGraph = JSON.parse(await readFile(join(runDir, "graph.final.json"), "utf8")) as ModelGraph;
      const secondReduction = JSON.parse(await readFile(join(runDir, "reduction.iteration-2.json"), "utf8")) as {
        changed: boolean;
        skipped: Array<{ reason: string; fieldPath: string }>;
      };
      const secondPromptFiles = await readdirFileNames(join(runDir, "jobs.iteration-2"));
      const secondPrompt = await readFile(join(runDir, "jobs.iteration-2", secondPromptFiles[0] ?? ""), "utf8");

      expect(summary.stable).toBe(true);
      expect(summary.stableIteration).toBe(2);
      expect(finalGraph.models[0]?.fields.map((item) => item.path)).toEqual(["systemPromptVariant"]);
      expect(secondReduction.changed).toBe(false);
      expect(secondReduction.skipped).toContainEqual({
        decision: "rename",
        model: "Policy",
        fieldPath: "systemPromptVariant",
        reason: "frozen-rename",
      });
      expect(secondPrompt).toContain("## Accepted Run Decisions");
      expect(secondPrompt).toContain("`Policy.promptRecipe` was renamed to `systemPromptVariant`");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run preserves frozen child renames after parent renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const fakeCodex = join(dir, "parent-rebase-codex.js");
      await writeParentRebaseReviewer(fakeCodex);
      await writeFile(source, "type Policy = { config: { recipe?: string } };\n");

      await execFileAsync(tsxBin(), [
        "src/cli.ts",
        "run",
        "--source",
        source,
        "--out",
        runDir,
        "--max-iterations",
        "4",
        "--codex-command",
        fakeCodex,
      ], {
        cwd: process.cwd(),
      });

      const summary = JSON.parse(await readFile(join(runDir, "run-summary.json"), "utf8")) as { stable: boolean; stableIteration: number };
      const finalGraph = JSON.parse(await readFile(join(runDir, "graph.final.json"), "utf8")) as ModelGraph;
      const thirdReduction = JSON.parse(await readFile(join(runDir, "reduction.iteration-3.json"), "utf8")) as {
        changed: boolean;
        skipped: Array<{ reason: string; fieldPath: string }>;
      };
      const thirdPromptFiles = await readdirFileNames(join(runDir, "jobs.iteration-3"));
      const thirdPrompts = await Promise.all(
        thirdPromptFiles.map((file) => readFile(join(runDir, "jobs.iteration-3", file), "utf8")),
      );

      expect(summary.stable).toBe(true);
      expect(summary.stableIteration).toBe(3);
      expect(finalGraph.models[0]?.fields.map((item) => item.path)).toEqual(["settings", "settings.variant"]);
      expect(thirdReduction.changed).toBe(false);
      expect(thirdReduction.skipped).toContainEqual({
        decision: "rename",
        model: "Policy",
        fieldPath: "settings.variant",
        reason: "frozen-rename",
      });
      expect(thirdPrompts.join("\n")).toContain("`Policy.config.recipe` was renamed to `settings.variant`");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("run final report uses the converged aggregate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      const runDir = join(dir, "run");
      const fakeCodex = join(dir, "fake-codex.js");
      await writeFakeModelReviewer(fakeCodex);
      await writeFile(source, ["type ModelProfilePolicy = {", "  promptRecipe?: string;", "};"].join("\n"));

      await execFileAsync(tsxBin(), ["src/cli.ts", "run", "--source", source, "--out", runDir, "--codex-command", fakeCodex], {
        cwd: process.cwd(),
      });
      const report = await readFile(join(runDir, "final-report.md"), "utf8");

      expect(report).toContain("- Applied changes: 1");
      expect(report).toContain("| 1 | `ModelProfilePolicy` | `promptRecipe` | rename | `systemPromptVariant` |");
      expect(report).toContain("| `systemPromptVariant` | `string` | no | no |");
      expect(report).not.toContain("| `ModelProfilePolicy` | `systemPromptVariant` | keep |");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips simplification rename collisions", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("recipe", "recipe", "string", false),
            field("variant", "variant", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 1,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        reviewWithoutFinalPath("recipe", "variant"),
        {
          ...reviewWithoutFinalPath("variant", "variant"),
          decision: "keep",
        },
      ],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((field) => field.path)).toEqual([
      "recipe",
      "variant",
    ]);
    expect(hasGraphChange(graph, aggregate)).toBe(false);
  });

  test("does not let frozen rename proposals change the graph", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("systemPromptVariant", "systemPromptVariant", "string", false)],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("systemPromptVariant", "promptRecipe")],
    };
    const reduction = reduceAggregateGraph(graph, aggregate, {
      frozenRenamePaths: new Set([graphDecisionKey("JsonSchema", "systemPromptVariant")]),
    });

    expect(reduction.changed).toBe(false);
    expect(reduction.graph.models[0]?.fields.map((field) => field.path)).toEqual(["systemPromptVariant"]);
    expect(reduction.skipped).toContainEqual({
      decision: "rename",
      model: "JsonSchema",
      fieldPath: "systemPromptVariant",
      reason: "frozen-rename",
    });
  });

  test("keeps simplification rename collisions non-fatal during aggregation", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("recipe", "recipe", "string", false),
            field("variant", "variant", "string", false),
          ],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [
      reviewWithoutFinalPath("recipe", "variant"),
      {
        ...reviewWithoutFinalPath("variant", "variant"),
        decision: "keep",
      },
    ]);

    expect(aggregate.ok).toBe(true);
    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((field) => field.path)).toEqual([
      "recipe",
      "variant",
    ]);
  });

  test("keeps merge and move decisions as manual structural proposals", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("source", "source", "string", false),
            field("target", "target", "string", false),
          ],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("source", "target"),
        decision: "merge",
      },
      {
        ...reviewWithoutFinalPath("target", "renamedTarget"),
        decision: "move",
      },
    ]);

    expect(aggregate.ok).toBe(true);
    expect(aggregate.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        "Decision merge is a manual structural proposal and is not auto-applied by the v1 graph reducer.",
        "Decision move is a manual structural proposal and is not auto-applied by the v1 graph reducer.",
      ]),
    );
    expect(aggregate.findings.every((finding) => finding.severity === "warning")).toBe(true);
  });

  test("normalizes rename decisions with overqualified final paths", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("config.recipe", "recipe", "string", false)],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [review("config.recipe", "other.variant")]);

    expect(aggregate.ok).toBe(true);
    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((field) => field.path)).toEqual([
      "config.variant",
    ]);
  });

  test("uses finalName when rename finalPath and finalName disagree", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("config.recipe", "recipe", "string", false)],
        },
      ],
    };
    const mismatchedReview = {
      ...review("config.recipe", "config.variant"),
      finalName: "preset",
    };
    const aggregate = aggregateReviews(graph, [mismatchedReview]);

    expect(aggregate.ok).toBe(true);
    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((field) => field.path)).toEqual([
      "config.preset",
    ]);
  });

  test("keeps parent removal conflicts as manual proposals", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.id", "id", "string", false),
          ],
        },
      ],
    };

    const aggregate = aggregateReviews(graph, [
      {
        ...reviewWithoutFinalPath("config", "config"),
        decision: "remove",
        simplestChoice: "remove",
      },
      {
        ...reviewWithoutFinalPath("config.id", "id"),
        decision: "keep",
      },
    ]);

    expect(aggregate.ok).toBe(true);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Parent removal conflicts with descendant review decision and is not auto-applied by the v1 graph reducer.",
    );
    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((field) => field.path)).toEqual([
      "config",
      "config.id",
    ]);
  });

  test("rejects low-confidence simplifications before reduction", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [field("promptRecipe", "promptRecipe", "string", false)],
        },
      ],
    };
    const lowConfidenceRename = {
      ...reviewWithoutFinalPath("promptRecipe", "systemPromptVariant"),
      confidence: "low" as const,
    };
    const aggregate = aggregateReviews(graph, [lowConfidenceRename]);

    expect(aggregate.ok).toBe(false);
    expect(aggregate.findings.map((finding) => finding.message)).toContain(
      "Low-confidence simplification decisions require focused follow-up before reduction.",
    );
    expect(applyAggregateToGraph(graph, { ...aggregate, ok: true }).models[0]?.fields[0]?.path).toBe(
      "promptRecipe",
    );
  });

  test("does not treat no-op rename reviews as simplifications", () => {
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        review("promptRecipe", "promptRecipe"),
      ],
    };

    expect(hasSimplification(aggregate)).toBe(false);
  });

  test("composes parent and child renames", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "{ recipe: string }", true),
            field("config.recipe", "recipe", "string", false),
            field("items", "items", "{ recipe: string }[]", true),
            field("items[].recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 4,
        keep: 0,
        rename: 4,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        review("config", "settings"),
        review("config.recipe", "config.variant"),
        review("items", "entries"),
        review("items[].recipe", "items[].variant"),
      ],
    };

    const fields = applyAggregateToGraph(graph, aggregate).models[0]?.fields ?? [];

    expect(fields.map((item) => item.path)).toEqual([
      "settings",
      "settings.variant",
      "entries",
      "entries[].variant",
    ]);
    expect(fields.map((item) => [item.path, item.type])).toEqual([
      ["settings", "{ variant: string }"],
      ["settings.variant", "string"],
      ["entries", "{ variant: string }[]"],
      ["entries[].variant", "string"],
    ]);
  });

  test("records composed final paths for nested applied renames", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "{ recipe: string }", true),
            field("config.recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [review("config", "settings"), review("config.recipe", "config.variant")],
    };

    const reduction = reduceAggregateGraph(graph, aggregate);

    expect(reduction.applied).toContainEqual({
      decision: "rename",
      model: "JsonSchema",
      fieldPath: "config.recipe",
      finalPath: "settings.variant",
    });
  });

  test("records actual final paths for chained applied renames", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("a", "a", "string", false),
            field("b", "b", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [review("b", "c"), review("a", "b")],
    };

    const reduction = reduceAggregateGraph(graph, aggregate);

    expect(reduction.graph.models[0]?.fields.map((item) => item.path)).toEqual(["b", "c"]);
    expect(reduction.applied).toContainEqual({
      decision: "rename",
      model: "JsonSchema",
      fieldPath: "a",
      finalPath: "b",
    });
  });

  test("rewrites only direct child names in parent type text", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "{ recipe: string; nested: { recipe: string } }", true),
            field("config.recipe", "recipe", "string", false),
            field("config.nested", "nested", "{ recipe: string }", true),
            field("config.nested.recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 4,
        keep: 3,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        review("config.recipe", "config.variant"),
      ],
    };

    const fields = applyAggregateToGraph(graph, aggregate).models[0]?.fields ?? [];

    expect(fields.map((item) => [item.path, item.type])).toEqual([
      ["config", "{ variant: string; nested: { recipe: string } }"],
      ["config.variant", "string"],
      ["config.nested", "{ recipe: string }"],
      ["config.nested.recipe", "string"],
    ]);
  });

  test("preserves escaped field names when applying unrelated renames", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("a~1b", "a.b", "number", false),
            field("promptRecipe", "promptRecipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 1,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        {
          ...reviewWithoutFinalPath("a~1b", "a.b"),
          decision: "keep",
        },
        reviewWithoutFinalPath("promptRecipe", "systemPromptVariant"),
      ],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((item) => [item.path, item.name])).toEqual([
      ["a~1b", "a.b"],
      ["systemPromptVariant", "systemPromptVariant"],
    ]);
  });

  test("preserves unescaped field names when exact renames use escaped final paths", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("a~1b", "a.b", "number", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        {
          ...review("a~1b", "c~1d"),
          finalName: "c.d",
        },
      ],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((item) => [item.path, item.name])).toEqual([
      ["c~1d", "c.d"],
    ]);
  });

  test("escapes finalName when rename review omits finalPath", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("a~1b", "a.b", "number", false),
          ],
        },
      ],
    };
    const aggregate = aggregateReviews(graph, [reviewWithoutFinalPath("a~1b", "c.d")]);

    expect(aggregate.ok).toBe(true);
    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((item) => [item.path, item.name])).toEqual([
      ["c~1d", "c.d"],
    ]);
  });

  test("reports composed nested rename paths", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        review("config", "settings"),
        review("config.recipe", "config.variant"),
      ],
    };
    const simplified = applyAggregateToGraph(graph, aggregate);
    const report = renderReport(graph, aggregate, simplified);

    expect(report).toContain("| `JsonSchema` | `config.recipe` | rename | `settings.variant` |");
    expect(report).toContain("| `settings.variant` | `string` | yes | no |");
  });

  test("run reports separate manual structural proposals", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("source", "source", "string", false),
            field("target", "target", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 1,
        rename: 0,
        merge: 1,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [
        {
          ...reviewWithoutFinalPath("source", "target"),
          decision: "merge",
          finalPath: "target",
          rationale: "These fields should be reviewed as one concept.",
        },
        {
          ...reviewWithoutFinalPath("target", "target"),
          decision: "keep",
          finalName: "target",
        },
      ],
    };

    const report = renderRunReport({
      initialGraph: graph,
      finalGraph: graph,
      aggregates: [aggregate],
      reductions: [
        {
          changed: false,
          applied: [],
          skipped: [{ decision: "merge", model: "JsonSchema", fieldPath: "source", reason: "manual" }],
        },
      ],
      stableIteration: 1,
      stable: true,
    });

    expect(report).toContain("## Manual Structural Proposals");
    expect(report).toContain("| 1 | `JsonSchema` | `source` | merge | `target` |");
    expect(report).toContain("These fields should be reviewed as one concept.");
  });

  test("run report flags generic consistency warnings", () => {
    const initialGraph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "{ token: string; reasoningMode: string; reasoningModeDefault: string }", true),
            field("config.token", "token", "string", false),
            field("config.reasoningMode", "reasoningMode", "string", false),
            field("config.reasoningModeDefault", "reasoningModeDefault", "string", false),
          ],
        },
      ],
    };
    const finalGraph: ModelGraph = {
      ...initialGraph,
      models: [
        {
          ...initialGraph.models[0]!,
          fields: [
            field("config", "config", "{ token: string; reasoningMode: string; reasoningModeDefault: string }", true),
            field("config.reasoningMode", "reasoningMode", "string", false),
            field("config.reasoningModeDefault", "reasoningModeDefault", "string", false),
          ],
        },
      ],
    };

    const report = renderRunReport({
      initialGraph,
      finalGraph,
      aggregates: [],
      reductions: [
        {
          changed: true,
          applied: [{ decision: "remove", model: "JsonSchema", fieldPath: "config.token" }],
          skipped: [],
        },
      ],
      stableIteration: 1,
      stable: false,
    });

    expect(report).toContain("Possible naming drift:");
    expect(report).toContain("reasoningMode");
    expect(report).toContain("Removed/deferred child `JsonSchema.config.token` still appears in parent type text");
  });

  test("reports full paths when non-rename reviews omit finalPath", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.token", "token", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 0,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 1,
        opaque: 1,
      },
      findings: [],
      decisions: [
        {
          ...reviewWithoutFinalPath("config", "config"),
          decision: "opaque",
          ownerBoundary: "Config owner.",
        },
        {
          ...reviewWithoutFinalPath("config.token", "token"),
          decision: "remove",
        },
      ],
    };
    const report = renderReport(graph, aggregate, graph);

    expect(report).toContain("| `JsonSchema` | `config.token` | remove | `config.token` |");
    expect(report).not.toContain("| `JsonSchema` | `config.token` | remove | `token` |");
  });

  test("composes nested rename paths in patch plans", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("config", "settings"), reviewWithoutFinalPath("config.recipe", "variant")],
    };

    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("- Final path: settings.variant");
    expect(plan).not.toContain("- Final path: config.variant");
  });

  test("composes parent renames for non-rename patch-plan rows", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.token", "token", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 1,
        opaque: 0,
      },
      findings: [],
      decisions: [
        reviewWithoutFinalPath("config", "settings"),
        {
          ...reviewWithoutFinalPath("config.token", "token"),
          decision: "remove",
        },
      ],
    };

    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("## JsonSchema.config.token");
    expect(plan).toContain("- Final path: settings.token");
    expect(plan).not.toContain("- Final path: token");
  });

  test("uses source-neutral rename text in patch plans", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            {
              ...field("promptRecipe", "promptRecipe", "string", false),
              required: false,
            },
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("promptRecipe", "systemPromptVariant")],
    };
    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("- From: `promptRecipe`");
    expect(plan).toContain("- To: `systemPromptVariant`");
    expect(plan).not.toContain("promptRecipe?:");
  });

  test("uses source field names for escaped rename text in patch plans", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            {
              ...field("a~1b", "a.b", "number", false),
              required: false,
            },
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 1,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("a~1b", "c.d")],
    };
    const plan = renderPatchPlan(graph, aggregate);

    expect(plan).toContain("- From: `a.b`");
    expect(plan).toContain("- To: `c.d`");
    expect(plan).not.toContain("- From: `a~1b`");
  });

  test("uses finalName when rename review omits finalPath", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("config", "config", "object", true),
            field("config.recipe", "recipe", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 2,
        keep: 0,
        rename: 2,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 0,
        opaque: 0,
      },
      findings: [],
      decisions: [reviewWithoutFinalPath("config", "settings"), reviewWithoutFinalPath("config.recipe", "variant")],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields.map((item) => item.path)).toEqual([
      "settings",
      "settings.variant",
    ]);
  });

  test("removes array descendants with removed parent", () => {
    const graph: ModelGraph = {
      schemaVersion: 1,
      source: { path: "schema.json", revision: null },
      models: [
        {
          id: "JsonSchema",
          kind: "object",
          source: sourceSpan(),
          fields: [
            field("items", "items", "array", true),
            field("items[].id", "id", "string", false),
          ],
        },
      ],
    };
    const aggregate: AggregateReview = {
      schemaVersion: 1,
      ok: true,
      summary: {
        totalFields: 1,
        keep: 0,
        rename: 0,
        merge: 0,
        derive: 0,
        move: 0,
        defer: 0,
        remove: 1,
        opaque: 0,
      },
      findings: [],
      decisions: [
        {
          ...reviewWithoutFinalPath("items", "items"),
          decision: "remove",
          simplestChoice: "remove",
        },
      ],
    };

    expect(applyAggregateToGraph(graph, aggregate).models[0]?.fields).toEqual([]);
  });

  test("extracts TypeScript inline object arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items?: {",
          "    id: string;",
          "    recipe?: string;",
          "  }[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((item) => item.path)).toEqual([
        "items",
        "items[].id",
        "items[].recipe",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("extracts TypeScript generic inline object arrays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Cart = {",
          "  items?: Array<{",
          "    id: string;",
          "    recipe?: string;",
          "  }>;",
          "  readonlyItems?: ReadonlyArray<{",
          "    sku: string;",
          "  }>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);

      expect(graph.models[0]?.fields.map((item) => item.path)).toEqual([
        "items",
        "items[].id",
        "items[].recipe",
        "readonlyItems",
        "readonlyItems[].sku",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript generic array model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  children: Array<Child>;",
          "  readonlyChildren: ReadonlyArray<Child>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Child"],
        ["readonlyChildren", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript unioned array model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Other = { name: string };",
          "type Parent = {",
          "  children: (Child | Other)[];",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes spaced TypeScript generic array model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  children: Array< Child >;",
          "  readonlyChildren: ReadonlyArray< Child >;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["children", true, "Child"],
        ["readonlyChildren", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript generic object model references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Box<T> = {",
          "  value: T;",
          "};",
          "type Parent = {",
          "  box: Box<string>;",
          "  boxes: Array<Box<string>>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["box", true, "Box"],
        ["boxes", true, "Box"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript generic object refs with union arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Box<T> = {",
          "  value: T;",
          "};",
          "type Parent = {",
          "  box: Box<string | number>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["box", true, "Box"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recognizes TypeScript readonly utility object references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemator-"));
    try {
      const source = join(dir, "schema.ts");
      await writeFile(
        source,
        [
          "type Child = { id: string };",
          "type Parent = {",
          "  child: Readonly<Child>;",
          "};",
        ].join("\n"),
      );
      const graph = await extractGraph(source);
      const parent = graph.models.find((model) => model.id === "Parent");

      expect(parent?.fields.map((field) => [field.path, field.objectLike, field.ref])).toEqual([
        ["child", true, "Child"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function sourceSpan() {
  return {
    path: "schema.json",
    span: { startLine: 1, endLine: 1 },
  };
}

function field(path: string, name: string, type: string, objectLike: boolean) {
  return {
    path,
    name,
    type,
    required: true,
    nullable: false,
    parent: "JsonSchema",
    objectLike,
    source: sourceSpan(),
  };
}

function review(fieldPath: string, finalPath: string) {
  return {
    schemaVersion: 1 as const,
    model: "JsonSchema",
    fieldPath,
    decision: "rename" as const,
    finalName: finalPath.split(".").at(-1)?.replace(/\[\]$/, "") ?? finalPath,
    finalPath,
    finalType: "string",
    required: true,
    rationale: "test",
    alternatives: [finalPath],
    simplestChoice: finalPath,
    confidence: "high" as const,
    questions: [],
  };
}

function reviewWithoutFinalPath(fieldPath: string, finalName: string) {
  return {
    schemaVersion: 1 as const,
    model: "JsonSchema",
    fieldPath,
    decision: "rename" as const,
    finalName,
    finalType: "string",
    required: true,
    rationale: "test",
    alternatives: [finalName],
    simplestChoice: finalName,
    confidence: "high" as const,
    questions: [],
  };
}

function graphWithOneField(modelId: string, path: string, name: string): ModelGraph {
  return {
    schemaVersion: 1,
    source: { path: "schema.ts", revision: null },
    models: [
      {
        id: modelId,
        kind: "object",
        source: { path: "schema.ts", span: { startLine: 1, endLine: 3 } },
        fields: [
          {
            path,
            name,
            type: "string",
            required: false,
            nullable: false,
            parent: modelId,
            objectLike: false,
            source: { path: "schema.ts", span: { startLine: 2, endLine: 2 } },
          },
        ],
      },
    ],
  };
}

function fieldForModel(modelId: string, path: string, name: string) {
  return {
    path,
    name,
    type: "string",
    required: false,
    nullable: false,
    parent: modelId,
    objectLike: false,
    source: { path: "schema.ts", span: { startLine: 2, endLine: 2 } },
  };
}

function promptForGraph(graph: ModelGraph): string {
  const model = graph.models[0];
  const field = model?.fields[0];
  if (!model || !field) {
    throw new Error("test graph has no field");
  }
  return renderFieldPrompt(graph, model, field);
}

async function writeFakeModelReviewer(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  const model = /- Model: `([^`]+)`/.exec(prompt)?.[1] ?? 'Unknown';",
      "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
      "  const fieldName = /- Field name: `([^`]+)`/.exec(prompt)?.[1] ?? fieldPath;",
      "  const shouldRename = fieldName === 'promptRecipe';",
      "  const finalName = shouldRename ? 'systemPromptVariant' : fieldName;",
      "  console.log(JSON.stringify({",
      "    schemaVersion: 1,",
      "    model,",
      "    fieldPath,",
      "    decision: shouldRename ? 'rename' : 'keep',",
      "    finalName,",
      "    finalPath: null,",
      "    finalType: 'string',",
      "    required: false,",
      "    rationale: shouldRename ? 'Model reviewer rejects a metaphorical prompt-construction name.' : 'Model reviewer keeps intentional declarative vocabulary.',",
      "    alternatives: [finalName, 'remove'],",
      "    simplestChoice: finalName,",
      "    confidence: 'high',",
      "    questions: [],",
      "    ownerBoundary: null",
      "  }));",
      "});",
    ].join("\n"),
  );
  await chmod(path, 0o755);
}

async function writeOscillatingRenameReviewer(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  const model = /- Model: `([^`]+)`/.exec(prompt)?.[1] ?? 'Unknown';",
      "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
      "  const fieldName = /- Field name: `([^`]+)`/.exec(prompt)?.[1] ?? fieldPath;",
      "  const finalName = fieldName === 'promptRecipe' ? 'systemPromptVariant' : 'promptRecipe';",
      "  console.log(JSON.stringify({",
      "    schemaVersion: 1,",
      "    model,",
      "    fieldPath,",
      "    decision: 'rename',",
      "    finalName,",
      "    finalPath: null,",
      "    finalType: 'string',",
      "    required: false,",
      "    rationale: 'Fake reviewer intentionally alternates between two names.',",
      "    alternatives: [finalName, fieldName],",
      "    simplestChoice: finalName,",
      "    confidence: 'high',",
      "    questions: [],",
      "    ownerBoundary: null",
      "  }));",
      "});",
    ].join("\n"),
  );
  await chmod(path, 0o755);
}

async function writeParentRebaseReviewer(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      "  const model = /- Model: `([^`]+)`/.exec(prompt)?.[1] ?? 'Unknown';",
      "  const fieldPath = /- Field path: `([^`]+)`/.exec(prompt)?.[1] ?? 'unknown';",
      "  const fieldName = /- Field name: `([^`]+)`/.exec(prompt)?.[1] ?? fieldPath;",
      "  const hasChildRename = prompt.includes('`Policy.config.recipe` was renamed to `config.variant`') || prompt.includes('`Policy.config.recipe` was renamed to `settings.variant`');",
      "  const shouldRenameChildFirst = fieldPath === 'config.recipe' && !prompt.includes('## Accepted Run Decisions');",
      "  const shouldRenameParentSecond = fieldPath === 'config' && hasChildRename;",
      "  const shouldChurnMovedChild = fieldPath === 'settings.variant';",
      "  const decision = shouldRenameChildFirst || shouldRenameParentSecond || shouldChurnMovedChild ? 'rename' : 'keep';",
      "  const finalName = shouldRenameChildFirst ? 'variant' : shouldRenameParentSecond ? 'settings' : shouldChurnMovedChild ? 'recipe' : fieldName;",
      "  console.log(JSON.stringify({",
      "    schemaVersion: 1,",
      "    model,",
      "    fieldPath,",
      "    decision,",
      "    finalName,",
      "    finalPath: null,",
      "    finalType: 'string',",
      "    required: false,",
      "    rationale: 'Fake reviewer checks rebasing frozen child rename paths after a parent rename.',",
      "    alternatives: [finalName, fieldName],",
      "    simplestChoice: finalName,",
      "    confidence: 'high',",
      "    questions: [],",
      "    ownerBoundary: null",
      "  }));",
      "});",
    ].join("\n"),
  );
  await chmod(path, 0o755);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tsxBin(): string {
  return join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
}

async function readdirFileNames(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}
