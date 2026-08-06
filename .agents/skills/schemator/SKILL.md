---
name: schemator
description: Use when running Schemator to extract, review, simplify, converge, diff, or report on data models, JSON schemas, API payloads, SQL tables, migrations, TypeScript interfaces, YAML resources, or other field-based schemas.
---

# Schemator

Use this skill when a task asks to run or interpret Schemator, improve a schema
with Schemator, inspect Schemator artifacts, or prepare a Schemator-backed
schema report.

## Workflow

1. Start from a real draft schema or proposal. Schemator reviews existing model
   shapes; it does not invent the first draft.
2. Write or locate project/task context before review. Context should explain
   the product goal, naming conventions, borrowed vocabulary, user-facing
   constraints, and what should remain stable.
3. Run real Pi review for semantic decisions. Use the local strategy only
   for smoke tests and plumbing checks.
4. Inspect generated prompts under `jobs.iteration-N/` when decisions look
   wrong. Verify the expected context is actually injected.
5. Read reduction artifacts, not just aggregate totals. Applied changes,
   skipped proposals, manual proposals, and consistency warnings have different
   meanings.
6. Treat a converged run as a candidate, not automatic product truth. Do a
   manual naming and product-semantics pass before accepting the final schema.
7. For published or handoff reports, use the `final-report` skill too.

## Commands

End-to-end review:

```bash
npm run dev -- run --source schema.md --context project-context.md --out .schemator
```

Write prompts without reviewing:

```bash
npm run dev -- create-jobs --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/jobs.iteration-1
```

Generate report and graph diff:

```bash
npm run dev -- report --run .schemator --out .schemator/final-report.md
npm run dev -- diff --run .schemator --out .schemator/graph-diff.md
```

Smoke test only:

```bash
npm run dev -- run --strategy local --source schema.md --out .schemator-smoke
```

## Review Rules

- Do not add local field-specific keep, rename, remove, merge, derive, or move
  rules unless the user explicitly asks for that exact field outcome.
- Use project context to explain naming intent instead of hardcoding outcomes.
- Preserve intentional declarative/configuration vocabulary when the context
  says it is borrowed or meaningful.
- Prefer short clear names. Do not accept longer explicit names unless they
  prevent a real ambiguity.
- Watch for renamed fields that became more verbose without improving the model.
- Check whether removals are missing because the run was partial, because the
  field had a current use case, or because the reviewer lacked enough context.

## Report Checklist

Before calling a Schemator result final:

- Include the raw initial schema graph JSON.
- Include the raw final schema graph JSON.
- Include the project context and command lines used.
- Include applied, skipped, and manual decisions separately.
- Include the initial-vs-final graph diff.
- State manual corrections or naming overrides clearly.
- Link the pushed artifact or PR.
