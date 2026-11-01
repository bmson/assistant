# Temporary recovery retention

`cleanup-current.py` optionally reads the fixed file
`infra/gcp/recovery-retention.json`. The file is absent by default. When
present, it names a short-lived, exact recovery set; it cannot select tags,
patterns, or an open-ended policy. Remove it after recovery and set
`expiresAt` no more than seven days ahead.

The accepted JSON shape is:

```json
{
  "schemaVersion": 1,
  "project": "bmson-assistant",
  "region": "us-west1",
  "repository": "assistant",
  "expiresAt": "<RFC3339 timestamp with timezone, at most seven days ahead>",
  "sourceSHA": "<40 lowercase hex characters>",
  "configProof": "sha256:<64 lowercase hex characters>",
  "procedureReference": "<reference to the accepted recovery procedure>",
  "images": {
    "agent": ["us-west1-docker.pkg.dev/bmson-assistant/assistant/agent@sha256:<64 lowercase hex characters>"],
    "web": ["us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:<64 lowercase hex characters>"]
  },
  "revisions": [
    "projects/bmson-assistant/locations/us-west1/services/assistant-agent/revisions/<exact agent revision>",
    "projects/bmson-assistant/locations/us-west1/services/assistant-web/revisions/<exact web revision>"
  ]
}
```

The `agent` and `web` entries each require exactly one digest and exactly one
matching revision. Optional `browser`, `code`, and `processor` entries may
retain exact supporting image digests. Each revision must exist in the owned
Cloud Run service inventory, and its immutable image must match the exact
component digest in the file. Every digest is checked against Artifact Registry
before a plan is printed. A missing, mismatched, ambiguous, expired, malformed,
or out-of-scope entry stops cleanup. The cleanup retains allowlisted images and
their OCI metadata, and excludes allowlisted revisions from deletion. Apply
re-reads the file and the live inventory before mutation.

This retention is separate from keeping revisions reachable through current
Cloud Run traffic tags or URLs. It does not establish that an image is known
good or that a procedure has been accepted. Before routing candidate traffic or
resuming ordinary writes, operators still need an actually compatible retained
guarded pair and an accepted recovery procedure. A build from the same source is
not a known-good recovery. No active retention configuration is included.
