# Qualified promotion of the Firestore API 3 pair

Run the protected build-only workflow once at the exact successful main commit, with
`components=full` and `persistence=firestore`. Retain the first-attempt run ID and the
agent, web, browser, code, and processor build receipts. That run must skip release.

Use the signed agent and web digests from that run in the approved `google-ai` provider
rehearsal. The independent reviewer binds the exact published digests and their
digest-preserving mirrors to the native service and revision observations. Review the staged
web-to-agent probe, the API 1 agent with the paused API 3 web, the separate parked-revision
creation and zero-percent startup tag, and the final alias-free, paused pair at Manual0.
Keep raw provider observations and private reviewer credentials outside Git and workflow inputs.

The reviewer signs the exact UTF-8 JSON observation payload with the Ed25519 key whose public
half is pinned in `api3-recovery-review-key.mjs`. Supply `api3_recovery_proof` as one JSON
object containing `payload` and `signature`, each encoded as unpadded base64url. The payload
fields and accepted observation values are defined by `validateRecoveryObservations` in
`api3-recovery-proof.mjs`. Its observation time must follow the last exact image build and
the review expires within 24 hours of that observation. Keep the private key with the
independent reviewer. Rotating the public key requires a reviewed source change.

For the protected compatible-OFF Firestore dispatch provide `prebuilt_run_id` from the successful
build-only run, `api3_recovery_proof`, and the existing reviewed bootstrap and compatible-OFF
inputs. The workflow checks the original GitHub run and role receipts, verifies the five
registry signatures for the exact source, skips the entire image matrix, and constructs the
production manifest from the five pinned digests. The synthetic rehearsal manifest is derived
from the exact source, build run, and web and agent parent digests. The production manifest
uses those same web and agent parent digests and the three signed worker digests.

Protected production owner readiness, index parity, backup, settlement, workflow holds, traffic
and release guards continue to apply. The first cutover keeps optional MCP sign-in off. A later
same-API compatible Firestore release can reuse the verified build-only run's artifacts through
`prebuilt_run_id` under the ordinary protected gates.

## Restore target for the archived API 1 pair

The opt-in path also reads a second signed envelope from `OWNER_RELEASE_RESTORE_TARGET_PROOF`. Its presence selects qualification for the archived original pair. Stage the reviewed pack and pinned Cosign executable as described in `owner-editor-release-inventory.md`. A signed restore review covers the verified first-attempt candidate build, its API 3 recovery review, the exact drained bootstrap, the original image and revision per role, and the independently observed recovery targets.

In the isolated rehearsal, import the two archived linux/amd64 children by digest, check each manifest and its config and layers, and start fresh, paused revisions under distinct UIDs. Exercise a failure before possible admission and a lost response after admission with delivery held. Retain the native readbacks for both cases. The independent reviewer signs the compact payload bytes prefixed with `owner-release-restore-target-v1` and one NUL byte. The protected transition rechecks both signatures, provider targets, and the native pair at each recovery checkpoint. The build run is known at review time. Each release decision records the actual dispatch run and attempt.

The hosted workflow still needs an authenticated way to stage the private pack, the pinned verifier, and the independently signed restore review before this opt-in path can be exercised there.

When a reviewed archived restore target is configured, the release keeps a private journal
bound to the selected source, workflow run, and first attempt. The admission record is
written before the first potentially reachable unpaused successor. An interrupted run emits
a recovery decision for observation, with an API 3 forward-only boundary after possible
admission. No decision receipt authorizes a compensating write or delivery resume.

The workflow uploads only the start, admission, and outcome receipts. If the runner terminates
before retaining the journal, treat the interrupted state as unknown. An absent receipt cannot
authorize pre-admission restoration. Reconcile the exact provider state with read-only evidence
before reviewing any further action.
