---
name: pi-autoplan
description: Maintain and use the independent Pi Autoplan extension, its bounded plans, configuration and storage.
---

# Pi Autoplan

Use this specialization for changes or support in the Pi Autoplan repository. The shared workspace catalog supplies general Harness procedures; this file contains only product-specific context.

## Product role

- Pi Autoplan selects none, micro or full planning. Full plans are bounded task DAGs with acceptance criteria.
- Material evidence is required to revise a plan; invalid updates preserve the last valid plan.
- The extension owns its state namespace and defaults to file storage. SQLite and Pi Durable are opt-in.
- It must remain independent at runtime: do not add a mandatory sibling-extension dependency or read another extension's private state.

## User entry points

- The root command /plan opens the interactive menu with Plan, History and Settings groups.
- /plan status is the structured headless status command; /autoplan remains a compatibility alias.
- Keep the documented CLI commands available for users who choose the CLI.
- Settings edits remain drafts until explicit save. Language selection can preview English or Brazilian Portuguese; Ctrl+S saves and Escape returns.
- Error handling should explain the cause and safe recovery action. Missing or invalid local settings must not silently persist changes or close an otherwise usable menu.

## Safety and storage

- File storage is the default. SQLite and Pi Durable require explicit selection.
- Project configuration is read only after Pi trusts the project. Project settings cannot raise immutable user security controls, budgets or write permissions.
- Default writes are disabled. Never claim a service, registry package or compatibility range that local evidence has not verified.
- Do not inspect or mutate user-global Pi state during ordinary repo work. Tests should use isolated temporary state and remove it afterward.
- Do not call a model, network service, external checker or sibling extension as part of documentation/context work.
- This repository has no declared design-system dependency. Do not infer adoption from shared workspace skills or a licensed asset notice.

## Change and verification guidance

- Read README.md, ARCHITECTURE.md and SECURITY.md before changing behavior.
- Keep schemas backward-compatible or provide an explicit recoverable migration with tests.
- Run npm test, npm run lint, npm run build or npm run benchmark only when the change requires that scope; report what actually ran.
- Treat registry publication, Pi installation and remote effects as separately authorized work.
- The menu contract is command-root opens panel, explicit draft, Ctrl+S saves, Escape returns/discards/cancels, and long operations are cancelable.
