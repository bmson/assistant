# Optional modules

This is a capability guide, not a deployment receipt. Current driver, queue, auth, provider, and
activation boundaries are summarized in the [runtime support matrix](runtime-support-matrix.md).
The effective module list comes from `ASSISTANT_MODULES` and the installed module composition;
repository defaults do not identify a deployed installation.

The base assistant is always installed: chat, memory, contacts, occasions, goals, missions,
approvals, schedules, cost controls, and workspace access.

Set optional capabilities once in `.env`:

```dotenv
ASSISTANT_MODULES=minimal
ASSISTANT_MODULES=all
ASSISTANT_MODULES=calendar,google,reminders,search
```

Run `pnpm config:check` after any change.

| Module | Adds | Required settings | Extra runtime |
| --- | --- | --- | --- |
| `browser` | Planned web interaction and browser execution | `PROFILE_ENC_KEY` only for a saved profile | Playwright locally or a Cloud Run Job |
| `calendar` | Read-only Google Calendar availability, calendars, and events (Firestore portable) | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `BOT_GOOGLE_REFRESH_TOKEN` | none |
| `calls` | Approved phone calls the assistant holds live (discloses it is an AI), with mid-call check-ins | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or `TWILIO_VOICE_FROM_NUMBER`), a voice model chosen in Settings → AI providers; `pnpm setup:phone` does all of it | Twilio webhooks + a WebSocket on the agent |
| `code` | Sandboxed code execution | none | local child process or a Cloud Run Job |
| `documents` | Office/PDF ingestion pipeline | none | document processor locally or a Cloud Run Job |
| `google` | Gmail, Calendar, Drive, Docs, Sheets, Slides, job confirmations, forwarded-mail ingest | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `BOT_GOOGLE_REFRESH_TOKEN`; `EMAIL_INGEST_MODE` for forwarded-mail ingest, with `EMAIL_INGEST_IMPORTANCE_THRESHOLD`, `EMAIL_INGEST_MAX_TRIAGE_PER_DAY` and `EMAIL_OUTBOUND_DOMAINS` | Gmail Pub/Sub and Scheduler in production |
| `maps` | Directions, travel times, and route maps (Apple Maps Server API) | `MAPKIT_KEY_ID`, `MAPKIT_TEAM_ID`, `MAPKIT_PRIVATE_KEY`, or none when the `APNS_*` key has MapKit enabled | none |
| `push` | APNs owner channel (proactive notices and approval pings to the iOS app) | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID` | none |
| `reminders` | Reminder create/list/cancel tools | none | none |
| `search` | Link-returning web search | `SEARCH_PROVIDER`, `SEARCH_API_KEY` | provider API |
| `sms` | Twilio owner channel and approval replies | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`; plus `OWNER_PHONE` for the owner channel | Twilio webhook |
| `watches` | Durable inbox/content watches | none | none |

## Module behavior

A selected module can be either ready or unavailable. For example, selecting `google` without a
refresh token keeps the tools unregistered and prints one startup warning. This makes initial setup
recoverable while keeping an unavailable provider out of model tool selection. An unavailable
module's routes, sweep steps, and channels still mount — each self-guards on its own
configuration — so credentials can arrive later without a redeploy changing which URLs exist.

A module's behavior lives with the module, not the agent: mail sync, the email channel, and
application confirmations in `google/`; the SMS channel (inbound webhook, owner notifier,
delivery) in `sms/`; inbox-watch matching in `watches/`. The agent mounts what modules declare —
webhooks (with platform-applied auth), internal routes, sweep steps, poller ticks, and
deterministic task handlers — and composes their channels into the executor. Two webhooks remain
agent-owned: `/webhooks/location` (platform) and `/webhooks/canaries/browser` (canaries).

A disabled module is a hard gate:

- its tools are absent from the registry;
- channel clients receive no credentials;
- Gmail sync is disabled even if `GMAIL_SYNC_ENABLED=true`;
- its public integration webhook returns 404;
- document processing is not launched;
- production canaries reject a configuration missing their required modules.

## Suggested profiles

Minimal private chat:

```dotenv
ASSISTANT_MODULES=minimal
```

Firestore assistant with portable reminders and Calendar reads:

```dotenv
PERSISTENCE_DRIVER=firestore
ASSISTANT_MODULES=calendar,reminders
```

Calendar event creation, updates, cancellations, Gmail, and the other Workspace tools remain in
the SQL-backed `google` module. Reminder schedules use Firestore storage. Other optional modules
still require persistence ports that have not migrated.

Productivity assistant without isolated workers:

```dotenv
ASSISTANT_MODULES=google,reminders,search,watches
```

Full installation:

```dotenv
ASSISTANT_MODULES=all
```

Tool capabilities are exposed through provider-specific package subpaths. Deployment derives a
runtime image plan from this same setting: `browser`, `code`, and `processor` images and Cloud Run
Jobs are built/provisioned only when their corresponding modules are enabled. A later module change
needs configuration and deployment, not a different fork.
