# Reviewable V1 editor metadata operations

This source implements the earlier initialization plan. It is an operator-only tool, not a browser route, application boot hook, migration, or V2 removal dependency. No production observation, preparation, index creation, metadata write, or dispatch was performed during source preparation. Source checks, an isolated emulator transaction rehearsal, protected production readiness, metadata activation, deployment, and authenticated browser delivery are separate gates.

## Exact operation and replay contract

`@assistant/firestore/owner-editor-maintenance` is an explicit tooling subpath and is not exported by the application barrel. Ordinary epoch rotation still calls randomUUID once per rotation. A shared internal builder preserves the existing record shape: name, updatedAt, and a JSON cursor containing exactly ownerId, epoch, ready, and privacyGenerationDigest. No collection or schema is added.

Preparation is a read-only transaction. It generates one operation UUID and one proposed epoch UUID, then records the singleton owner's exact native updateTime seconds:nanoseconds, current privacy digest, and exact prior epoch cursor/version or absence. It rejects initialization over READY state, disable over missing/disabled state, ambiguous/mismatched ownership, active/malformed privacy state, or malformed metadata. The private packet is format 1 and explicitly binds `owner-editor-privacy-v1/native-seconds-nanos`. The SDK uses the unchanged production privacy-token helper; cross-tests verify the GET observer agrees for absent and completed privacy metadata, including nine-digit timestamp fractions.

A packet lasts at most 30 minutes and binds the exact main source SHA and fixed project/database/installation/owner. It contains separate reviewed recovery and drain evidence digests. Those digests identify material the manager must review; they do not prove a pause, drain or recovery runtime by themselves. Dry-run can inspect a packet before that evidence is filled. Apply requires it.

Application uses one native Firestore transaction, maxAttempts 1. It first reads the actual singleton owner and current privacy state. Both must match the reviewed owner version and privacy digest. If the current logical epoch already equals the proposed owner/epoch/ready/privacy state, the operation returns already_applied without writing. Otherwise the exact approved prior native version and logical state, or approved absence, must still match. A changed state aborts. Initialization writes ready=true; disable writes ready=false with a distinct proposed UUID. A replay never rotates again. Only the one maintenanceCursors document can be written. All reads occur before the write. There is no contact, family, memory, operation or schema write.

Native versions are compared as exact seconds:nanoseconds strings. They are never converted to Date/toMillis for CAS. updatedAt remains the existing Date field; it is not used as the CAS token. Uncertain commit outcomes require inspection and replay of the same unexpired packet, not a new random proposal. Expired or changed packets require reinspection. A GET cannot create authority.

## Protected workflow and private packet handling

`Review or apply basic editor V1 metadata` is dispatch-only, current trusted main, first attempt, existing protected production environment and production-deploy concurrency. It does not modify deployment/CI triggers. The workflow requires the exact reviewed current main SHA and the intrinsic five-command capability declaration. It uses the existing pinned WIF identity, no local/default ADC, no new IAM/scopes/cloud credential, and gcloud 576.0.0. The explicit WIF auth client is passed to the fixed-target SDK. Emulator and SDK universe/CLI endpoint overrides are rejected by the production entrypoint. Permission denial fails; no fallback identity or permission repair occurs.

Each operation refreshes the GET-only collector receipt first: same workflow/source/run/WIF, exact 197-index parity and qualifying PITR or backup observation, at most two minutes old. Agent/web service templates and serving revisions must have matched, and a new GET must still match each observed template hash/revision. Explicit installation/owner values must agree on both services. The transaction then independently checks the reviewed native metadata. Fresh metadata does not prove compatible retained recovery images or relevant legacy-writer drain; manager review remains required before apply.

The repository is public. Preparation retains **only an encrypted proposal**: AES-256-GCM with a random key/nonce and fixed purpose AAD; the key is wrapped with RSA-OAEP-SHA256 to an operator-controlled 3072-8192-bit RSA public key. The public key may appear in workflow inputs. Never put a private key in a workflow input. Private/non-RSA/weak recipient keys are rejected. The private key stays with the manager; no new user setup or cloud authentication is implied. Public artifacts contain neither plaintext owner/installation nor proposed epoch/privacy metadata.

