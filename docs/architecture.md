# Platform architecture

For the complete runtime flows, memory layers, technology inventory, and decision register, see
[System architecture and decisions](system-reference.md). For the product purpose and page-by-page
experience, see [Product intent and page guide](product-guide.md). This document remains the focused
package-boundary and module-extension reference.

## Design goals

The platform follows four rules:

1. Presentation receives serializable view data and does not know about persistence or providers.
2. Business rules live in `packages/core`; HTTP, Next.js, PostgreSQL, and provider APIs are adapters.
3. Every process reads the same typed configuration contract from `packages/config`.
4. Optional functionality is composed at the agent edge and can be disabled without editing core.

The dependency direction is inward:

```text
presentation / HTTP
        │
        ▼
application composition        modules ──► provider tools
        │                         │
        ├─────────────────────────┘
        ▼
business core ◄──────── ports
        │
        ▼
database adapter

configuration is read at composition boundaries and by infrastructure adapters
```

## Workspace packages

### `@assistant/config`

Owns the environment schema, defaults, module parser, and platform production validation. It has no
workspace dependencies and knows no individual module: readiness and module-specific production
rules live with each module. New settings must be added here and to `.env.example`; apps should not
invent their own service variables.

### `@assistant/db`

Owns Drizzle schemas, entities, migrations, and seed reconciliation. It depends only on config and
third-party persistence libraries. Seed identity now comes from the central configuration contract.

### `@assistant/core`

Owns workflows, approvals, memory, missions, schedules, costs, model routing, and domain policies.
It may depend on config and database ports/adapters, but never on apps or provider tools.

Some core functions still use the concrete Drizzle adapter. Replacing those imports with repository
ports is a safe incremental migration; it is not required to add a new UI or provider.

### `@assistant/application`

Owns UI-facing use cases and serializable view models. It composes core workflows with database
queries so presentation code asks for a chat view, import overview, approval inbox, or dashboard
presence rather than assembling tables, joins, and policy decisions. Large features are separated
into query and command modules.

### `@assistant/tools`

Owns the tool registry, risk dispatcher, storage adapters, and provider capabilities. It may depend
on core contracts and the database. Provider-specific installation does not happen here; functions
only register a capability when called by the agent composition root.

### `@assistant/modules`

Owns the module contract and every module. `src/contract.ts` defines the plain-data half — name,
owned settings, readiness, production rules, infrastructure, billing, navigation, code jobs, and
route declarations (webhooks with a closed auth union, internal routes) — and `src/platform.ts`
the runtime half: the context a module receives, the definition it returns, and the hook surface
(`ModuleHooks`) it can plug into the running agent — webhook and internal-route handlers, sweep
steps, poller ticks, deterministic task handlers, a delivery channel, an owner-notifier port, and
inbound-email observers. `src/registry.ts` lists the metadata, `src/diagnostics.ts` derives
readiness and validation from it, `src/plan.ts` derives the deployment plan, `src/install.ts`
installs and aggregates hooks (validating at boot that meta-declared routes and runtime handlers
agree), and `src/compose.ts` declares a composition. Each `src/<name>/` directory holds one
module's `meta.ts`, `module.ts`, and any behavior it owns (the google module's mail sync and email
channel, the sms module's channel, the watches module's matching).

Hooks receive invocation-time `ModuleServices` rather than richer `create()` context because the
tool dispatcher can only exist after every module has registered its tools. Modules never import
each other: cross-module needs flow through platform ports — the sms module *provides* the
`OwnerNotifier`, google and watches consume it; watches observes google's inbound mail through the
email-observer port and polls owner-defined web watches through a sweep step. The mounters in the
agent apply transport-level route auth (Google OIDC,
Twilio signature) from the closed union in the meta before any module handler runs; `oneShotToken`
routes are the exception — the mounter runs no auth for them, and the per-launch token carried in
the request body is validated inside the handler itself.

Two entry points: `@assistant/modules/meta` reaches only plain data, so the web app, scripts, and
diagnostics import it without pulling provider code into their bundles; `@assistant/modules` adds
the runtime and is for the agent composition root and `assistant.config.ts` alone. The package may
depend on config, core, db, and tools, and nothing may depend on it except the composition root and
metadata consumers.

### `@assistant/agent`

