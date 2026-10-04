# Assistant

A self-hostable personal assistant platform. The assistant has its own identity, can work across
multiple channels and services, runs durable long-horizon tasks, and requires approval before an
outward-facing action.

The repository is a small pnpm monorepo with one typed configuration package and optional capability
modules. A minimal installation needs PostgreSQL and one model gateway key; Google Workspace,
Twilio, search, browser automation, code execution, and document processing can be enabled
independently.

## Quick start

Requirements: Docker Compose and, for model-backed chat, an
[OpenRouter API key](https://openrouter.ai/settings/keys).

```sh
docker compose up --build
```

Open `http://localhost:3000`. The migration job creates the schema and seed data before the web and
agent start. Ports bind to loopback only, and the default Compose profile enables the auth bypass
only inside this local stack.

For a personalized configuration, install Node.js 22+ and pnpm 10+, then:

```sh
corepack enable
pnpm install
pnpm setup -- --owner-name="Your name" --owner-email=you@example.com --assistant-email=assistant@example.com
# Add OPENROUTER_API_KEY to .env.
pnpm config:check
pnpm up
```

For source development rather than containers, run `docker compose up db`, then `pnpm db:migrate`,
`pnpm seed`, and `pnpm dev`.

## Native iOS app

The SwiftUI client lives in `apps/ios` and uses the same server-owned chat, task, goal, memory, and
approval workflows through the versioned mobile API. The browser currently exposes owner pairing,
security, and read-only audit; retained everyday browser product pages redirect to Settings.
Open `apps/ios/Assistant.xcodeproj` in Xcode 26 or newer and run
the `Assistant` scheme on an iPhone or Simulator.

For local source development, connect the app to `http://localhost:3000`; the explicit development
auth bypass is sufficient. For a deployed server, open **Settings → Mobile app** in the web UI:
it shows the server URL and a masked access key, and can generate or rotate the key in one click.
The key is revealed once at rotation — copy it into the app's Connection screen, where it is
stored in the iOS Keychain. See [the iOS setup guide](apps/ios/README.md).

## Choose capabilities

The base platform always includes chat, memory, goals, missions, approvals, schedules, and the local
workspace. Optional modules are composed in `assistant.config.ts`:

```ts
export default defineAssistant({
  modules: [googleModule, remindersModule, searchModule],
});
```

That one file decides what is installed, which worker images are built, and what is provisioned.
`pnpm modules:plan --billing` prints what a given selection costs, separating services that bill
directly from the Google Cloud resources each module adds.

For a container that should start with less than it was built with, narrow it at runtime:

```dotenv
ASSISTANT_MODULES=google,reminders,search
```

Use `all`, `minimal`, or a comma-separated subset of:

```text
browser, code, documents, google, reminders, search, sms, watches
```

Disabled modules are not registered with the agent, and their webhooks/background sync paths stay
inactive. `pnpm config:check` reports each selected module as ready or names its missing settings
without printing secrets. See [module reference](docs/modules.md).

## Architecture

```text
apps/web ─ packages/application ─┐
                                ├── packages/core ── packages/db
apps/agent ─── packages/tools ───┘
     │
     └── optional isolated workers

all processes ── packages/config ── .env / Cloud Run environment
```

- `packages/config` — the only application/service configuration schema
- `packages/application` — UI-facing use cases and persistence-independent view models
- `packages/core` — business rules and durable workflows
- `packages/db` — PostgreSQL adapter, schema, migrations, and seed data
- `packages/tools` — risk-gated capability adapters and registry
- `apps/agent` — HTTP ingress and module composition root
- `apps/web` — Next.js dashboard and server-side presentation adapter
- `workers/*` — credential-minimized browser, code, and document jobs
- `infra/*` — container and Google Cloud Run deployment

All web pages, actions, and API routes execute through application use-cases. Only
`apps/web/lib/server.ts`, the server composition root, may construct database, model, or workspace
adapters. CI enforces this with `pnpm check:boundaries`; see [architecture](docs/architecture.md).

## Configuration

All application settings, service credentials, identity values, feature selection, and driver
choices are documented in [`.env.example`](.env.example) and validated by `@assistant/config`.
Deployment stores secrets in Google Secret Manager but injects the same variable names, so local and
hosted installations use one contract.

Important identity settings are seeded on first boot:

```dotenv
ASSISTANT_NAME=Assistant
ASSISTANT_EMAIL=assistant@example.com
ASSISTANT_WORKSPACE_ID=assistant
ASSISTANT_TIMEZONE=UTC
OWNER_EMAIL=you@example.com
OWNER_NAME=Your name
```

Keep `ASSISTANT_EMAIL` and `ASSISTANT_WORKSPACE_ID` stable after the first seed because they identify
durable database and storage records.

## Google Cloud Run

The provisioner is idempotent and reads installation-specific values from `.env`; the project,
region, repository, custom domain, identity, and modules are no longer hard-coded.

```sh
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Guided setup: preflight checks, what it contains, what it costs, then deploy.
pnpm setup:wizard --plan   # briefing only
pnpm setup:wizard

# In .env, set at least:
# PROD_DATABASE_URL, OPENROUTER_API_KEY, GCP_PROJECT,
# OWNER_EMAIL, ASSISTANT_EMAIL, and Google OAuth values for web login.

bash infra/gcp/deploy.sh
```

The script provisions Secret Manager, least-privilege service accounts, Cloud Run services/jobs,
Cloud Tasks, Scheduler, Pub/Sub, and storage. Optional Gmail scheduling and Pub/Sub are skipped when
the `google` module is disabled. Worker images and resources are also skipped when their modules are
disabled. Normal releases use `bash infra/gcp/release.sh`, which backs up the database before
migrating. Day-to-day iteration on a single service has a faster path that skips the backup,
migration, and unrelated images:

```sh
bash infra/gcp/release-fast.sh web    # or: agent
```

Use it only when the change cannot have touched the schema, seed data, or environment —
`release.sh` stays the source of truth for everything else. `SKIP_BACKUP=true bash infra/gcp/release.sh`
skips just the pre-migration backup for a full release where only code changed.

See [self-hosting on Cloud Run](docs/self-hosting.md) for the exact prerequisites and post-deploy
OAuth steps.

## Development

```sh
pnpm test             # unit and integration tests (recreates an isolated *_test database)
pnpm lint             # Biome plus architecture boundaries
pnpm typecheck        # every workspace package
pnpm build            # production builds
pnpm format           # format the repository
pnpm config:check     # safe configuration/module diagnostics
pnpm audit:llm        # review captured model output for defects
pnpm db:generate      # generate a migration from schema changes
pnpm db:migrate
pnpm seed
```

## Security model

Autonomous work is limited to the assistant's own accounts and public reads. Sending email, inviting
people, messaging non-owners, browser form entry, uploads, and submission require owner approval.
The policy is enforced in code and every tool call records its risk and approval provenance.

Isolated browser, code, and document workers receive purpose-limited job input and storage access,
not the main database or provider credentials. Production internal callbacks use route-scoped Google
OIDC; the shared-secret mode exists only for local development.

## Further documentation

- [Complete documentation index](docs/README.md)
- [App intent and every page](docs/product-guide.md)
- [Architecture and implementation review](docs/architecture-review-2026-10-02.md)
- [Design system and guidelines](docs/design-system.md)
- [Model evaluation and current OpenRouter costs](docs/model-evaluation.md)
- [System architecture, technologies, and decisions](docs/system-reference.md)
- [Capabilities, integrations, and complete tool catalog](docs/capability-reference.md)
- [Product gaps and completion criteria](docs/product-gaps.md)
- [Architecture and package boundaries](docs/architecture.md)
- [Optional modules and settings](docs/modules.md)
- [Self-hosting on Google Cloud Run](docs/self-hosting.md)
- [Operations and supply-chain verification](docs/operations.md)
- [Backup, restore, and migration safety](docs/recovery.md)
- [Google OAuth setup](infra/gcp/oauth-setup.md)
- [Complex workflow test matrix](docs/complex-workflow-test-matrix.md)
- [Reviewing what the models said](docs/llm-output-review.md)
- [Anticipation layer](docs/anticipation-layer.md)
- [Long-running chat memory](docs/long-running-chat-memory.md)
- [Memory supersession](docs/memory-supersession.md)
- [Temporal validity](docs/temporal-validity.md)
