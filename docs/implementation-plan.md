# Data Model Review Tool Implementation Plan

## Objective

Build a problem-agnostic data model reviewer and simplifier that converges on a
minimum viable schema. The tool should extract proposed data models into a
normalized field graph, run independent reviews for every added or changed
field/column, aggregate simplification decisions, apply safe changes, and repeat
until no reviewer can simplify the model further.

The skill remains the agent-facing workflow. The tool becomes the deterministic
execution and validation layer behind that workflow.

The agent is still responsible for writing the first draft of the schema.
Schemator does not need to invent the initial data model. Its job begins after a
draft exists: parse the draft, enumerate every proposed field or column, force
review coverage, apply simplifications, and verify that the final schema still
covers the stated requirements.

## Core Principle

Do not rely on an agent to remember every nested field.

Schemator should push reviewers toward a Lindy data model: names and stored
facts that are boring, durable, and likely to remain the same for the next ten
or a hundred years. The goal is not clever modeling language; it is the smallest
schema whose concepts can survive product, provider, and implementation churn.

The extractor must enumerate the model graph. Every field, nested field, column,
selector key, policy key, JSON Schema property, SQL column, and object-like
subfield must become an explicit review item or an explicit opaque exemption.

Extraction is a coverage guardrail, not an authoring step. It converts an
agent-authored draft such as:

```json
{
  "profile": {
    "name": "claude",
    "settings": {
      "temperature": 0.7
    }
  }
}
```

into explicit review targets:

```text
profile
profile.name
profile.settings
profile.settings.temperature
```

Validation can then fail mechanically when a review covers `profile.name` but
misses `profile.settings.temperature`.

Markdown is a report format, not the source of truth.

## Architecture

### 1. Extract

Parse source schemas and produce a normalized JSON field graph.

Inputs are drafts authored by an agent or a human: JSON Schema files, SQL
migrations, TypeScript interfaces, OpenAPI schemas, Markdown proposal snippets,
or similar artifacts. The extractor does not decide whether a field belongs in
the model. It only records what exists, where it came from, how it is nested,
and what review item must be produced for it.

Supported sources, in priority order:

1. JSON Schema files.
2. Markdown fenced JSON Schema, TypeScript, YAML, and SQL blocks.
3. TypeScript type aliases and interfaces.
4. SQL `CREATE TABLE` statements.
5. YAML/KRM resources.
6. OpenAPI schemas and `$ref` graphs.

Use real parsers where available:

- TypeScript: TypeScript compiler API or `ts-morph`.
- JSON/JSON Schema: native JSON parser plus `$ref` resolution.
- YAML/KRM: YAML parser plus JSON Pointer traversal.
- SQL: dialect-aware parser such as `sqlglot`, with dialect selection.
- OpenAPI: OpenAPI parser plus component schema traversal.

Initial MVP may support fewer extractors, but the field graph contract should
not change when new extractors are added.

The first implementation should optimize for proving review coverage over
schema generation. A narrow extractor that reliably finds every field in one
source format is more valuable than a broad extractor that misses nested keys.

### 2. Normalize

Convert extracted models into a language-agnostic graph.

```json
{
  "schemaVersion": 1,
  "source": {
    "path": "rfcs/0009-model-harness-profiles.md",
    "revision": "git-sha-or-null"
  },
  "models": [
    {
      "id": "ModelProfilePolicy",
      "kind": "object",
      "source": {
        "path": "rfcs/0009-model-harness-profiles.md",
        "span": {
          "startLine": 380,
          "endLine": 395
        }
      },
      "fields": [
        {
          "path": "promptRecipe",
          "name": "promptRecipe",
          "type": "\"default-prompt\" | \"gpt-5-prompt\"",
          "required": false,
          "nullable": false,
          "parent": "ModelProfilePolicy",
          "objectLike": false,
          "source": {
            "path": "rfcs/0009-model-harness-profiles.md",
            "span": {
              "startLine": 390,
              "endLine": 390
            }
          }
        }
      ]
    }
  ]
}
```

Required graph concepts:

- `model.id`
- `model.kind`
- `field.path`
- `field.name`
- `field.type`
- `field.required`
- `field.objectLike`
- `field.source`
- parent/child relationships
- references to named models, tables, or schemas

### 3. Review

Spawn one independent review run per added or changed field/column.

Each sub-run receives:

- project and task context when provided;
- model purpose;
- current required use cases;
- the full current schema for context;
- the normalized field graph;
- exactly one field or column under review;
- naming conventions and minimum viable schema rules.

Project/task context is a first-class review input, not a hardcoded rule list.
It can explain the product, target users, durable domain vocabulary, examples
versus canonical schema boundaries, long-term automation goals, and missing
semantics reviewers should ask about. It must be passed to every independent
field reviewer so decisions are not made from bare field names alone.

Each sub-run must return structured JSON:

```json
{
  "schemaVersion": 1,
  "model": "ModelProfilePolicy",
  "fieldPath": "promptRecipe",
  "decision": "rename",
  "finalName": "systemPromptVariant",
  "finalType": "\"default-prompt\" | \"gpt-5-prompt\"",
  "required": false,
  "rationale": "The field is needed only as a code-owned prompt contribution selector. Recipe is too broad.",
  "alternatives": [
    "systemPromptVariant",
    "promptContributionSet",
    "remove"
  ],
  "simplestChoice": "systemPromptVariant",
  "confidence": "medium",
  "questions": []
}
```

Allowed decisions:

- `keep`
- `rename`
- `merge`
- `derive`
- `move`
- `defer`
- `remove`
- `opaque`

`opaque` is allowed only for fields that intentionally remain uninterpreted by
the current layer, and it requires a justification plus an owner boundary.