This is the composition root. `src/deps.ts` creates shared infrastructure and calls
`installModules`, which installs only the capabilities named by `ASSISTANT_MODULES`. HTTP routes
authenticate and translate requests; they should not contain business policy.

### `@assistant/web`

Next.js is a presentation and HTTP adapter. Client components accept serializable props and invoke
server actions. Pages, actions, and routes call a bound application facade; only
`apps/web/lib/server.ts` may import concrete database, model-router, and workspace adapters.

### `workers/*`

Browser, code, and document processing are independent deployable packages. They receive bounded job
input and never import the agent, web app, database package, or provider clients.

## Enforced boundaries

`pnpm check:boundaries` fails when:

- a client UI component imports server/business infrastructure;
- a web file imports module runtime code instead of `@assistant/modules/meta`;
- any web file outside the server composition root bypasses `@assistant/application`;
- config depends on another workspace package;
- db depends on core/tools/apps;
- core depends on tools/apps;
- application depends on tools/apps or leaks persistence into migrated UI features;
- tools acquires an unsupported workspace dependency;
- modules acquires a workspace dependency outside config, core, db, and tools;
- one module imports a sibling module instead of a platform port;
- the composition file moves out from under one of its importers, or the agent image stops
  copying it.

The check runs as part of `pnpm lint` and CI.

## Composition

`assistant.config.ts` at the repository root declares what an installation is made of:

```ts
export default defineAssistant({
  modules: [googleModule, searchModule, remindersModule],
});
```

The agent imports it, so it is the one file to edit when adding or removing a capability, and
`pnpm modules:plan` derives the worker images, infrastructure, and billing from it. It is agent
source despite living at the root: `infra/docker/agent.Dockerfile` copies it into the build, and
`pnpm check:boundaries` fails if that COPY is ever dropped.

`ASSISTANT_MODULES` narrows the composition at runtime for a container that should start with less
than it was built with. It cannot widen it — a module absent from the file has no definition to
install, and naming it in the environment logs a warning rather than silently doing nothing.

## Adding a module

1. Add the module name to `packages/config/src/modules.ts` and any new settings to the central
   schema and `.env.example`.
2. Create `packages/modules/src/<name>/meta.ts` declaring the settings it owns, its readiness
   check, any production rules, its infrastructure, its billing, and any code jobs it owns.
3. Create `packages/modules/src/<name>/module.ts` with `defineModule`, registering its tools on
   the registry it is handed and returning whatever the composition root must hold onto — plus
   `hooks` for any webhooks, internal routes, sweep steps, poller ticks, task handlers, channels,
   or observers it owns (declare routes in the meta too; boot validation keeps the two in step).
4. Add its metadata to `assistantModuleMetas` in `packages/modules/src/registry.ts`, export the
   definition from `packages/modules/src/index.ts`, and add it to `assistant.config.ts`.
5. Document its credentials, infrastructure, side effects, and removal behavior.

Nothing else changes: readiness diagnostics, production validation, navigation, worker image
selection, the deployment plan, route mounting, sweep scheduling, task routing, and channel
delivery are all derived from metadata and hooks. No module requires a conditional inside the
planner, business workflow, or agent app — a module that owns code jobs declares them in metadata
so a job queued before the module was removed completes benignly, and a module's external webhook
routes answer 404 the moment the configuration disables it. Internal scheduler routes are the
deliberate exception: `/internal/gmail/sync` answers `200` with a `{ skipped: true }` body when the
module or the `GMAIL_SYNC_ENABLED` setting is off, so the every-minute scheduler job stays green
instead of alerting on a 404. Absence from the tool registry is the capability boundary. The two
remaining agent-owned webhooks are `/webhooks/location` (platform HMAC ingest) and
`/webhooks/canaries/browser`; the browser canaries themselves import the module barrel
(`@assistant/modules`) rather than being platform-native.

## Configuration lifecycle

`.env` is the local source and is never committed. Cloud deployments copy sensitive values into
Secret Manager and non-sensitive values into the Cloud Run revision environment. Both surfaces use
the exact schema names from `@assistant/config`.

`loadConfig()` validates once and caches per process. Tests call `resetConfigForTest()` when they
need a different environment. Production starts fail-fast only for settings that would make a cloud
runtime broken; optional providers may stay unavailable and are reported by `pnpm config:check`.
