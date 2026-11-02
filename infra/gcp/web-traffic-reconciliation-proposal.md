# Explicit known traffic reconciliation — source/design only

No provider read, apply or new credential/permission is authorized by this proposal.
The model/executor has injected test IO only. No CLI, workflow, credential adapter,
retirement comparator or release/admission path invokes it.

The measured receipt `41351973081`, source `6297a84a961561e344c6f60ade3bed19c0c49e3a`,
shows a valid canonical mismatch. This is not a claim of provider coalescing or
equivalence. Strict `sameTraffic` remains unchanged and continues to reject it.

## Exact operation proposed for a separate future review

| View | Current revision `01087-dup` | Old revision `01080-hel` |
|---|---|---|
| Required before desired | one untagged100 row plus `resume-40403696377-1`0 | `resume-40350727924-1`0 |
| Required before observed | `resume-40403696377-1`100 | `resume-40350727924-1`0 |
| Proposed after desired and required observed | `resume-40403696377-1`100 | `resume-40350727924-1`0 |

Every row must explicitly allocate by `REVISION`. Only the exact reviewed3/2
multiset is accepted. Omitted proto3 percentages mean zero; malformed values,
extra or duplicate rows/tags, absent tags, reassigned revisions, active old
allocation, split/changed percentages and latest-following targets all refuse.
An already equal state is not this operation; obtain a normal retirement plan.

The proposed operation is a single native service `PATCH`, body only
`{name,etag,traffic}`, with `updateMask=traffic`. Its desired traffic is exactly
the two tagged targets above. It removes only the redundant untagged desired
representation. Both tag-to-revision bindings and their exact URI hashes are
preserved. No tag/revision/image deletion, new revision, pause/unpause, template,
IAM, epoch, scheduler or normal allocation redistribution is proposed.

Official [tagged-percentage routing](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/update-traffic)
supports assigning100% to a revision through its existing tag. The [rollout guide](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)
also documents routing to a selected revision tag. These support the explicit
target operation; they do not establish a general3-to-2 status normalization rule.
The [native Service API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/patch)
defines the traffic field-mask update. No claim that the initial mismatch was
harmless is needed to perform a separately reviewed, explicit desired-state change.

## Before/after packet and proof gates

A future plan-only adapter must use the existing protected main-source/WIF identity,
production environment, fixed SDK and production-deploy lock. It may read only the
fixed `assistant-web` service and the two fixed immutable revisions. The packet
includes exact operation source/time, before UID/etag/generation, both canonical
traffic views/hashes, native revision UIDs/config hashes, pinned images/source
provenance, observed timeouts, root URI/URL-set hashes, template/config hashes,
both tag URI hashes and the exact proposed after views/body. No native environment,
resource payload, credential or raw URI is retained. Actual fresh values remain
unknown until a separately authorized protected read; synthetic tests are not a
runtime packet.

Before any future apply, the manager must review the exact source/packet/hash/time.
The executor re-reads the fixed service/revisions and recomputes the entire packet;
any change holds. The reviewed observation must be canonical UTC, not future, and
at most30minutes old, checked again immediately before its one PATCH attempt. The
fresh pre-write etag is the CAS precondition. There is no allowMissing, write retry,
or automatic rollback. An uncertain response remains possibly mutating/UNKNOWN.

Poll only the validated returned operation in the fixed project/region using GET,
bounded to180seconds. Individual reads/PATCH responses are bounded to15seconds;
the injected adapter must obey abort signals and existing byte/call limits. The
source-only executor also bounds stalled callbacks. No additional endpoint or
credential discovery is part of this model.

Postcheck requires the same service UID, root URI/URL set, images, immutable revision
UID/config, template/config, both tag URI bindings, and sole100% current/0% old.
It requires a NEW settled etag and a strictly newer generation equal to the observed
generation, with terminal success and reconciling false/implicit protofalse. It
does not require the old token after a successful mutation. The exact new desired
and observed two-row multisets must match. Drift or failure keeps HOLD with no
second write.

The distinct reconciliation receipt proves routing equality only. It does not retire
the old tag, complete any600-second drain, qualify editing or authorize admission.
After success, obtain a NEW normal retirement plan bound to the new state, review it
separately, and preserve the full600-second retirement drain. Keep root's cleanup
hold through the already specified first paired rollout/capture checkpoint. Matching
phone delivery remains conditional on verified backend serving/guard restoration.
