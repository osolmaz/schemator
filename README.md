# schemator

Schemator is a schema and data-model review CLI for agents.

It turns draft TypeScript, JSON Schema, YAML, JSON, or Markdown proposal
snippets into a reviewed field graph, asks independent reviewers to challenge
each field, applies safe reductions, and repeats until the model stabilizes.

## Quick Start

Install the published package:

```bash
npm install -g @dutifuldev/schemator
```

Or use a local checkout:

```bash
git clone https://github.com/dutifuldev/schemator.git
cd schemator
npm install
```

Run a full review against a draft schema or proposal:

```bash
schemator run --source schema.md --context project-context.md --out .schemator
```

If you are using the checkout directly, prefix CLI commands with
`npm run dev --`.

Then inspect the report and diff:

```bash
schemator report --run .schemator --out .schemator/final-report.md
schemator diff --run .schemator --out .schemator/graph-diff.md
```

Use `--context` for product and naming guidance. Good context explains what the
schema is for, which fields are user-facing, which vocabulary is intentional,
and what should stay stable.

## Quick Setup: Tell Your Agent About Schemator

If you are an agent using Schemator to review a repository's data model, start
with [Agent Entrypoint](docs/AGENT_ENTRYPOINT.md). It explains how to find the
schema or proposal, choose context, run Schemator, inspect artifacts, and report
manual decisions.

Copy the block below and paste it into your coding agent when you want it to
review a data model with Schemator.

```text
Use Schemator to review and simplify this project's data model.

Attention agent: start with this file before changing files:
https://raw.githubusercontent.com/dutifuldev/schemator/refs/heads/main/docs/AGENT_ENTRYPOINT.md

Follow it exactly. Inspect the existing schema or proposal, run Schemator,
review the report and diff, and ask only for missing product semantics or
naming constraints before applying schema changes.
```

## Review Strategy

`codex` is the default strategy. It starts one independent `codex exec` reviewer
per field, validates each JSON result, aggregates the decisions, and applies
safe changes.

Schemator can also use another agent runtime:

```bash
schemator run --strategy pi --reviewer-model claude-bridge/claude-sonnet-4-6 --source schema.md --context project-context.md --out .schemator
schemator run --strategy pi --reviewer-model openai/gpt-5.1 --reviewer-arg=--thinking --reviewer-arg off --source schema.md --out .schemator
```

Use `command` for any CLI that reads the field-review prompt from stdin and
prints one field-review JSON object to stdout:

```bash
schemator review --strategy command --reviewer-command ./review-field --graph .schemator/graph.iteration-1.json --out .schemator/reviews.iteration-1
```

Shared reviewer options:

- `--reviewer-command <path>`: executable for `codex`, `pi`, or `command`.
- `--reviewer-model <name>`: provider/model passed to the reviewer when supported.
- `--reviewer-timeout-ms <n>`: per-field timeout.
- `--reviewer-concurrency <n>`: maximum concurrent external reviewers.
- `--reviewer-arg <arg>`: extra reviewer argument; repeat for multiple args. Use `--reviewer-arg=--flag` when the value itself starts with `--`.

Use local mode only for smoke tests:

```bash
schemator run --strategy local --source schema.md --out .schemator-smoke
```

Local mode is conservative and does not make semantic field-specific rename or
removal decisions.

## Useful Commands

Generate the field graph:

```bash
schemator extract --source schema.ts --out .schemator/graph.iteration-1.json
```

Write review prompts without running reviewers:

```bash
schemator create-jobs --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/jobs.iteration-1
```

Run review and aggregation manually:

```bash
schemator review --graph .schemator/graph.iteration-1.json --context project-context.md --out .schemator/reviews.iteration-1
schemator aggregate --graph .schemator/graph.iteration-1.json --reviews .schemator/reviews.iteration-1 --out .schemator/aggregate.iteration-1.json
schemator apply --graph .schemator/graph.iteration-1.json --aggregate .schemator/aggregate.iteration-1.json --out .schemator/patch.iteration-1.md
```

## Reports

Run reports are based on reducer artifacts, not raw review totals. They separate
applied changes, skipped proposals, manual structural proposals, consistency
warnings, and the final graph.

Treat a converged result as a candidate schema, not automatic product truth.
Do a manual naming and product-semantics pass before accepting the final model.

## Bundled Agent Skills

Schemator exposes its agent skills through [Skillflag](https://github.com/dutifuldev/skillflag):

```bash
schemator --skill list
schemator --skill show schemator
schemator --skill export schemator | npx skillflag install --agent codex
```

Bundled skills:

- `schemator`: how to run and interpret Schemator.
- `final-report`: how to publish a complete final run report.

## More

- [npm package](https://www.npmjs.com/package/@dutifuldev/schemator)

## License

[MIT](LICENSE)