### 4. Aggregate

The coordinator reads all field review JSON files and produces an aggregate
decision file.

The aggregator must:

- fail if any extracted field lacks a review;
- fail if any object-like field lacks nested reviews or an `opaque` exemption;
- group overlapping rename/merge/remove recommendations;
- identify conflicts between reviewers;
- require a conflict-resolution run when decisions cannot be applied together;
- reject new fields introduced by the coordinator unless they get their own
  field review.

### 5. Apply

The reducer applies safe simplifications as a patch.

Default policy:

- Apply high-confidence `remove` when the field lacks a current use case.
- Apply `rename` when it improves clarity and matches local naming conventions.
- Apply `merge` only when the target field is reviewed and can cover both use
  cases.
- Apply `derive` by removing stored data only when derivation is deterministic
  and the source fields remain available.
- Apply `defer` by removing the field and recording the deferred requirement.
- Do not apply low-confidence or conflicting recommendations without a focused
  conflict review.

### 6. Iterate

After applying changes:

1. Re-extract the graph.
2. Compare it with the previous graph.
3. Spawn reviews for all new, changed, or still-questionable fields.
4. Aggregate and apply again.
5. Repeat until stable.

Convergence means:

- no reviewer recommends `remove`, `rename`, `merge`, `derive`, `move`, or
  `defer`;
- no object-like field has unreviewed nested fields;
- no final field lacks a review decision;
- no removed/deferred field remains in the final schema;
- no new field was introduced without review;
- the final schema still satisfies declared required use cases.

### 7. Report

Generate Markdown from the JSON artifacts.

The report should include:

- model purpose;
- required use cases;
- iteration count;
- field graph summary;
- per-field decisions;
- fields removed;
- fields renamed;
- fields merged;
- fields derived instead of stored;
- fields deferred;
- opaque fields and owner boundaries;
- final schema;
- convergence status.

## File Layout

Recommended output directory:

```text
.schemator/
  project-context.md
  graph.iteration-1.json
  jobs.iteration-1/
  reviews.iteration-1/
    ModelProfilePolicy.promptRecipe.review.json
    ModelProfilePolicy.reasoningDefault.review.json
  aggregate.iteration-1.json
  patch.iteration-1.md
  graph.iteration-2.json
  reviews.iteration-2/
  aggregate.iteration-2.json
  final-report.md
```

Review files should be validated by JSON Schema:

```text
schemas/model-graph.schema.json
schemas/field-review.schema.json
schemas/aggregate-review.schema.json
```

## CLI Shape

Target command family:

```bash
schemator extract --source schema.ts --out .schemator/graph.iteration-1.json
schemator create-jobs --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/jobs.iteration-1
schemator review --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/reviews.iteration-1
schemator aggregate --graph .schemator/graph.iteration-1.json --reviews .schemator/reviews.iteration-1 --out .schemator/aggregate.iteration-1.json
schemator apply --graph .schemator/graph.iteration-1.json --aggregate .schemator/aggregate.iteration-1.json --out .schemator/patch.iteration-1.md
schemator validate --graph .schemator/graph.iteration-2.json --reviews .schemator/reviews.iteration-2
schemator report --run .schemator --out .schemator/final-report.md
```

V1 end-to-end run:

```bash
schemator run --source schema.ts --context project-context.md --out .schemator
```

## Agent Integration

The `data-model` skill should eventually instruct agents to use this tool before
finalizing a schema.

Required agent behavior:

1. Extract the graph.
2. Run independent per-field reviews.
3. Aggregate decisions.
4. Apply safe simplifications.
5. Repeat until convergence.
6. Generate Markdown report.
7. Update final schema only after validation passes.

Agents must not finalize while validation reports missing reviews, unreviewed
nested fields, unresolved simplification recommendations, or schema/report
drift.

## V1 Implementation Decisions

- Ship a TypeScript CLI on Node 22.
- Support JSON Schema files plus Markdown fenced TypeScript, JSON, and YAML
  blocks first.
- Generate one standalone review prompt per extracted field so Pi or other
  model-review runners can consume stable jobs.
- Support an optional `--context <file>` input for `create-jobs`, `review`, and
  `run`; include that context verbatim in generated field prompts and copy it
  into the run directory as `project-context.md`.
- Use a Pi-backed review strategy by default. It starts one independent Pi
  reviewer per field in a bounded worker process, constrains the final answer
  with `schemas/field-review.schema.json` through a `submit_field_review` tool,
  and validates every returned review before aggregation.
- Include a conservative deterministic local fallback only for smoke tests. It
  may keep fields or mark opaque owner boundaries, but it must not contain
  field-specific product rename/remove rules.
- Make the default prompt explicitly ask for a data model that can remain the
  same for the next ten or a hundred years.
- Keep source editing as a patch-plan/report artifact in v1. The reducer applies
  simplifications to the normalized graph so the run can converge, but it does
  not rewrite source files yet.
- Reject `merge` and `move` decisions during v1 aggregation. They remain part of
  the review vocabulary, but they require a future reducer that can prove target
  coverage and compose path rewrites safely.
- Treat requirements verification as a future structured contract. V1 validates
  field-review coverage and convergence; human review still owns whether the
  simplified model satisfies product requirements.

## Remaining Design Questions

- Should ACP-compatible runners share the Pi worker adapter, or should they
  consume the generated prompt jobs through a separate backend?
- Should low-confidence keep/remove decisions trigger automatic second opinions?
- What is the smallest structured requirements format that can let Schemator
  verify final schema sufficiency without turning into a product spec language?
- Which source formats should get source-rewrite support first?