The manager can decrypt the downloaded ciphertext locally, without cloud access:

```sh
pnpm exec tsx scripts/owner-editor-v1-maintenance.ts --decrypt /private/encrypted.json /private/recipient-key.pem /private/reviewed-packet.json
```

The output file is created exclusively with mode 0600. Review the exact target, source, before-state, proposed result and expiry. Populate evidence.recoverySha256 and evidence.drainSha256 with the actual reviewed evidence hashes. Compute the final canonical digest locally:

```sh
pnpm exec tsx scripts/owner-editor-v1-maintenance.ts --packet-digest /private/reviewed-packet.json
```

Only after review, store that private metadata packet in the production environment secret OWNER_EDITOR_V1_REVIEWED_PACKET using existing authorized repository access. The source change does not configure the secret or presume permission to do so. This is metadata transport, not an authentication credential. Report an actual permission denial if encountered; do not change permissions or ask the user to provision a new cloud identity.

Dispatch dry-run with the exact source SHA and reviewed packet digest; it reads and compares current state but cannot write. Review its sanitized outcome and the actual recovery/drain material. An explicitly reviewed apply dispatch uses the **same packet and digest**. Inputs and evidence hashes alone do not constitute manager authorization; do not dispatch apply until that review is complete. The workflow only loads the plaintext packet secret into dry-run/apply. Logs contain fixed outcomes and the packet digest, never the packet. Ciphertext retention is one day; sanitized prerequisite receipts are fourteen days. The collector remains bounded; workflow wall time is five minutes. SDK/process cancellation cannot prove a remote commit was canceled, hence the stable replay contract.

## Recovery and disable before claiming delivery

Before enable, identify the exact compatible retained agent/web pair, relevant old/in-flight/recovery writers, and an accepted pause/drain/recovery procedure. The currently serving web SHA and global readiness do not prove these properties. Pause/drain steps must use the existing reviewed guard/operator path; this workflow does not invent a ready flag or silently pause/resume services.

If initialization succeeds, use prepare-disable to read the actual newly READY epoch and prepare a **separate** stable disable packet with its exact committed native version and current privacy binding. Encrypt, privately review, and dry-run it before rollout or ordinary editor writes are admitted. The initial enable packet cannot substitute for the disable packet, and its old expected version must not be reused. A later privacy/owner/epoch change invalidates that contingency packet and requires a new observation. Disable application follows the same explicit review/digest/CAS/replay rules and chooses a new epoch with ready=false. Never restore an old epoch or delete the cursor as a shortcut.

After readiness is observed, use the normal reviewed paired deployment for the exact source SHA. The existing automatic gate must still reject missing/UNKNOWN epoch/index/recovery observations before delivery-guard mutations. A failure before the guard leaves no guard mutations to restore. After release starts, preserve its existing restoration receipts. If rollout fails after initialization, follow the reviewed disable/recovery transition and retained marker-aware pair; do not infer a user-data rollback. Cleanup-tail safety failures remain separate and fail closed.

Finish with exact serving/runtime evidence and authenticated browser acceptance of all five allowed commands, both excluded removals, old-session reauthentication, replay/conflict behavior and visible saved results. Metadata applied is not feature delivery. Remove the temporary private metadata secret and local packet material only under the manager's normal cleanup decision; never upload plaintext as evidence.

## Validation boundaries

Offline tests cover read-only preparation/dry-run, missing/disabled initialization, exact replay, explicit disable, epoch/owner/privacy changes, active erasure, malformed/expired/wrong-source/target packets, failed commit retry, normal rotation, encrypted-envelope tampering, source/WIF observation binding, and REST/SDK timestamp agreement. Six localhost native cases exercise actual Firestore transactions and CAS without cloud credentials. The test transport uses a fresh demo project/test database and an explicit logical production-scope adapter solely to exercise the fixed packet parser; it does not prove the production SDK identity or target. Native startup requires a separately sealed and approved bounded recipe. Initial preliminary runs made before that recipe review are unqualified evidence and must not be described as an approved native gate.
