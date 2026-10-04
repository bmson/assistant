# Browser console review — 3 October 2026

## Purpose and scope

The browser is the installation and investigation console. The mobile app remains the daily assistant experience. This pass covers Settings in device-key and shared-key modes, Security, Audit trail and record detail, Sign in, Setup, and the recovery-code receipt. It changes page composition and supporting copy while preserving authentication, mutations, confirmation steps, credential masking, and evidence access.

This review follows the current [design system](../design-system.md): system typography, sentence-case labels, 18 px section titles, readable supporting copy, rows for access records, and shared controls. Shared navigation, color tokens, page framing, and appearance controls are maintained by the parent review. Retained product screens and native screens have their own reviews.

## Observed before the changes

The prior audit assets and the fresh `before-console` capture were inspected as image pixels, including 320 px Audit, 390 px Settings, Security and Audit detail, and desktop Settings/Audit/Sign in.

Representative current baseline pixels are retained with this review: [Settings](assets/console-ui-review-2026-10-03/before-settings-390-light.png), [Security](assets/console-ui-review-2026-10-03/before-security-390-dark.png), [Audit](assets/console-ui-review-2026-10-03/before-audit-320-light.png), [Audit detail](assets/console-ui-review-2026-10-03/before-audit-detail-390-light.png), [desktop Sign in](assets/console-ui-review-2026-10-03/before-signin-1280-light.png), and [Setup](assets/console-ui-review-2026-10-03/before-setup-390-light.png).

| Surface | Concrete issue in the captured layout | Implemented response |
| --- | --- | --- |
| Settings, device keys | Server address, existing device card, and new-key input formed one undifferentiated vertical sequence. The new device form had no introduction. The Security destination was a paragraph and button without a clear section identity. | Label the address, separate existing device-key rows from a distinct creation form, and give access/recovery its own compact section and destination. |
| Settings, shared key | Address could be selected but had no copy action. The masked key and server address did not explain their different jobs. | Add server-address copy, label the current key, explain that a preview cannot pair a device, retain the one-time replacement receipt and disruption warning. |
| Security | Repeated bordered cards and loose headings made access records and recovery actions look alike. Sign out everywhere had little explanation. | Use divided access-record rows, counts for successfully loaded passkeys, consistent section hierarchy and separation, and precise browser-session consequences. |
| Audit trail | The phone filter stacked all fields; raw UUIDs took a separate row in every result. Time and cost were joined without identifying their meaning. | Pair Status and Records from 360 px upward, with full-width controls below that so selected values remain legible. Identify the task and its progress first, then label Updated and Cost. Keep the exact task ID on the detail page and in searchable record identity. |
| Audit detail | Desktop rendered nine equally weighted section buttons. Tool name appeared as both heading and metadata. Raw timestamp/identifier competed with the evidence. | Use the same native evidence selector on phone and desktop, give task progress and status their own summary, format UTC diagnostic time, disclose entry identifiers, and omit only the identity already used as the heading. Other model/role evidence remains visible. |
| Sign in | A full reading-width recovery box stretched across desktop for a very small task. The passkey action lacked a nearby prerequisite. | Constrain the authentication flow to a readable width, explain available device/security-key sign in, and keep recovery as a secondary native disclosure. |
| Setup | Long adjacent paragraphs repeated ownership and device-authentication explanations, with no visible next stage. | Present one clear passkey step, explain the subsequent recovery-code and mobile-connection stages, and give a missing/expired setup link a deliberate recovery section. |
| Recovery code | A long bold warning and tiny checkbox made an important receipt dense. | Use comfortable explanatory copy and a clear acknowledgment target while preserving focus, selectable code, copy fallback, and acknowledgment before Continue. |

## Current page contracts

### Settings

The owner-authenticated server page derives the server address from request headers with the configured URL as fallback. Passkey installations render the pairing subset of Security: device keys only, without fetching passkeys. Shared-key installations read the stored token server-side and pass only its masked preview to the browser. The full replacement key is retained in component state only after an authorized rotation returns it.

The owner can copy the address, create an individual device key or rotate a legacy shared key, and open Security. Each operation retains its current API/action and confirmation behavior. Shared-key replacement still warns that existing devices must update their connection and that the old key stops working within 30 seconds. Missing writable server configuration has a disclosure explaining the administrative recovery path.

### Security

The page is available only in passkey mode and requires the owner. Initial loading and failed loading do not enable access mutations. A failed read offers retry; mutation failures bring the error notice into view and preserve the entered device name. A newly created device key still receives focus and is shown once.

Confirmed credential changes have a separate receipt from their subsequent list refresh. If creation, registration or device revocation is acknowledged and then a list read fails, the page names the saved change, retains its last successfully loaded lists, marks them out of date and offers **Refresh lists**. That retry performs reads only. Further access mutations stay disabled until the lists refresh successfully. Repeated read failures explicitly preserve the saved-change outcome. Both list responses must succeed before either is published; the Settings pairing subset reads only devices. A synchronous in-flight guard also prevents overlapping submissions before the pending state renders.

