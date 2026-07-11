import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { aggregateReviews, readReviews } from "./aggregate.js";
import { renderPatchPlan } from "./apply.js";
import { writeReviewerReviews, type ReviewerOptions, type ReviewerStrategy } from "./codex-review.js";
import { extractGraph } from "./extract/index.js";
import { readJson, writeJson, writeText } from "./files.js";
import {
  applyAggregateToGraph,
  graphDecisionKey,
  reduceAggregateGraph,
  type GraphReduction,
} from "./graph.js";
import { writeReviewJobs, type FieldPromptOptions, type RunHistoryEntry } from "./jobs.js";
import { applyRenameMapToPath } from "./rename.js";
import { renderRunReport } from "./report.js";
import { writeDeterministicReviews } from "./review.js";
import type { AggregateReview, ModelGraph } from "./types.js";
import { validateAggregateReview, validateFieldReview, validateModelGraph } from "./validate.js";

export type ReviewStrategy = ReviewerStrategy | "local";

export type RunConvergenceOptions = {
  source: string;
  out: string;
  maxIterations: number;
  strategy: ReviewStrategy;
  projectContext?: string;
  reviewer?: Pick<ReviewerOptions, "strategy" | "command" | "args" | "model" | "timeoutMs" | "concurrency">;
};

export type RunSummary = {
  schemaVersion: 1;
  source: string;
  stableIteration: number;
  stable: boolean;
  finalGraph: string;
  finalReport: string;
  projectContext?: string;
  projectContextSha256?: string;
};

export type ReductionArtifact = Omit<GraphReduction, "graph">;

export async function runConvergence(options: RunConvergenceOptions): Promise<RunSummary> {
  await mkdir(options.out, { recursive: true });
  if (options.projectContext !== undefined) {
    await writeText(join(options.out, "project-context.md"), options.projectContext);
  }

  const initialGraph = await extractGraph(options.source);
  let graph: ModelGraph = initialGraph;
  let lastAggregate: AggregateReview | null = null;
  let invalidAggregate: AggregateReview | null = null;
  const aggregates: AggregateReview[] = [];
  const reductions: ReductionArtifact[] = [];
  const runHistory: RunHistoryEntry[] = [];
  const frozenRenamePaths = new Set<string>();
  let lastReduction: GraphReduction | null = null;
  let stableIteration = 0;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    const graphPath = join(options.out, `graph.iteration-${iteration}.json`);
    const reviewsDir = join(options.out, `reviews.iteration-${iteration}`);
    const jobsDir = join(options.out, `jobs.iteration-${iteration}`);
    const aggregatePath = join(options.out, `aggregate.iteration-${iteration}.json`);
    const reductionPath = join(options.out, `reduction.iteration-${iteration}.json`);
    await writeJson(graphPath, graph);
    const reviewOptions = reviewContextOptions(options.projectContext, runHistory);
    await writeReviewJobs(graph, jobsDir, reviewOptions);
    if (options.strategy === "local") {
      await writeDeterministicReviews(graph, reviewsDir, {
        strategy: "local",
        ...reviewOptions,
      });
    } else {
      await writeReviewerReviews(graph, reviewsDir, {
        ...(options.reviewer ?? {}),
        strategy: options.strategy,
        ...reviewOptions,
      });
    }
    const aggregate = await aggregateFromFiles(graphPath, reviewsDir);
    await writeJson(aggregatePath, aggregate);
    await writeText(join(options.out, `patch.iteration-${iteration}.md`), renderPatchPlan(graph, aggregate));
    lastAggregate = aggregate;
    aggregates.push(aggregate);
    stableIteration = iteration;

    if (!aggregate.ok) {
      invalidAggregate = aggregate;
      break;
    }
    const reduction = reduceAggregateGraph(graph, aggregate, { frozenRenamePaths });
    lastReduction = reduction;
    const artifact = reductionArtifact(reduction);
    reductions.push(artifact);
    await writeJson(reductionPath, artifact);
    if (!reduction.changed) {
      break;
    }
    recordRunHistory(iteration, reduction, runHistory, frozenRenamePaths);
    graph = reduction.graph;
  }

  await writeJson(join(options.out, "graph.final.json"), graph);
  if (lastAggregate) {
    await writeText(
      join(options.out, "final-report.md"),
      renderRunReport({
        initialGraph,
        finalGraph: graph,
        aggregates,
        reductions,
        stableIteration,
        stable: lastAggregate.ok && lastReduction !== null && !lastReduction.changed,
      }),
    );
  }
  const summary: RunSummary = {
    schemaVersion: 1,
    source: options.source,
    stableIteration,
    stable: lastAggregate ? lastAggregate.ok && lastReduction !== null && !lastReduction.changed : false,
    finalGraph: "graph.final.json",
    finalReport: "final-report.md",
    ...(options.projectContext !== undefined
      ? {
        projectContext: "project-context.md",
        projectContextSha256: sha256(options.projectContext),
      }
      : {}),
  };
  await writeJson(join(options.out, "run-summary.json"), summary);
  if (invalidAggregate) {
    throw new Error(
      `aggregate validation failed at iteration ${stableIteration}: ${invalidAggregate.findings.map((finding) => finding.message).join("; ")}`,
    );
  }
  if (lastAggregate?.ok && lastReduction?.changed) {
    throw new Error(`run stopped before convergence after ${stableIteration} iteration(s)`);
  }
  return summary;
}

