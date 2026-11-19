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