One-time device keys and recovery codes remain in component state across these failures and later list retries. Recovery-code replacement records its actual acknowledgment and explains that the old code is invalid; it does not require an unrelated list read. Successful passkey removal and browser sign-out retain their existing sign-in redirect. No owner-authentication API contract or credential storage policy changed.

Passkeys show their name, creation date, synchronization state and last-used date when captured. A passkey cannot be removed when it is the last active one. Removal keeps its explicit confirmation and browser sign-out consequence. Recovery-code replacement is separate from passkey management. Device-key revocation identifies the affected device and leaves other device keys active. Browser sign-out is separate again: it revokes browser sessions, while passkeys and device keys remain usable.

### Audit trail

The server fetches at most 100 tasks from the selected current/archived/status view, then applies the bounded 200-character search to task identity, title and progress. The interface says this is the latest bounded view, rather than implying it searched the entire history. It distinguishes no work, no archived work, and no matching filters.

Each record has one investigation destination with prefetch disabled; the index does not fetch every full investigation. The task label is a comfortable keyboard/touch destination. Status words, progress, explicit UTC update time, and recorded cost are kept. IDs remain searchable and are exposed on detail rather than repeated across every list row.

### Audit detail

Owner authorization, UUID validation, supported-section validation and invalid-query handling remain ahead of data rendering. The repository is still requested with a 10-record section limit. Overview and individual sections use a native GET form; selecting a new section starts that view without carrying an old field cursor into it.

The task summary retains status, attempt, recorded spend, progress and exact task ID. Each entry retains its chosen tool/model/role identity, explicit diagnostic time, other captured metadata, payload disclosures and selectable identifier. Errors, messages and model output remain open by default. Long fields preserve their exact section, entry, field and next offset. Downloading respects the selected section/entry/field/offset. Section pagination, evidence-coverage limitations, the assistant investigation request and task diagnostics remain available.

### Sign in, Setup and recovery

Passkey sign-in and recovery remain separate operations. Recovery opening focuses its input; pending requests block the disclosure from toggling and prevent concurrent submissions. Recovery retains entered code after a failure. It explains that adding the replacement passkey replaces the recovery code and signs out other browsers.

Setup still reads its claim from the URL fragment and removes the fragment from the address/history before proceeding. It does not expose the claim in rendered page copy. The initial claim-read state disables creation. A missing link tells the owner how to obtain a fresh one. The browser still delegates passkey enrollment to the platform; screenshots cannot prove biometric or hardware-key completion.

New recovery codes are shown once, receive heading focus, wrap in narrow viewports, and provide copy feedback with a manual fallback. Continue remains disabled until the owner acknowledges saving the code. Replacing a code remounts the receipt so an earlier acknowledgment cannot authorize leaving a new unsaved receipt.

## Validation and limits

Focused pure verification passed **3 files / 10 tests**: owner Settings rendering/authentication, Audit index/detail, and the synthetic console fixture. New integrity regressions ensure that moving identity into the entry heading does not hide secondary model/role fields, and that downloading/continuing a field stays bound to its exact evidence scope. Existing tests cover owner authentication before reads, bounded archive/status search, filtered empty states, failure context and older-section pagination.

The final Audit suite was rerun after preserving exact visible entry timestamps: **6 tests passed**. Web typechecking passed after the product fixture owner corrected its unrelated cost-basis fixture. Affected-file formatting and scoped whitespace checks passed. No database reset, emulator run, production credential use, real passkey mutation, paid inference, or deployment is part of this scoped review.

The final local Chrome pass passed **96 responsive/theme renders** at 320, 390, 640 and 1280 px in light and dark: the nine console variants/fallbacks, the shared long-content stress fixture, and the actual not-found and route-error components. It verified one page title, no horizontal overflow, theme selection and OS following, keyboard skip, empty/error/retry, guarded revocation, last-passkey protection, recovery focus and sensitive-code clearing, failed then successful recovery presentation, exact copying and manual clipboard fallback, acknowledgment reset on replacement, one-time-key focus, and hydration consistency. The route-error retry invokes its callback once and offers a Settings destination. Six layouts with the root font size doubled kept controls inside the 320 px viewport. The first selected audit evidence heading remained visible in the ordinary initial viewport.

The first visual pass revealed a clipped status value at 320 px and an unnecessarily low pairing action. The enlarged-text pass then found intrinsic auto grid tracks expanding the authentication content beyond the viewport. These were corrected before the final run: smallest-width filters stack, the pairing form is shorter, and authentication page/client/card tracks explicitly permit shrinking. In the final 390×844 Settings image the Create device key action is entirely visible in the initial viewport. At 320 px, full-width filter readability takes more vertical room; this remains an explicit tradeoff for the smallest layout.

