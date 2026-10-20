# UI consistency review — October 19, 2026

The ongoing review prioritizes simplicity, shared typography, consistent alignment, and readable actions. Preserve the green paper/stage identity and platform controls. This first patch addresses two confirmed browser regressions and restores current screenshot tooling. Native rendering verification is blocked by simulator services; this is not a whole-app completion claim.

## Confirmed findings and fixes

| Finding | Change | Evidence |
| --- | --- | --- |
| At 320px, adding Chat pushed Audit trail onto a third header row. Navigation consumed 156px before content. | Compact navigation uses 8px horizontal link padding; desktop retains 12px. All labels remain visible and link height remains at least 44px. | The rendered header is now 109px. Console checks pass at 320, 390, 640 and 1280px in light/dark, with no horizontal overflow. QA independently inspected the before/after captures. |
| Primary and individual chats inherited the browser title “Assistant settings.” Activity and person details also lacked route titles. | Both conversation routes now declare Chat; detail routes declare Activity detail and Person. Root fallback is Assistant; description includes Chat. | Source metadata uses the installed Next metadata API. Typecheck passes. Deployed title verification awaits integration. |
| Hydrated chat screenshots could not build after chat cancellation moved to cancelChatTask. Their coverage check also expected unrelated product pages inside the separate chat series. | Mock the current cancellation entry point, keep other actions forbidden, and explicitly record the chat series coverage scope. Static selective runs continue requiring the complete product matrix. | Eight hydrated loaded/empty layouts and four recall/failed-Stop layouts pass the current-receipt requirement. |
| Fixture inventory still labelled all chat routes blocked by the proxy. | Record three owner Chat routes, six console routes, 24 retained routes/aliases, and the root redirect separately. | Complete source inventory still accounts for all 34 page files. Proxy source admits authenticated owner Chat. Synthetic screenshots do not establish live route admission. |

[Before: 320px navigation](assets/ui-consistency-2026-10-19/navigation-before.png) · [After: 320px navigation](assets/ui-consistency-2026-10-19/navigation-after.png)

## Route inventory and review status

“Captured” means real source components with synthetic data and current CSS, not a live owner-account test. Console coverage includes hydrated controls; most product layouts are static. Contact sheets supported the initial compact-layout hierarchy review. Long-page, enlarged-text and native acceptance remain separate work.

| Route | Current access | Review evidence / next check |
| --- | --- | --- |
| `/` | Redirects to Settings | Source redirect and generic title fallback reviewed. |
| `/settings` | Owner console | 96-layout console matrix includes both authentication modes, key creation/rotation, errors and recovery. Header fix inspected at 320px. |
| `/security` | Passkey console | Passkeys, recovery, devices and browser sessions captured; synthetic receipt/retry checks passed. |
| `/audit` | Owner console | Loaded/empty/error/filter layouts, keyboard and appearance checks. |
| `/audit/[id]` | Owner console | Detail evidence remains within initial viewport; full evidence is separately scrollable. |
| `/setup` | Passkey setup | Light/dark responsive captures and simulated setup states. |
| `/signin` | Passkey sign in | Responsive captures, recovery/error states. |
| `/chat` | Owner Chat | Loaded/empty real ChatClient, settled composer geometry, light/dark. Explicit page title added. |
| `/chat/[id]` | Owner Chat | Side-chat loaded/empty, return link, archive action and settled composer geometry. Explicit title added. |
| `/chat/all` | Owner Chat | Loaded/empty list captured. Primary and archived controls reviewed in compact contact sheet. |
| `/tasks` | Retained | Loaded/empty Activity captured; status/filter hierarchy reviewed. |
| `/tasks/[id]` | Retained | Detail captured; facts/actions and evidence disclosure reviewed. Explicit title added. |
| `/goals` | Retained | Loaded/empty/editor presentations captured; continuation/action hierarchy reviewed. |
| `/approvals` | Retained | Loaded/empty captured; primary decision and evidence disclosure hierarchy reviewed. |
| `/cards` | Retained | Loaded/empty captured; paper card and dismissal alignment reviewed. |
| `/packs` | Retained | Loaded/empty captured; plan, commitments and waiting sections reviewed. |
| `/people` | Retained | Loaded/empty, upcoming dates and grouped rows captured. |
| `/people/[id]` | Retained | Person details, occasions and relationship sections captured. Explicit title added. |
| `/profile/people/[id]` | Legacy alias | Redirect asserted to People detail. No independent screen. |
| `/profile` | Retained | Memory loaded/empty captured; open loops, follow-ups and health hierarchy reviewed. |
| `/profile/about` | Retained | Loaded/empty facts and pinned-summary surfaces captured. |
| `/profile/memories` | Retained | Firestore read-only loaded/empty branches captured separately. |
| `/profile/knowledge` | Retained | Library/map/cleanup, loaded/empty captured. Filters and selected view remain distinct. |
| `/profile/data` | Retained | Export/erase explanation and controls captured; no erasure performed. |
| `/profile/voice` | Retained | Loaded/empty/editor captured; failed saves preserve draft in hydrated check. |
| `/skills` | Retained | Loaded/empty/editor captured; hydrated failure/recovery and focus checks. |
| `/documents` | Retained | Loaded/empty upload and document rows captured. No upload performed. |
| `/import` | Retained | Loaded/empty file/import history captured. No import performed. |
| `/calls` | Retained | Loaded/empty call history captured. |
| `/calls/[id]` | Retained | Outcome, follow-through and transcript captured. No call performed. |
| `/costs` | Retained | Loaded/empty provider billing and usage-ledger hierarchy captured. |
| `/anomalies` | Retained | Loaded/empty evidence and decision controls captured. |
| `/improvements` | Retained | Loaded/empty repair/proposal surfaces captured; failed issue-report submission preserves draft. |
| `/capabilities` | Retained | Setup/status cards captured and compact hierarchy reviewed. |

## Verification and remaining review

- Console harness: 96 responsive/theme layouts and ten credential receipt/recovery scenarios passed.
- Product series: 51 synthetic source states, 204 matrix layouts plus six hydrated form captures. All 210 captures passed their source-receipt freshness check before the next responsive refinement began.
- Conversation series: eight hydrated loaded/empty layouts plus four recall/failed-Stop layouts passed; all twelve receipts current within their explicitly named scopes. No provider calls, owner reads, sends or voice exercised.
- Repository typecheck passed; 55 focused navigation/console/product fixture tests passed. Full repository lint passed (existing warnings remain). A second focused run including capture-provenance tests passed 59 tests.
- Exact artifacts and immutable receipts are in `.workspace/ui-review-2026-10-19/{console,products,chat,chat-failures}` in the review worktree. Committed before/after images provide portable evidence for the navigation change.

The native app compiled, but test launch repeatedly failed with DTServiceHubClient “failed to bless service hub” on the dedicated simulator. No native tests or screenshots were obtained. Log: `/tmp/assistant-designer-review-2026-10-19.log`. The dedicated simulator was shut down and removed; existing simulators were untouched. QA independently encountered the same environment failure.

Next: review native destinations when simulator services recover; continue lower scroll positions and accessibility text. An additional 204 static 320px probes across normal/doubled root text and both themes found upload/form overflow and enlarged-text layout candidates; those remain a separate follow-up patch. Verify each against full-size renders. Keyboard composition, native caret/selection, directory pulls, VoiceOver, physical-device behavior and live integrations require their own checks. Native screenshot failures caused by simulator services must be distinguished from application defects.

Findings and validation are communicated to Goal: QA and Goal: Cleaner. Integration and live verification remain their separate steps; this worktree does not merge itself into shared main.
