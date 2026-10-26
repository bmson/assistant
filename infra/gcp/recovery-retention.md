# Temporary recovery retention

`cleanup-current.py` optionally reads the fixed file
`infra/gcp/recovery-retention.json`. The file is absent by default, preserving
the existing current-only cleanup plan. It is a temporary, reviewed exception
for exact recovery artifacts; it cannot select tags, patterns, or an open-ended
policy. Remove the file after recovery, and set `expiresAt` no more than seven
days ahead.

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
retain exact supporting image digests. Each revision must be an exact existing
revision for its component, and its immutable service image must appear in that
component's configured digest entry. Every digest and revision is checked against live Artifact Registry
and Cloud Run inventory before a cleanup plan is printed or any deletion can
begin. A missing, mismatched, ambiguous, expired, malformed, or out-of-scope
entry stops cleanup. The cleanup retains allowlisted images and their OCI
metadata, and excludes allowlisted revisions from deletion. Apply re-reads the
configuration and live inventory before mutation.

The fields bind the temporary exception to its source, configuration proof,
expiry, and accepted recovery procedure. They do not themselves establish that
an image is known-good or that a procedure has been accepted. Before routing
any candidate traffic or resuming ordinary writes, operators must have an
actually compatible retained guarded pair and an accepted recovery procedure.
A build from the same source is not a known-good recovery. Binder writes remain
forbidden until the old strict parsers have been retired.
