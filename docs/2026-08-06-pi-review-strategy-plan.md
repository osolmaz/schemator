---
title: Pi Review Strategy Plan
author: Onur Solmaz <2453968+osolmaz@users.noreply.github.com>
date: 2026-08-06
---

# Pi Review Strategy Plan

The user asked: "can we make schemator use pi? instead of codex?" This plan
replaces Schemator's Codex-backed field review with a Pi-backed one.

## Background

Today `src/codex-review.ts` spawns one `codex exec` process per field, forces
the final answer through `schemas/field-review.codex-output.schema.json`, and
parses JSON from stdout. The review itself needs no repository tools: the field
prompt already carries the full graph, the field under review, project context,
and run history.

Pi Reviewer (`packages/pi-reviewer` in OnurPi) is the reference for how a
standalone CLI should drive Pi: bounded child workers, in-memory sessions,
canonical Pi auth, fail closed on malformed output. Pi Reviewer itself reviews
Git diffs and emits code-review findings, so it is the wrong tool for schema
field decisions. Schemator gets its own small Pi runner that borrows Pi
Reviewer's worker pattern.

## Scope

- Replace `src/codex-review.ts` with `src/pi-review.ts`. The orchestration
  stays: one worker per field, bounded concurrency, first failure aborts the
  rest, per-field timeout, JSON written per review.
- Add `src/pi-review-worker.ts`, a child entry point that:
  - reads the rendered field prompt from stdin,
  - creates an in-memory Pi SDK session with canonical Pi auth and models,
  - gives the model exactly one tool, `submit_field_review`, whose typebox
    parameters mirror `FieldReview` and whose result terminates the turn,
  - prints the submitted review as JSON on stdout, exits nonzero on failure.
- Keep the worker wire protocol identical to the Codex one (prompt on stdin,
  review JSON on stdout) so existing fake-reviewer tests keep working.
- CLI: `--strategy` becomes `pi` (default) or `local`. Replace
  `--codex-command/--codex-model/--codex-timeout-ms/--codex-concurrency` with
  `--pi-command/--pi-model/--pi-thinking/--pi-timeout-ms/--pi-concurrency`.
  `--pi-model` takes `provider/model`; when omitted, Pi's configured default
  model applies.
- Hard cutover: delete the Codex strategy, the `codex-review` module, and
  `schemas/field-review.codex-output.schema.json`. Validation keeps using the
  canonical `schemas/field-review.schema.json`.
- Rename Codex wording in source, tests, README, the bundled skill, and docs.
- Add `@earendil-works/pi-coding-agent` and `typebox` dependencies; require
  Node >=22.19.0 to match Pi.

## Non-goals

- No compatibility aliases for Codex flags or the Codex strategy.
- No persistent Pi sessions and no changes to Pi internals; only documented
  SDK APIs (`createAgentSession`, `ModelRuntime`, `SessionManager.inMemory`,
  `DefaultResourceLoader`, `defineTool`).
- No changes to extraction, aggregation, reduction, or report formats.
- Real-model Pi runs are smoke-tested manually, not in the test suite; tests
  inject fake workers through `--pi-command` exactly as they did for Codex.

## Acceptance criteria

- `npm run check` (typecheck, tests, build) passes.
- Tests cover the Pi strategy through fake workers, including cancellation of
  in-flight workers after a failure.
- `schemator run --strategy pi` against a real draft schema completes with a
  real Pi model when auth is available.
- No `codex` references remain outside historical experiment notes.

## Verification

1. `npm install` to pick up the new dependencies.
2. `npm run check`.
3. `npx -y @simpledoc/simpledoc check` for documentation conventions.
4. Manual smoke run of `schemator run` with a real Pi model on a small schema.
