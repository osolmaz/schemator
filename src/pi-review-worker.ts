#!/usr/bin/env node
import {
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { FieldReview } from "./types.js";

type ThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SUBMIT_TOOL_NAME = "submit_field_review";
const DECISIONS = ["keep", "rename", "merge", "derive", "move", "defer", "remove", "opaque"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;

const SYSTEM_PROMPT = [
  "You are Schemator's field reviewer.",
  "The user message is a complete field-review brief: the field under review,",
  "its model, the full graph, project context, and the decision rules.",
  "Decide the field's fate and call the submit_field_review tool exactly once",
  "with values that satisfy the brief's JSON contract.",
  "Do not write prose answers; the tool call is the review.",
].join(" ");

const submitFieldReviewTool = defineTool({
  name: SUBMIT_TOOL_NAME,
  label: "Submit field review",
  description: "Submit the final review for the field under review and end the turn.",
  parameters: Type.Object({
    schemaVersion: Type.Literal(1),
    model: Type.String({ minLength: 1, description: "ID of the model that owns the field" }),
    fieldPath: Type.String({ minLength: 1, description: "Path of the field under review" }),
    decision: StringEnum(DECISIONS, { description: "What should happen to the field" }),
    finalName: Type.String({ minLength: 1, description: "Final field name after the decision" }),
    finalPath: Type.Optional(Type.String({ minLength: 1, description: "Final field path when it moves" })),
    finalType: Type.String({ description: "Final field type after the decision" }),
    required: Type.Boolean({ description: "Whether the field is required after the decision" }),
    rationale: Type.String({ minLength: 1, description: "Why this decision produces the smallest durable model" }),
    alternatives: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Considered alternatives, best first",
    }),
    simplestChoice: Type.String({ minLength: 1, description: "The simplest viable choice" }),
    confidence: StringEnum(CONFIDENCES),
    questions: Type.Array(Type.String(), { description: "Open product questions, empty when none" }),
    ownerBoundary: Type.Optional(
      Type.String({ minLength: 1, description: "Owner boundary required for an opaque decision" }),
    ),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: "Field review submitted." }],
      details: { ...params },
      terminate: true,
    };
  },
});

type WorkerOptions = {
  model?: string;
  thinking?: ThinkingLevel;
};

async function runFieldReview(prompt: string, options: WorkerOptions): Promise<FieldReview> {
  const modelRuntime = await ModelRuntime.create();
  const model = options.model === undefined ? undefined : await resolveModel(modelRuntime, options.model);
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: SYSTEM_PROMPT,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    ...(model === undefined ? {} : { model }),
    ...(options.thinking === undefined ? {} : { thinkingLevel: options.thinking }),
    tools: [SUBMIT_TOOL_NAME],
    customTools: [submitFieldReviewTool],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  let submitted: FieldReview | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === SUBMIT_TOOL_NAME && !event.isError) {
      submitted = event.result.details as FieldReview | undefined;
    }
  });
  try {
    await session.prompt(prompt);
  } finally {
    unsubscribe();
    session.dispose();
    await settingsManager.flush();
  }
  if (submitted === undefined) {
    throw new Error("Pi model did not submit a field review");
  }
  return submitted;
}

async function resolveModel(modelRuntime: ModelRuntime, value: string) {
  const separator = value.indexOf("/");
  if (separator === -1) {
    throw new Error(`--model must be provider/model, got: ${value}`);
  }
  const provider = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  const model = modelRuntime.getModel(provider, modelId);
  if (model === undefined) {
    throw new Error(`review model not found: ${value}`);
  }
  if (!(await modelRuntime.checkAuth(provider))) {
    throw new Error(`no authentication for review provider ${provider}`);
  }
  return model;
}

function parseWorkerArgs(argv: string[]): WorkerOptions {
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--model" && value !== undefined) {
      model = value;
      index += 1;
      continue;
    }
    if (argument === "--thinking" && value !== undefined) {
      thinking = parseThinking(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown worker argument: ${argument ?? "<missing>"}`);
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
  };
}

function parseThinking(value: string): ThinkingLevel {
  if (!THINKING_LEVELS.has(value)) {
    throw new Error(`--thinking must be one of: ${[...THINKING_LEVELS].join(", ")}`);
  }
  return value as ThinkingLevel;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      resolve(input);
    });
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const options = parseWorkerArgs(process.argv.slice(2));
  const prompt = await readStdin();
  const review = await runFieldReview(prompt, options);
  process.stdout.write(`${JSON.stringify(review)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