export async function aggregateFromFiles(graphPath: string, reviewsDir: string): Promise<AggregateReview> {
  const graph = assertModelGraph(await readJson(graphPath));
  const reviews = await readReviews(reviewsDir);
  for (const review of reviews) {
    const validation = validateFieldReview(review);
    if (!validation.ok) {
      throw new Error(`invalid field review for ${review.model}.${review.fieldPath}:\n${validation.errors.join("\n")}`);
    }
  }
  const aggregate = aggregateReviews(graph, reviews);
  const validation = validateAggregateReview(aggregate);
  if (!validation.ok) {
    throw new Error(`aggregate is invalid:\n${validation.errors.join("\n")}`);
  }
  return aggregate;
}

export function combineAggregates(aggregates: AggregateReview[]): AggregateReview {
  const summary = emptySummary();
  for (const aggregate of aggregates) {
    for (const decision of Object.keys(summary) as Array<keyof typeof summary>) {
      summary[decision] += aggregate.summary[decision];
    }
  }
  return {
    schemaVersion: 1,
    ok: aggregates.every((aggregate) => aggregate.ok),
    summary,
    decisions: aggregates.flatMap((aggregate) => aggregate.decisions),
    findings: aggregates.flatMap((aggregate) => aggregate.findings),
  };
}

export function deriveFinalGraph(graph: ModelGraph, aggregates: AggregateReview[]): ModelGraph {
  let next = graph;
  for (const aggregate of aggregates) {
    next = applyAggregateToGraph(next, aggregate);
  }
  return next;
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

function recordRunHistory(
  iteration: number,
  reduction: GraphReduction,
  runHistory: RunHistoryEntry[],
  frozenRenamePaths: Set<string>,
): void {
  const renameMaps = appliedRenameMapsByModel(reduction);
  rebaseRunHistory(runHistory, renameMaps);
  rebaseFrozenRenamePaths(frozenRenamePaths, renameMaps);

  for (const applied of reduction.applied) {
    runHistory.push({
      iteration,
      model: applied.model,
      fieldPath: applied.fieldPath,
      decision: applied.decision,
      ...(applied.finalPath === undefined ? {} : { finalPath: applied.finalPath }),
    });
    if (applied.decision === "rename" && applied.finalPath !== undefined) {
      frozenRenamePaths.add(graphDecisionKey(applied.model, applied.finalPath));
    }
  }
}

function appliedRenameMapsByModel(reduction: GraphReduction): Map<string, Map<string, string>> {
  const renameMaps = new Map<string, Map<string, string>>();
  for (const applied of reduction.applied) {
    if (applied.decision !== "rename" || applied.finalPath === undefined) {
      continue;
    }
    const modelMap = renameMaps.get(applied.model) ?? new Map<string, string>();
    modelMap.set(applied.fieldPath, applied.finalPath);
    renameMaps.set(applied.model, modelMap);
  }
  return renameMaps;
}

function rebaseRunHistory(
  runHistory: RunHistoryEntry[],
  renameMaps: Map<string, Map<string, string>>,
): void {
  for (const entry of runHistory) {
    if (entry.finalPath === undefined) {
      continue;
    }
    const renameMap = renameMaps.get(entry.model);
    if (renameMap) {
      entry.finalPath = applyRenameMapToPath(entry.finalPath, renameMap);
    }
  }
}

function rebaseFrozenRenamePaths(
  frozenRenamePaths: Set<string>,
  renameMaps: Map<string, Map<string, string>>,
): void {
  if (renameMaps.size === 0 || frozenRenamePaths.size === 0) {
    return;
  }

  const nextPaths = new Set<string>();
  for (const key of frozenRenamePaths) {
    const parsed = parseGraphDecisionKey(key);
    if (!parsed) {
      nextPaths.add(key);
      continue;
    }
    const renameMap = renameMaps.get(parsed.model);
    const fieldPath = renameMap ? applyRenameMapToPath(parsed.fieldPath, renameMap) : parsed.fieldPath;
    nextPaths.add(graphDecisionKey(parsed.model, fieldPath));
  }

  frozenRenamePaths.clear();
  for (const key of nextPaths) {
    frozenRenamePaths.add(key);
  }
}

function parseGraphDecisionKey(key: string): { model: string; fieldPath: string } | null {
  const separator = key.indexOf("\u0000");
  if (separator === -1) {
    return null;
  }
  return {
    model: key.slice(0, separator),
    fieldPath: key.slice(separator + 1),
  };
}

function reductionArtifact(reduction: GraphReduction): ReductionArtifact {
  return {
    changed: reduction.changed,
    applied: reduction.applied,
    skipped: reduction.skipped,
  };
}

function emptySummary(): AggregateReview["summary"] {
  return {
    totalFields: 0,
    keep: 0,
    rename: 0,
    merge: 0,
    derive: 0,
    move: 0,
    defer: 0,
    remove: 0,
    opaque: 0,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertModelGraph(value: unknown): ModelGraph {
  const validation = validateModelGraph(value);
  if (!validation.ok) {
    throw new Error(`invalid model graph:\n${validation.errors.join("\n")}`);
  }
  return value as ModelGraph;
}
