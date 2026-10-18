# Operations

## Health endpoints

- `GET /health` on the agent is a liveness probe and does not touch dependencies.
- `GET /ready` on the agent checks PostgreSQL and reports secret-safe module readiness.
- `GET /api/health` on the web reports the released commit.
- `GET /api/ready` on the web checks PostgreSQL and returns 503 when traffic should stop.

Container and Cloud Run probes should use readiness endpoints. Alert on sustained 5xx responses,
queue age, tasks in `needs_attention`, expired approvals, webhook rejection rates, and budget
exhaustion. OpenTelemetry can be enabled centrally with `OTEL_EXPORTER=otlp`.

## Monitoring and alerting

`infra/gcp/deploy.sh` provisions a baseline automatically: a log-based metric
(`assistant-error-logs`) counting error-severity entries from every `assistant-*` service and job,
an email notification channel to `OWNER_EMAIL`, and an "Assistant error burst" alert policy
(more than 5 error logs in 5 minutes). The policy is created once and then left alone, so
threshold tuning in the console survives redeploys.

Traces cover model calls (`model.generate`/`model.step`/`model.object`), task execution
(`task.execute`), individual tool executions (`tool.execute`, with tool name, task, and step
attributes), and the nightly self-maintenance jobs. Locally, `OTEL_EXPORTER=console` prints spans
to stdout; `OTEL_EXPORTER=otlp` exports over OTLP/HTTP to whatever `OTEL_EXPORTER_OTLP_ENDPOINT`
points at.

## Releases

`bash infra/gcp/release.sh` is the source of truth: build all images, back up the database,
migrate, roll out, verify. Two sanctioned shortcuts exist for iteration:

- `bash infra/gcp/release-fast.sh [web|agent]` builds one image and rolls out one service,
  skipping the backup, migration, and unrelated images. Only safe when the change cannot have
  touched the schema, seed data, or environment.
- `SKIP_BACKUP=true bash infra/gcp/release.sh` runs a full release without the pre-migration
  backup — for code-only changes when a same-day loop feels the extra minute.

## Live verification scripts

Two scripts prove end-to-end behavior against a real database with real model calls (they cost
OpenRouter credit), useful after a deploy or a risky change:

- `pnpm tsx scripts/verify-browse.ts [--prod]` enqueues a read-only browse task and watches it run
  through plan → browser job → callback → answer.
- `pnpm tsx scripts/verify-goal-session.ts ["goal description"]` runs one scheduled goal work
  session through the real executor and prints every tool call it made, then cleans up after
  itself.

## History retention

Messages, tool calls, model calls, and cost events are kept forever by default. To bound them, set
`HISTORY_RETENTION_DAYS` (minimum 30) and `COST_RETENTION_DAYS` (minimum 60 — budget caps count a
rolling month of spend, so pruning inside that window would quietly raise the limit). The sweep
prunes in batches of 1000 per run, so a large backlog drains gradually. Two kinds of rows outlive
their cutoff by design: messages anchoring a conversation-segment summary (the recall unit
references them), and tool calls still referenced by an approval or a retained cost event.

## Location context (owner Shortcut)

The owner's phone POSTs an HMAC-signed location ping to `/webhooks/location`, keyed by the shared
`LOCATION_PING_SECRET`. Ingest is off entirely when no secret is configured. The signature covers
only the request body, so the body **must carry a `capturedAt` field** — an ISO-8601 timestamp of
when the reading was taken — for the ping to be accepted. This is the replay guard: without it a
captured signed body could be re-sent hours later and re-assert a stale location as current, so a
ping with no `capturedAt` is rejected `409 stale ping` (fail closed), as is one whose `capturedAt`
is outside the ±5-minute skew window.

When building the owner's iOS Shortcut:

1. Compute the JSON body with the live reading, e.g.
   `{ "lat": 64.1466, "lng": -21.9426, "label": "Reykjavík", "capturedAt": "<Current Date, ISO 8601>" }`.
   Use the Shortcut's *Format Date* action with the ISO 8601 preset for `capturedAt` — do not
   hardcode it.
2. HMAC-SHA256 the exact body bytes with `LOCATION_PING_SECRET`, hex-encoded, into the
   `X-Signature` header.
3. POST to `https://<PUBLIC_URL>/webhooks/location`.

A `409` response means the Shortcut's clock or its `capturedAt` value drifted past the skew window;
a `403` means the signature (and therefore the secret) is wrong.

### Native iOS app

The iOS app posts the same ping shape to `POST /api/mobile/v1/location` on the web service instead,
authenticated with its existing mobile access key rather than the HMAC secret — no second credential
is installed on the phone. Pings carry the device's IANA time zone (`timeZone`) alongside `lat`/`lng`,
so the ambient prompt line can anchor the owner's clock while traveling. Sharing is off by default and
owner-gated (More → Assistant context → Share iPhone location). On connect and foreground, the app
collects two consistent fixes at least two seconds apart, stopping within 12 seconds; it rejects
cached samples older than 30 seconds and accuracy worse than 200 metres. Uploads remain throttled
to 15 minutes. Background monitoring remains paused, and older installations clear the previous
background-monitoring preference at launch. A separate **Generic arrival nudges** option is available
under the same location-sharing setting. It uses foreground pings only, requires a new-place stop to
remain stationary for three minutes, and creates at most one generic owner-day task. The task stores
only an opaque owner-scoped ping reference that expires after five minutes; the runner checks it before
dispatch and delivery, uses a fixed location-free message without a model or location tools, and clears
the reference and instruction at completion. If the reference expires first, the task is cancelled.
Pings still follow the configured retention period. Current-location answers requested by the owner
continue to use the bounded foreground flow.

Location retention is separate from freshness: observations expire as current context after 30
minutes. A newer ping invalidates cached location/weather context, and uncertain fixes never cause
a fallback to an older place. Prompts include accuracy and age and must not infer presence inside a
venue; unknown accuracy or an observation over five minutes old requires confirmation for nearby picks.

## Release artifacts

CI scans every selected container for HIGH/CRITICAL vulnerabilities, generates an SPDX JSON SBOM,
uploads SBOMs as workflow artifacts, and attaches keyless Cosign signatures and SBOM attestations to
the immutable image tags. Browser, code, and processor images are built only when their modules are
selected.

Verify a released image with Cosign:

```sh
cosign verify \
  --certificate-identity-regexp='https://github.com/ORG/REPO/.github/workflows/deploy.yml@refs/heads/main' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  REGION-docker.pkg.dev/PROJECT/REPOSITORY/agent:COMMIT_SHA
```

Dependency and action updates are proposed weekly through Dependabot. CI still runs audit, boundary,
type, test, build, and browser-smoke gates before deployment.
