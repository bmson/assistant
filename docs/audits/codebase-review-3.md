# Codebase review, round three — audit findings

A full audit pass — security, stability, code quality, dead code, and
organization — run after the web-UI redesign cycle (PRs #39–#56) and the
web-watches feature landed on top of round two. Scope: everything, with extra
depth on code changed since `8010bcc` (the round-two closing commit). All
verified against `pnpm lint` (Biome + architecture boundaries), `pnpm
typecheck`, the full vitest suite against a real pgvector Postgres (956
passing), and `pnpm build`.

## Stability

All four gates were green before the audit changed anything, and green after:
lint, typecheck, 130 test files / 956 tests, production build. No flaky or
skipped suites observed.

## Security

Nothing new exploitable was found. Probed first-hand:

- **Web watches** (the one new network-facing surface): every poll goes
  through `fetchPublicWebPage` — per-hop URL validation, DNS resolution with
  IP pinning, private/special-range rejection for both IPv4 and IPv6
  (mapped-IPv4, 6to4, Teredo, ORCHID all handled), manual redirect re-checks,
  a byte cap, and compressed-response refusal. `watch.web` re-validates at
  creation and the guard re-runs on every poll, so a DNS rebind between
  creation and poll is caught. Page text never reaches a model context — only
  a SHA-256 fingerprint / presence boolean and a spec-derived summary; the
  atomic `nextPollAt` claim prevents double-polling across instances, and
  consecutive-failure expiry (5) caps a permanently broken URL. Sound.
- **Upload routes** (`/api/documents/upload`, `/api/import/upload`):
  auth-gated, module-gated, size-capped under the Cloud Run request limit.
- **`repair-agent-identity`**: the dynamic `tx.unsafe` identifiers come from
  `pg_constraint`/`pg_attribute` (the catalog, not user input) and values are
  parameterized; the whole repair is transactional. Sound.
- No secrets in the tree; images strip npm and run as non-root users;
  the Trivy `node_modules` skip is compensated by `pnpm audit` in CI.

Two known items remain open and tracked, not new: the header-based
`AUTH_LOCALHOST_BYPASS` tripwire (round two, SEC-H3 — sound fix needs the
socket peer address) and the **hardcoded GCP identifiers in `deploy.yml`**,
marked TEMPORARY in-file: #14 parameterized them to GitHub Actions `vars.*`
that were never populated, so deploys failed with an empty provider. Populate
`GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_PROJECT`
(and optionally `GCP_REGION`, `ARTIFACT_REPOSITORY`) in repo settings and
revert to the `vars.*` form.

## Dead code — removed in this commit

The redesign cycle left an entire earlier navigation generation (the
collapsible rail/tile/drawer) styled but unrendered, plus a handful of
speculative exports that never got callers:

- **~330 lines of dead CSS** across `globals.css`, `visual-refinement.css`,
  `motion-system.css`, and `navigation-rethink.css`: every `nav-rail`,
  `nav-tile`, `nav-drawer`, `nav-collapsed`, `nav-tooltip`, `nav-header`,
  `nav-footer`, `nav-label`, `nav-manage-group`, `nav-badge-dot`,
  `nav-toggle-icon`, `page-header`, `nav-mobile-header`,
  `nav-launcher-mobile`, and `nav-appearance-control` rule (verified
  unreferenced by any component, including dynamically built class names),
  plus the `--rail-w`/`--nav-hairline`/`--nav-hover`/`--nav-active-glow`
  custom properties that only those rules read.
- **`apps/web/app/brand-mark.tsx`** — orphaned when the rail header was
  removed.
- **The budget-edit chain that never got a form**: `updateBudgets` server
  action → facade entry → `updateSpendingBudgets` use-case (all introduced
  together in the wizard commit, no UI ever posted to it). Budget changes
  happen through the chat budget-request flow.
- **`getOwnerFirstName` / `getOwnerGivenName`** — same origin, no caller.
- **`ui.tsx` leftovers**: `tabularNums` (pages use the literal Tailwind
  class), `tileGridClass`, `iconButtonClass` (superseded by
  `JellyIconButton`).
- **Duplicate config export**: `allAssistantModules` was `assistantModuleNames`
  under a second name; one name remains.
- **Un-exported file-private helpers** (used in-file only, matching the
  round-two REG-L12 convention): `approvalFields`, `harvestKnownAddresses`,
  `RESULT_CHAR_LIMIT`/`resultCharLimit`,
  `executeAmbiguousApplicationConfirmationTask`, `SmsChannelRateLimitError`,
  `PROFILE_OBJECT`, `MAX_TEXT_CHARS`, and the unused `signIn` from the
  NextAuth destructure.

Kept deliberately: exported _types_ that document DI ports and exported
function signatures (`WebWatchDeps`, worker `BlobStore`, etc.) — they are
API documentation, not dead weight — and `scripts/verify-browse.ts` /
`scripts/verify-goal-session.ts`, which are live-verification tools now
referenced from `docs/operations.md` instead of sitting undiscoverable.

## Small fixes

- `watch.cancel`'s tool description said "inbox watch" but it cancels web
  watches too — corrected so the model doesn't refuse a valid cancellation.

## Organization

The tree is in good shape: boundaries are machine-enforced
(`check-boundaries`), modules own their behavior, workers stay
credential-minimized, and the config schema has drift tests against
`.env.example`. Two observations for future work, deliberately not done here:

- The six layered web CSS files (`motion-system`, `visual-refinement`,
  `conversation-polish`, `navigation-rethink`, `navigation-bloom`,
  `mobile-chat-final`) are sediment from successive design passes. Now that
  the dead generations are gone they total ~1,500 live lines; folding them
  into a deliberate structure (tokens / chrome / chat) would prevent the next
  pass from stacking a seventh layer. Needs visual regression checking, so it
  belongs in its own change.
- `mobile-nav-bloom.tsx` no longer blooms — it is the top-right anchored
  mobile menu. A rename (`mobile-nav-menu.tsx`, `navigation-bloom.css` →
  `navigation-mobile.css`) would stop the name from misleading; skipped here
  to keep this audit reviewable.
