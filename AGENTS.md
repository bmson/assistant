# Agent guide

A self-hostable personal assistant: a continuing conversation backed by memory, connected services, durable work, and owner approval before any outward action. This file is the entry point for coding agents. The detailed references are in [`docs/`](docs/README.md).

## Read first

- [docs/architecture.md](docs/architecture.md): package boundaries and how to add a module. The boundaries are enforced.
- [docs/system-reference.md](docs/system-reference.md): runtime flows, memory, trust, deployment.
- [docs/proactive/README.md](docs/proactive/README.md): the proactive-assistant program, with per-item briefs and a status board. Start there for any briefing, pulse, notification, calendar, mail-understanding or device-signal work.

## Layout

| Path                   | What lives there                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/agent`           | Composition root (`src/deps.ts`), executor, scheduler sweep, internal routes                                                                                          |
| `apps/web`             | Next.js HTTP adapter; the iPhone API is `app/api/mobile/v1`; `proxy.ts` is the Firestore-mode route allowlist. Read `apps/web/AGENTS.md` before changing Next.js code |
| `apps/ios`             | SwiftUI app (`Assistant.xcodeproj`, tests in `AssistantTests`); needs Xcode on macOS                                                                                  |
| `packages/config`      | Typed environment schema; every new setting goes here and in `.env.example`                                                                                           |
| `packages/core`        | Workflows, executor, schedules, proactive producers (`src/proactive`), memory, costs, model routing                                                                   |
| `packages/application` | UI-facing use cases and view models                                                                                                                                   |
| `packages/persistence` | Storage-free ports, record types and shared contract suites                                                                                                           |
| `packages/db`          | PostgreSQL adapter: Drizzle schema, migrations, seed (`src/seed.ts` holds the default schedules)                                                                      |
| `packages/firestore`   | Firestore adapter                                                                                                                                                     |
| `packages/tools`       | Tool registry, risk dispatcher, provider tools, question-regression harness                                                                                           |
| `packages/modules`     | Optional modules (google, sms, watches, …) and their hooks                                                                                                            |
| `workers/*`            | Browser, code and document workers; never import the agent or the database                                                                                            |
| `scripts/`, `infra/`   | Operational scripts, deployment and CI infrastructure                                                                                                                 |

## Commands

```sh
pnpm install
pnpm typecheck
pnpm lint            # biome, package boundaries, migrations, support matrix, iOS card contract
pnpm test            # needs PostgreSQL; allocates a disposable test database from TEST_DATABASE_URL or DATABASE_URL
pnpm test path/to/file.test.ts
pnpm test:firestore  # needs the Firestore emulator; FIRESTORE_EMULATOR_HOST=127.0.0.1:8789
pnpm test:questions  # audited-question regression checks
```

Locally, `docker compose up db` provides PostgreSQL. CI runs lint, typecheck, `pnpm test`, the Firestore emulator suite, a build and agent smoke test, and browser checks (`.github/workflows/ci.yml`).

## Rules

- **Two persistence drivers.** Production runs `PERSISTENCE_DRIVER=firestore`; PostgreSQL is still supported. Persisted behavior goes through a port in `packages/persistence`, with an adapter in both `packages/db` (plus a Drizzle migration) and `packages/firestore`, and the shared contract suite when one exists.
- **Firestore writes drop undefined fields** (`encodeRecord`). Write explicit `null` for any field you will query with `== null`.
- **Firestore-mode routes.** A web or mobile route the phone needs must be admitted in `apps/web/proxy.ts`, listed in `docs/firestore-web-route-inventory.md`, and reflected in the support matrix (`pnpm support:matrix:write`).
- **Boundaries.** Core never imports tools or apps; modules never import sibling modules. `pnpm check:boundaries` fails otherwise.
- **Outward actions need owner approval.** Never add a path that sends mail or texts, or contacts anyone, without the approval dispatcher. Proactive producers (`briefing.ts`, `pulse.ts`) are code jobs that hold no tool registry, so they cannot act outward; keep it that way.
- **Never touch the production installation.** Tests refuse `NODE_ENV=production`; use the emulator, the disposable database and scripted models. Don't send chat turns, approvals or edits to a live installation to test a change.
- **This repository is public.** No personal data in code, fixtures, docs, screenshots or commit messages: no real names, schedules, health, school, contact or financial details. Use the synthetic household in `docs/proactive/golden-signals.md`.
- **Secrets** never enter the repository; configuration names come from `packages/config`.

## Pull requests

- One work item per PR, small enough to review. Name the item ID when there is one (for example `A5`).
- The description says what changed, how it was verified (commands and new tests), and what remains.
- Update the documentation the change invalidates, and the status board in `docs/proactive/README.md` for program items.
