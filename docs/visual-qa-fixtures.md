# Visual QA fixture lifecycle

The visual QA writers use an allocator-owned local PostgreSQL database. Each
run writes a private manifest under `/tmp/assistant-visual-qa-runs` before its
first database mutation. The manifest records the database allocator identity,
owner ID, fixture kind, exact row IDs, and a `visual-qa:<run-id>:` provenance
prefix. A normal owner database or remote database is rejected by the shared
target validator.

Writers do not remove prior rows before seeding. Cleanup is a separate,
reviewable operation and requires the same still-owned allocator target and
the printed run ID:

```sh
pnpm visual-qa:cleanup <run-id>
```

Run that command in the environment that holds the allocated target's URL,
token, and private target marker. The cleanup utility checks all three against
the database sentinel and run manifest before deleting anything.

The cleanup command deletes only the IDs in that run's manifest, after checking
the stored owner and fixture-specific markers again. Rows whose identity has
changed stop cleanup rather than being guessed at. It leaves the primary
conversation itself in place. The manifests and append-only event log record
planned, seeded, completed, failed, and cleaned states, so an interrupted run
can be reconciled later without broad table cleanup.

Synthetic QA messages use `channelMessageId` values beginning with
`visual-qa:`. Automatic history recall, conversation search, embedding
backfill, and segmentation exclude those tagged messages; ordinary owner rows
remain eligible. The QA writers do not invoke generation providers. This local
protection does not qualify a live service, production database, or external
provider workflow.
