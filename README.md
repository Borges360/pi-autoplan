# pi-autoplan

The amount of planning a task actually needs.

Rules choose none, micro or full. Full plans are bounded DAG artifacts with acceptance criteria. Only verified material changes admit revisions; invalid updates preserve the last valid plan. The current Pi model creates plans through autoplan_update.

## Install

Requires Node >= 22.19 and Pi **1.2.0**. Install this Git repository with Pi:

```sh
pi install git:github.com/Borges360/pi-autoplan
```

From a local checkout:

```sh
npm ci
npm test
npm run build
pi -e ./src/extension.ts
node dist/cli.js doctor
```

The source entry point is loadable directly by Pi; npm packages include source and
compiled JavaScript/declarations. No sibling extension, SQLite driver, remote
classifier or Durable installation is required for the default file backend.

## Use

Run `/autoplan` for the interactive menu, or `/autoplan status` for structured
headless output. Domain actions: `status, show, create <plan.json>, validate <plan.json>, replan [plan.json], history, explain`. Shared actions: `auto`, `off`,
`observe`, `config`, `doctor`, `storage status`, `storage migrate files|sqlite|durable`.
The CLI uses the same actions: `node dist/cli.js status`.
TUI grouping: Plan / History / Settings. Config opens a small mode wizard in the TUI; headless config
returns validated settings. Edit the user config for advanced settings.

Default state: `~/.pi/agent/state/pi-autoplan/projects/<sha256-of-canonical-repository-root>/`.
`PI_ECOSYSTEM_STATE_ROOT` changes the parent state directory for testing or deployment.
No project state is written implicitly.

## Guarantees and validation

Versioned optional events, bounded actions, optimistic record versions, secret
redaction at output boundaries, checksum validation, append-only journal and
fail-closed persistence. The same storage conformance tests run against files,
SQLite and pinned Pi Durable 1.2.0. Fault tests kill a real process after a durable
journal commit, race two processes and reject corrupt snapshots or symlink escapes.

```sh
npm test
npm run lint
npm run benchmark
npm pack --dry-run
```

This is a development release. Local correctness/recovery results do not establish
SWE-bench/Terminal-Bench quality or inference-cost savings. See [benchmarks](benchmarks/README.md)
and [acceptance status](ACCEPTANCE.md) for the limits of the evidence.

[Architecture](ARCHITECTURE.md) · [Configuration](CONFIGURATION.md) ·
[Security](SECURITY.md) · [Migration](MIGRATION.md) · [Compatibility](COMPATIBILITY.md).

Git checkouts include the compiled worker and CLI. CI checks that a rebuild matches
the committed distribution. Host-provided Pi packages, including the coding-agent SDK
and Typebox, are declared as peer dependencies. Isolated child workers resolve the SDK
from the active Pi installation.
