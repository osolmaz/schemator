import { join } from "node:path";
import { pathToFileNamePart, prepareGeneratedOutputDir, writeText } from "./files.js";
import type { FieldNode, ModelGraph, ModelNode } from "./types.js";

export type RunHistoryEntry = {
  iteration: number;
  model: string;
  fieldPath: string;
  decision: "rename" | "remove" | "derive" | "defer";
  finalPath?: string;
};

export type FieldPromptOptions = {
  projectContext?: string;
  runHistory?: RunHistoryEntry[];
};

export async function writeReviewJobs(
  graph: ModelGraph,
  outputDir: string,
  options: FieldPromptOptions = {},
): Promise<void> {
  await prepareGeneratedOutputDir(outputDir, ".prompt.md");
  for (const model of graph.models) {
    for (const field of model.fields) {
      const fileName = `${pathToFileNamePart(model.id)}.${pathToFileNamePart(field.path)}.prompt.md`;
      await writeText(join(outputDir, fileName), renderFieldPrompt(graph, model, field, options));
    }
  }
}

export function renderFieldPrompt(
  graph: ModelGraph,
  model: ModelNode,
  field: FieldNode,
  options: FieldPromptOptions = {},
): string {
  return [
    "# Schemator Field Review",
    "",
    "You are reviewing exactly one data-model field. Be skeptical. Prefer the smallest Lindy schema: boring names, durable concepts, no metaphors, no generic bags, and no fields without a current use case. Aim for a data model that can remain the same for the next ten or a hundred years.",
    "",
    "Return only valid JSON matching `schemas/field-review.schema.json`.",
    "The JSON object must include: `schemaVersion: 1`, `model`, `fieldPath`, `decision`, `finalName`, `finalType`, `required`, `rationale`, `alternatives`, `simplestChoice`, `confidence`, and `questions`.",
    "Allowed `decision` values: `keep`, `rename`, `merge`, `derive`, `move`, `defer`, `remove`, `opaque`.",
    "Allowed `confidence` values: `low`, `medium`, `high`.",
    "Do not include Markdown, prose, or code fences outside the JSON object.",
    "",
    ...projectContextSection(options.projectContext),
    ...runHistorySection(options.runHistory),
    "## Field Under Review",
    "",
    `- Model: \`${model.id}\``,
    `- Field path: \`${field.path}\``,
    `- Field name: \`${field.name}\``,
    `- Type: \`${field.type}\``,
    `- Required: ${field.required ? "yes" : "no"}`,
    `- Object-like: ${field.objectLike ? "yes" : "no"}`,
    "",
    "## Model Fields",
    "",
    ...model.fields.map((candidate) =>
      `- \`${candidate.path}\`: \`${candidate.type}\`${candidate.required ? "" : " (optional)"}`
    ),
    "",
    "## Full Graph Context",
    "",
    ...graph.models.flatMap(renderGraphModelContext),
    "",
    "## Decision Rules",
    "",
    "- Use `keep` only when the field has earned its place.",
    "- Use `rename` when the concept is valid but the name is not durable.",
    "- When a metaphorical or vague name clearly represents a closed selector, preset, variant, or reference, prefer a durable selector/reference name over `defer`.",
    "- Use `remove`, `derive`, `merge`, or `defer` when that produces a smaller viable model.",
    "- Use `opaque` only with a clear owner boundary.",
    "- Challenge names that are metaphorical, vague, redundant, or tied to a temporary implementation detail.",
    "- Prefer the shortest clear name. Do not rename a field to a longer or more explicit name unless the current name is genuinely ambiguous, misleading, or missing an important distinction.",
    "- Do not add suffixes like `Id`, `Mode`, `Policy`, `Preset`, `Default`, or `Config` just to make a name more explicit. Add them only when the suffix changes the meaning or prevents a real ambiguity in the surrounding schema.",
    "- Preserve established declarative configuration vocabulary when the project context says that vocabulary is intentional.",
    "",
  ].join("\n");
}

function runHistorySection(runHistory: RunHistoryEntry[] | undefined): string[] {
  if (runHistory === undefined || runHistory.length === 0) {
    return [];
  }
  const recentHistory = runHistory.slice(-80);
  return [
    "## Accepted Run Decisions",
    "",
    "These changes were already accepted and applied earlier in this run. Treat the current graph as canonical, avoid synonym churn, and propose another change only when new evidence makes the current shape clearly worse.",
    "",
    ...recentHistory.map(renderRunHistoryEntry),
    "",
  ];
}

function renderRunHistoryEntry(entry: RunHistoryEntry): string {
  if (entry.decision === "rename") {
    return `- Iteration ${entry.iteration}: \`${entry.model}.${entry.fieldPath}\` was renamed to \`${entry.finalPath ?? entry.fieldPath}\`.`;
  }
  return `- Iteration ${entry.iteration}: \`${entry.model}.${entry.fieldPath}\` was accepted as \`${entry.decision}\`.`;
}

function projectContextSection(projectContext: string | undefined): string[] {
  if (projectContext === undefined || projectContext.trim().length === 0) {
    return [];
  }
  return [
    "## Project And Task Context",
    "",
    projectContext.trimEnd(),
    "",
  ];
}

function renderGraphModelContext(model: ModelNode): string[] {
  if (model.fields.length === 0) {
    return [`- \`${model.id}\`: no fields`];
  }
  return [
    `- \`${model.id}\`:`,
    ...model.fields.map((field) =>
      `  - \`${field.path}\`: \`${field.type}\`${field.required ? "" : " (optional)"}`
    ),
  ];
}