| Representative pair | Before | After |
| --- | --- | --- |
| Settings, 390 px light | [Baseline](assets/console-ui-review-2026-10-03/before-settings-390-light.png) | [Final](assets/console-ui-review-2026-10-03/after-settings-390-light.png) |
| Security, 390 px dark | [Baseline](assets/console-ui-review-2026-10-03/before-security-390-dark.png) | [Final](assets/console-ui-review-2026-10-03/after-security-390-dark.png) |
| Audit, 320 px light | [Baseline](assets/console-ui-review-2026-10-03/before-audit-320-light.png) | [Final](assets/console-ui-review-2026-10-03/after-audit-320-light.png) |
| Audit detail, 390 px light | [Baseline](assets/console-ui-review-2026-10-03/before-audit-detail-390-light.png) | [Final](assets/console-ui-review-2026-10-03/after-audit-detail-390-light.png) |
| Sign in, desktop light | [Baseline](assets/console-ui-review-2026-10-03/before-signin-1280-light.png) | [Final](assets/console-ui-review-2026-10-03/after-signin-1280-light.png) |
| Setup, 390 px light | [Baseline](assets/console-ui-review-2026-10-03/before-setup-390-light.png) | [Final](assets/console-ui-review-2026-10-03/after-setup-390-light.png) |

Additional inspected evidence: [enlarged Sign in](assets/console-ui-review-2026-10-03/after-signin-320-large-text.png), [enlarged Setup](assets/console-ui-review-2026-10-03/after-setup-320-large-text.png), [recovery failure](assets/console-ui-review-2026-10-03/after-signin-recovery-error.png), [recovery copy fallback](assets/console-ui-review-2026-10-03/after-recovery-copy-fallback.png), [replacement key](assets/console-ui-review-2026-10-03/after-settings-replacement-key.png), and [investigation copy fallback](assets/console-ui-review-2026-10-03/after-audit-copy-fallback.png). The [measurement report](assets/console-ui-review-2026-10-03/measurements.json) records all render dimensions and checks. Its local synthetic content-ready times are not production performance measurements.

The initial parent-owned capture harness was used through a temporary local copy while its coordinator was unavailable. Two text selectors were adapted without editing the shared harness: the empty device-key copy and the evidence-heading comparison, which must allow its count badge. These selectors have since been corrected in the shared harness. Browser/server resources from the local captures were closed after completion.

This is a synthetic browser review, not evidence that an owner completed pairing on a physical phone, that a platform passkey dialog worked, or that an installation recovered after losing all devices. Those flows still need controlled installation/device acceptance tests. Date labels for access keys use browser locale; Audit deliberately uses explicit UTC. Language localization and long real-world evidence/capability inventories remain broader product work.

The follow-up resolved the source-supported partial-success gap: credential changes and subsequent reads previously shared the generic failure handler, so an acknowledged creation followed by a failed GET could suggest repeating the effect. The current receipt and stale-list state separate those outcomes. The browser harness now exercises actual hydrated components with synthetic API responses for creation, registration and revocation acknowledgments followed by partial projection failure, repeated read failure, recovery and true mutation failure. It checks that retry never issues another POST or DELETE, that fresh passkeys are not published beside stale devices, and that both one-time secrets survive unrelated failures.

The final canonical browser run passed **96 responsive/theme renders plus 10 credential scenario groups** against the shared control changes. Those additional scenarios run in light and dark with 320/390 px viewports; the Settings partial-success receipt also passes at 200% text. The first enlarged-text check exposed a reserved pending-label track exceeding the narrow warning panel. The shared stable-label primitive now permits its grid and label tracks to shrink and wrap, so every caller uses the same treatment. Web typechecking and affected-source formatting passed. Browser and static preview server resources were closed after the run.

Retained outcome evidence: [acknowledged creation and failed refresh](assets/console-ui-review-2026-10-03/security-created-refresh-failed-light.png), [acknowledged revocation with both secrets retained](assets/console-ui-review-2026-10-03/security-revoked-refresh-failed-dark.png), [acknowledged passkey registration and stale lists](assets/console-ui-review-2026-10-03/security-passkey-refresh-failed-light.png), and [Settings recovery at 200% text](assets/console-ui-review-2026-10-03/settings-created-refresh-failed-large-light.png). The [scenario report](assets/console-ui-review-2026-10-03/security-receipts.json) states the synthetic API/WebAuthn boundary and the checks performed. The representative After images and main measurement report above have been refreshed from this final canonical run.

The receipt is based on an acknowledged API response. A connection lost before the mutation response remains outside this bounded change; the current owner credential API does not provide an idempotent receipt lookup or recovery of a lost one-time key. Screenshots and synthetic responses do not establish physical credential enrollment or server-side mutation durability.
