---
name: schemator
description: "Use when running Schemator to extract, review, simplify, converge, diff, or report on database schemas, ORM models, migrations, API payloads, JSON Schema, TypeScript interfaces, YAML resources, or other field-based data models."
---

# Schemator

Use Schemator as a schema-design reviewer: it extracts fields from an existing
schema/proposal, asks reviewers to challenge each field, applies safe reductions,
and reports the resulting graph. It is a design aid, not product truth.

## Workflow

1. Start from a real draft schema, model, migration, payload, or proposal.
   Schemator reviews existing shapes; it does not invent the first draft.
2. Locate the source shape and context:
   - DB / ORM: migrations, SQL DDL, Prisma/Drizzle/TypeORM/SQLAlchemy/Rails/Laravel models.
   - API / contract: OpenAPI snippets, JSON Schema, GraphQL types, protobuf, API payload examples.
   - App model: TypeScript interfaces/types, Zod schemas, YAML/JSON resources, Markdown proposals.
3. Write or locate project/task context before review. Good context explains the
   product goal, naming conventions, borrowed vocabulary, user-facing fields,
   compatibility constraints, and what must remain stable.
4. Run a real reviewer for semantic decisions. Prefer `--strategy pi` in Luke's
   Pi runtime, or `--strategy codex` when you specifically want Codex. Use
   `--strategy local` only for smoke tests and plumbing checks.
5. Inspect generated prompts under `jobs.iteration-N/` when decisions look wrong.
   Verify the expected schema source and context are injected.
6. Read reduction artifacts, not just aggregate totals. Applied changes, skipped
   proposals, manual proposals, and consistency warnings mean different things.
7. Treat convergence as a candidate schema. Do a manual naming, product-semantics,
   and backwards-compatibility pass before accepting changes.
8. For published or handoff reports, use the `schemator-final-report` skill too if installed.

## Commands

Pi runtime / provider-model selected from CLI:

```bash
schemator run --strategy pi --reviewer-model claude-bridge/claude-sonnet-4-6 --source schema.md --context project-context.md --out .schemator
schemator run --strategy pi --reviewer-model openai/gpt-5.1 --reviewer-arg=--thinking --reviewer-arg off --source schema.md --out .schemator
```

Default Codex strategy:

```bash
schemator run --source schema.md --context project-context.md --out .schemator
```

Any command that reads the prompt from stdin and prints one field-review JSON object:

```bash
schemator review --strategy command --reviewer-command ./review-field --graph .schemator/graph.iteration-1.json --out .schemator/reviews.iteration-1
```

Generate report and graph diff:

```bash
schemator report --run .schemator --out .schemator/final-report.md
schemator diff --run .schemator --out .schemator/graph-diff.md
```

Smoke test only:

```bash
schemator run --strategy local --source schema.md --out .schemator-smoke
```

Reviewer knobs:

- `--reviewer-command <path>` sets the executable for `codex`, `pi`, or `command`.
- `--reviewer-model <name>` passes a provider/model to the reviewer when supported.
- `--reviewer-timeout-ms <n>` sets the per-field timeout.
- `--reviewer-concurrency <n>` sets max concurrent external reviewers.
- `--reviewer-arg <arg>` adds extra reviewer args; use `--reviewer-arg=--flag` for flag-looking values.

## Review Rules

- Do not add local field-specific keep, rename, remove, merge, derive, or move
  rules unless the user explicitly asks for that exact field outcome.
- Use context to explain naming/product intent instead of hardcoding outcomes.
- Preserve intentional domain vocabulary when context says it is borrowed or stable.
- Prefer short clear names. Accept longer explicit names only when they prevent
  a real ambiguity.
- Watch for renamed fields that became more verbose without improving the model.
- For DB/ORM sources, flag compatibility risks separately: migrations, data
  backfills, API clients, analytics, imports/exports, and generated code may all
  depend on field names.
- Check whether removals are missing because the run was partial, because the
  field has a current use case, or because reviewers lacked enough context.

## Report Checklist

Before calling a Schemator result final:

- Include the raw initial schema graph JSON.
- Include the raw final schema graph JSON.
- Include the project context and command lines used.
- Include applied, skipped, and manual decisions separately.
- Include the initial-vs-final graph diff.
- State manual corrections, naming overrides, and compatibility concerns clearly.
- Link the pushed artifact or PR when relevant.
