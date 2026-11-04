# Platform review: from standalone assistant to composable platform

An architecture and developer-experience review of the proposed shift to a composable plugin
platform: strict UI/core separation, every capability a zero-effort plugin, near zero-config
onboarding through one composition file, Google Cloud as the primary runtime, and a deployment
wizard that provisions infrastructure and explains billing. The review is grounded in the code as
of "Platformize assistant architecture and deployment" (#14).

## Verdict

The vision is feasible because roughly seventy percent of it is already built. The productive
framing is not "convert a standalone bot into a platform" but "close four specific gaps in an
already-platform-shaped codebase":

| Vision pillar             | Current state                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Strict UI/core separation | **Done.** Layered packages with CI-enforced boundaries (`scripts/check-boundaries.ts`) |
| Composable plugins        | **Partial.** Eight env-selected, hard-gated modules; no module contract type           |
| One-file onboarding       | **Not built.** The only composition lever is the `ASSISTANT_MODULES` string            |
| Wizard + billing clarity  | **Embryonic.** Idempotent gcloud bash provisioner; no cost documentation at all        |

## 1. Architecture feedback

### What already meets the vision

- Presentation is genuinely isolated: only `apps/web/lib/server.ts` may construct concrete
  adapters, and `pnpm check:boundaries` fails CI on violations.
- Modules are already hard gates (`docs/modules.md`): a disabled module's tools are absent from
  the registry, its webhooks return 404, its worker images are not built, and production
  canaries reject configurations missing required modules.
- The per-tool security contract (`packages/tools/src/types.ts`) — `AssistantTool` with dynamic
  risk tiers plus `ToolFlags` (taint-based registry stripping, autonomy floor, budget
  reservation before execution) — is the strongest asset in the codebase and must survive any
  plugin model unchanged.
- Deployment is already module-aware: `scripts/module-plan.ts` gates which worker images CI
  builds, and `infra/gcp/deploy.sh` skips resources for disabled modules.

### The hurdles, in priority order

1. **There is no module contract.** The module "registry" is a `z.enum` name tuple
   (`packages/config/src/modules.ts`); registration is fourteen bespoke
   `registerXTools(registry, bespokeDeps)` functions with five different import-subpath shapes.
   A module contributes across up to seven surfaces — tools, long-lived clients on `AgentDeps`,
   public webhooks, internal routes, poller ticks, a worker image, and web nav gating — so
   adding one touches roughly sixteen files, not the seven steps `docs/architecture.md`
   describes. (The module contract this review proposes has since landed: those per-module
   clients now reach consumers through `InstalledModuleSet.requireExports`, not bespoke fields
   on `AgentDeps` — see `docs/architecture.md`.)

2. **The two hardest couplings are not tool registration.** First, the `loadConfig()` process
   singleton is reached ad hoc, including inside core:
   `packages/core/src/memory/jobs.ts` gates `documents.*` jobs on module state, violating the
   repository's own rule that no module conditional lives inside business workflow. Second,
   roughly two thousand lines of module-owned behavior (`email-sync.ts`, `sms-channel.ts`,
   `email-channel.ts`, `watches.ts`, `application-confirmations.ts`) live in `apps/agent/`,
   and `executor-deps.ts` hardcodes per-task-type notification delivery. A module contract
   without a `channels` surface leaves the google and sms modules half-extracted.

3. **Configuration is centralized by design, and that property is worth keeping.** The 63-key
   flat schema in `packages/config` maps one-to-one to Secret Manager names. First-party
   modules should therefore _pick_ the keys they own (declared metadata: `configKeys`,
   readiness, production problems) rather than extend the schema. Schema extension with
   namespaced keys is a third-party-plugin feature, deferred until that phase.

4. **Infrastructure has a second source of truth.** `infra/gcp/deploy.sh` reimplements the
   module parser in bash with divergent semantics: empty `ASSISTANT_MODULES` means "all" in
   bash but minimal in TypeScript, and unknown names are silently ignored where the schema
   rejects them. Modules must declare their infrastructure needs (worker image, APIs, secrets,
   scheduler jobs, Pub/Sub topics) in one manifest that scripts and deployment consume.

5. **The security model versus "zero-effort third-party plugins" is the central tension.**
   `ToolFlags` are self-declared and enforced by the dispatcher — a malicious plugin can simply
   lie about `outwardFacing` or `networkEgress`. There is no sandbox, and pretending otherwise
   is worse than nothing. The honest trust boundary: no runtime plugin loading, ever. A plugin
   is an ordinary npm dependency compiled into the owner's image — reviewed via lockfile,
   captured by the Syft SBOM, covered by the Cosign signature — plus a one-time owner
   acknowledgment of each `package@version`'s declared capability fingerprint before its tools
   register.

6. **Cut "every part a plugin" at the web UI.** Next.js file-system routing makes
   module-shipped React pages the worst value-per-effort item in the vision. Modules should
   contribute navigation/gating metadata only; pages stay first-party, and
   `apps/web/lib/server.ts` remains a hand-bound facade.

## 2. Google Cloud recommendations

- **Keep Cloud Run** — services for web/agent, jobs for the credential-minimized workers,
  scale-to-zero minimums. This is already the right shape. One immediate win: deterministic
  Cloud Run URLs (`https://{service}-{projectNumber}.{region}.run.app`) eliminate the two-pass
  agent deploy in `deploy.sh` today, before any other change.
- **Infrastructure as code: Pulumi TypeScript with the Automation API**, scoped to the control
  plane only — API enablement, service accounts, IAM (including the conditional prefix grants,
  fixing the current remove-then-add flap), buckets, Cloud Tasks, Pub/Sub, Scheduler, Artifact
  Registry, and Secret Manager _containers_. The module manifest is TypeScript data that a
  Pulumi program consumes natively; `preview` gives the wizard a plan it can translate into
  plain language and cost notes; state lives in a GCS bucket; teardown comes for free.
  **Pulumi must never own images, service revisions, or secret versions** — the imperative
  `release.sh` rollout (backup → migrate gate → roll → health poll) stays, preventing IaC and
  the release pipeline from fighting over Cloud Run revisions. Terraform is acceptable but
  means generating HCL and parsing plan JSON from a second language; keeping bash forever
  fails the wizard requirement (no preview, no teardown, no drift detection).
- **Keep** Secret Manager (env-name parity is a real asset), Workload Identity Federation for
  CI, Artifact Registry, and bring-your-own PostgreSQL (Neon with pgvector) as the default —
  it is cheaper and simpler than Cloud SQL for this workload; a Cloud SQL path can be a later
  wizard option, not a requirement.
- **Billing clarity comes from the manifest, not from documentation.** Each module declares its
  cost surface — GCP services with free-tier notes, and external vendors (OpenRouter required,
  Neon, Twilio, search provider). The wizard renders this as a per-module billing table before
  provisioning, and can optionally create GCP Billing Budget alerts. Because the same manifest
  drives provisioning, the cost explanation cannot rot independently. Today the repository has
  no infrastructure cost documentation at all.
- **The wizard is CLI-first**, running under the user's own gcloud application-default
  credentials. The "Web UI" variant should be `--ui` serving a localhost page from the same
  CLI process — never a hosted provisioning service, which would require dangerous credential
  delegation. Preflight probes before any resource is touched: billing linked, org policies
  that break the design (`iam.allowedPolicyMemberDomains` blocks the `allUsers` invoker that
  `--allow-unauthenticated` needs), API enablement propagation.

## 3. Developer-experience critique

### The "barrel file" should be a typed composition file

A literal barrel of re-exports cannot carry options, ordering, or types. The proven shape
(Vite, Nuxt, Astro) is a typed config module:

```ts
// assistant.config.ts
import { defineAssistant } from '@assistant/modules';
import { google, reminders, search, sms, watches } from '@assistant/modules/all';

export default defineAssistant({
  modules: [google(), sms(), search(), reminders(), watches()],
});
```

The resolution strategy is the key decision: **only the agent imports this file** (an esbuild
alias plus one `COPY` line in the agent Dockerfile — the missing-COPY failure mode needs a CI
assertion). Composition is thereby baked into the signed image: unused modules are genuinely
tree-shaken out, and the SBOM/Cosign attestation covers exactly what runs. Scripts read the
file on the host via tsx/jiti and derive everything else from it. `ASSISTANT_MODULES` is
demoted from selector to _restrictor_ (effective = file ∩ env) so an environment variable can
never appear to enable code that was compiled out. When the file is absent, the default is all
in-repo modules, so existing installations stay green throughout the migration.

### "Zero-config" needs honest scoping

Some steps are irreducibly manual, and the worst DX failure mode is promising zero-config and
then hitting them unprepared: creating a billing account; the **OAuth consent screen and OAuth
client, for which no public API exists**; Google Workspace admin allowlisting; DNS at the
registrar. The wizard's job for these is a resumable checklist — probe, then auto-fix or guide,
then verify — extending the pattern `pnpm config:check` already established. Meanwhile, several
currently-manual steps are automatable and should be: enabling the six Workspace APIs
(Service Usage API), setting the Twilio number's SMS webhook (Twilio REST API), and re-syncing
secrets after `pnpm auth:bot` (today's instruction is "re-run deploy.sh").

### Remaining friction to design for

Version skew between the platform and plugin packages (peer dependencies on a types-only
`@assistant/plugin-kit`); org-policy denials halfway through provisioning (hence preflight and
resume); and trust through transparency — a `--plan` escape hatch that prints the preview and
the gcloud-equivalent operations the wizard is about to perform.

## 4. Roadmap: the first three steps

### Step 1 — Introduce the `ModuleDefinition` contract (pure refactor)

Create `packages/modules` with a per-module `meta.ts` / `module.ts` split — metadata is cheap
data importable by web, scripts, and the doctor; factories are imported only by the agent
composition root. The contract: `meta` (name, `configKeys` pick, readiness, production
problems, infrastructure needs, billing, nav metadata) and `create(ctx)` returning a runtime
(tools registered only through `ToolRegistry`; webhooks as a closed discriminated union with
**required** auth, applied by the platform mounter before any handler runs; job handlers;
sweeps and poller ticks; notification channels; canaries). Cross-module needs use typed
`exportsOf(definition)` rather than a god-context. Invert the in-core documents gate with a
job registry (unknown job completes benignly, preserving today's semantics for queued jobs).

Sub-stages with gates: **1a** metadata and diagnostics migration (gate: `pnpm config:check`
output byte-identical, `/ready` payload unchanged); **1b** one module per PR, google last
(gate: relocated webhook-auth/signature e2e tests green, plus contract conformance tests);
**1c** the manifest — `modules:plan` grows to emit images, APIs, secrets, scheduler jobs, and
billing lines, with a temporary TypeScript-versus-bash parity test across `ASSISTANT_MODULES`
values before the bash `module_enabled` logic is deleted. Target: adding a module drops from
roughly sixteen touch points to about four.

### Step 2 — The `assistant.config.ts` composition file

`defineAssistant` in `packages/modules`, the esbuild alias, the Dockerfile `COPY`, script
derivation, and restrictor semantics for the env variable. Gate: build an agent image with a
config file omitting `browser` and assert the bundle contains no launcher code (tree-shaking
proof), and that env-only enablement warns loudly instead of half-enabling. Do not reorder
this before step 1: composing today's inconsistent register functions would calcify them.

### Step 3 — Pulumi control plane and the wizard CLI

`infra/pulumi/` fed by the step-1c manifest; the wizard as a resumable step machine:
preflight → compose-and-explain (billing table) → provision (preview, confirm, apply) →
guided manual checklist with verification probes. `deploy.sh` is retained until one
fresh-project wizard installation passes the production canaries; wizard v1 targets fresh
projects, and existing installations keep `deploy.sh` until a `pulumi import` guide lands.

### Later phases

Third-party plugins via a types-only `@assistant/plugin-kit` with _required_ (non-defaulted)
security flags; owner capability-acknowledgment cards per `package@version`; namespaced plugin
configuration keys merged by `defineAssistant`.

## Verification

Lean on the nets already in place and extend them: per-module unit and e2e tests (webhook
auth, Twilio signatures, Google OIDC) move with their modules; `check:boundaries` gains three
rules (modules may not import each other except metadata; web imports only
`@assistant/modules/meta`; core never imports modules, and modules never import the
dispatcher); the `release.sh` health poll asserts module readiness from `/ready`, not just the
served SHA; canary definitions move onto the module contract so a converted module proves
itself in production.


## Implementation status

Steps one and two of the roadmap are implemented, and the wizard from step three is in place.

**Done.** `packages/modules` holds the module contract and all eight modules. Metadata is plain
data — owned settings, readiness, production rules, infrastructure, billing, navigation, code jobs
— so `@assistant/modules/meta` is importable by the web app, scripts, and diagnostics without
pulling provider code along. `installModules` replaced the hand-written if-chain, and
`apps/agent/src/modules.ts` is gone. Config no longer knows any individual module, and core no
longer knows that documents is one: `runCodeJob` asks the composition root whether a job's owning
module is installed. `assistant.config.ts` composes the installation, `ASSISTANT_MODULES` narrows
it at runtime and warns rather than silently failing when it names something absent, and
`pnpm modules:plan` derives worker images, APIs, topics, scheduler jobs, secrets, and billing from
the same file. The provisioner sources that plan instead of reparsing modules in bash, which also
turned a silently-ignored module typo into a loud failure and removed six manual API enablements.
`pnpm setup:wizard` runs preflight checks, explains composition and cost, lists only the manual
steps the composed modules actually need, and then runs the provisioner.

**Deliberately not done, with reasons.**

_Bundle-level tree-shaking._ Composition controls what is installed, built, and provisioned, but
not yet what is compiled: `apps/agent` still imports the `@assistant/tools` root barrel, which
pulls every provider in regardless. Measured on a build with browser and code removed from the
composition, the bundle shrank by 35 bytes. Removing that barrel import is the prerequisite.

_Relocating provider behavior._ Done in a follow-up refactor: the module contract gained a
runtime hook surface (webhooks with a closed auth union, internal routes, sweep steps, poller
ticks, deterministic task handlers, delivery channels, an owner-notifier port, and inbound-email
observers), and mail sync, the SMS and email channels, watches, and application confirmations all
moved into their modules behind narrow deps types. Modules may not import each other (enforced by
`pnpm check:boundaries`); cross-module needs flow through the ports. Canaries remain agent-owned —
the one recorded exception, alongside the platform's own `/webhooks/location`.

_Infrastructure as code._ `deploy.sh` remains the provisioner. Preview, teardown, and drift
detection are real gaps that Pulumi would close, but replacing working, idempotent provisioning
with a program that cannot be exercised against a real project is not an improvement. The module
manifest that a Pulumi program would consume now exists, so that work is unblocked whenever a
project is available to test against.
