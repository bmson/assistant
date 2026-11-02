# Paired web traffic writers — source/design inventory

This is a source inventory and proposed contract, not runtime qualification or
permission to read/write production. Existing release code is unchanged. Do not
replace `--to-revisions` with `--to-tags` by assumption. The pinned SDK shape audit
must cover creation, promotion, recovery and tag removal before runtime wiring.
The strict desired/observed comparator remains a required gate.

## Identities and retained mappings

For one protected source/run/attempt, let C be the pre-release canonical revision,
P the newly created paused revision tagged `candidate-RUN-ATTEMPT`, and R the
unpaused successor tagged `resume-RUN-ATTEMPT`. Each identity must bind service UID,
immutable revision UID/image, source, manifest, workflow run/attempt and exact tag
URI. Historical tag proofs and any retired tag tombstones remain separate from
canonical revision allocation. A tag's name alone is never ownership evidence.

The initial one-time reconciliation preserves both known aliases. The subsequent
separately reviewed normal retirement removes the old alias and drains for600s;
only then can a fresh paired release capture the remaining current alias. The old
revision stays retained under the manager's cleanup hold.

## Existing write sites and consumers

All line references below describe `release-staged-services.sh` at base
`6297a84a961561e344c6f60ade3bed19c0c49e3a`.

| Phase | Existing write | Required retained bindings / following gate |
|---|---|---|
| Before staging | none; capture at469–478 | Capture all exact reachable owned web aliases and canonical allocation. Admission `--capture` uses strict snapshot. |
| Paused creation | service update500–503: immutable image, paused env, `--no-traffic --tag candidate` | Preserve captured aliases/percentages/URIs; add P0 with run-bound creation receipt before HTTP probe. Admission `--record-candidate` takes strict snapshot at281–282. |
| Paused promotion | traffic575–576: `--to-revisions P=100` | P100; captured aliases remain0 with identical mappings/URIs until explicit retirement. HTTP readiness plus old canonical drain follows. |
| Captured alias retirement | call589 to native retirement model | Strict snapshot and `planOwnedWebTagRetirement` require P tagged100. Remove only captured proven aliases, preserve P100, verify new settled state and full600s barrier. Retired aliases become forbidden to recreate. |
| Agent promotion | traffic604–605 | Agent operation is separate; web stays P100 with retired aliases absent. |
| Pre-resume admission check | no write;622–625 | Strict snapshot plus exact completed retirement etag/generation/drain stability. Set admissionPossible BEFORE unpaused create. |
| Resume creation | service update630–632: same image, writesPaused=false, `--no-traffic --tag resume` | Preserve P100 and its URI; add R0 only. Retired captured aliases stay absent. Record exact native R creation before probe; strict snapshot also used by `--record-resume`. |
| Resume promotion | traffic685–686: `--to-revisions R=100` | R100 plus P0, both exact tag bindings; no retired captured aliases. |
| Successful paused candidate cleanup |789 via helper148–184: `--remove-tags candidate` | Remove only run-owned nonserving P after R verified100, outside old rollback allocation. Preserve R100/URI and all unrelated allowed bindings. Current helper checks status but does not supply native etag CAS. |
| Pre-admission failure recovery |771 via helper278–282: `--to-revisions captured-map` | Restore captured canonical revision percentages only, preserving currently retained tags. NEVER restore captured tag list; aliases successfully retired stay absent. Existing map intentionally contains revision percentages, not tags. |
| Post-admission repause |725 via helper278–282: `--to-revisions P=100` | Keep marker-aware agent/jobs; preserve P and R tags until R identity verified. No old-runtime rollback even if unpaused create response was uncertain. |
| Post-admission R closure |733 via helper148–184: `--remove-tags resume` | Remove only exact verified R when nonserving, P100 confirmed. Verify alias absent then drain R. Unknown R identity stays HOLD. |
| Non-BASIC5 recovery / web-only promotion |761,771 /707–708 | Same revision-only traffic helper and shape risk; BASIC5 paired-context guard excludes web-only path. Do not silently change these paths through a shared helper. |
| Non-BASIC5 prior-owned cleanup |802 via helper148–184 | Excluded from BASIC5; historical cleanup must retain ownership checks. |

Creation and promotion can each affect desired traffic representation. A single
repair of the initial mismatch does not qualify these later writes. In particular,
strict recording runs immediately after creation, before promotion, so qualifying
promotion alone is insufficient.

## Proposed bounded native promotion/recovery primitive (not implemented)

If the SDK audit does not establish a documented bounded shape for every phase,
use a separate reviewed native traffic-only operation for promotion/recovery and
owned candidate removal. Do not broaden the current one-target retirement client.
Creation still needs its own SDK shape qualification or separately reviewed native
creation contract; a traffic-only primitive cannot qualify a template write.

Each operation accepts a reviewed source/run/attempt/manifest-bound plan with exact
before desired and observed multisets, UID, etag, generation, configuration/template
hashes, and retained tag-to-revision-to-URI proofs. A bounded fresh GET must reproduce
the complete reviewed before state. Only REVISION targets are allowed, with one
explicit100 target and explicit0 rows for each retained nonserving tag. Duplicate,
unknown, latest-following or conflicting bindings refuse. A retired-tag tombstone
set is checked on BOTH input and output; it cannot be removed by rollback planning.

Proposed phase output maps are:

| Operation | Desired and required observed output |
|---|---|
| Promote P before captured retirement | P tagged100; every captured retained tag0 |
| Retire captured aliases | Existing normal retirement planner output P tagged100; unchanged600s barrier |
| Promote R after resume creation | R tagged100; P tagged0; retired aliases absent |
| Cleanup P after success | R tagged100; P alias absent |
| Restore C before any captured alias retired | Captured canonical percentages; all currently retained tags preserved, with the selected existing tagged identity100 when unambiguous |
| Restore C after captured alias retirement but before admissionPossible | C UNTAGGED100 if its old tag was retired; P tagged0; retired aliases absent. Never synthesize an old tag to make a tagged100 row. |
| Repause after admissionPossible | P tagged100; R tagged0 if exact R was verified; no old-runtime rollback |
| Close verified R after repause | P tagged100; R alias absent; then drain R |

A recovery plan with unknown R identity cannot invent this output: hold for forward
recovery/explicit reviewed disable. Likewise ambiguous captured split allocation
or multiple serving tag identities requires a separate reviewed contract, not
coalescing or selecting an arbitrary tag.

Send ONE `PATCH {name,etag,traffic}` with `updateMask=traffic`, fixed service/region,
no allowMissing, retries or automatic rollback. Validate the returned fixed LRO;
bounded GET-only poll that same operation. Postcheck requires NEW etag, strictly
newer settled generation==observedGeneration, same service UID/template/config,
immutable images/revision UIDs, rootURI and retained tagURIs, exact desired/status
multisets and forbidden-tag absence. Expected URL-set changes are limited to the
specific removed alias on tag-removal phases; promotion preserves the complete URL
set. Uncertain writes or drift stay HOLD. Recovery is another explicitly selected
and independently reviewed operation, never an implicit retry/rollback of a PATCH.

Independent docs/model review and QA must qualify all success and failure phase
maps, including partial retirement then recovery, unpaused create uncertainty,
R identity mismatch, cleanup CAS loss and no-retired-alias recreation. Source-only
fixtures do not establish provider shape or authorize deployment. Keep operation
wiring frozen pending manager-selected SDK/creation compatibility and semantic
review of both initial reconciliation and this first paired lifecycle.
