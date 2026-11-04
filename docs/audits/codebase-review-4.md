# Codebase review, round four — writing and organization

An audit focused on how the code is written and organized: folder structure,
file sizes, function and variable naming, comment and documentation quality,
and overall simplicity. Run after round three on an otherwise green tree, and
verified against the same four gates: `pnpm lint` (Biome + architecture
boundaries), `pnpm typecheck` (all 12 workspace tasks plus `scripts/`), the
full vitest suite against a real pgvector Postgres (132 files, 960 passing),
and `pnpm build`. Green before the changes, green after.

## What is already in good shape

Most of what this audit went looking for was simply not there to find:

- **Structure.** The layering (`apps` → `application`/`tools` → `core` → `db`,
  everything through `config`) is machine-enforced by `check-boundaries`, so it
  cannot rot silently. Optional modules each own a uniform
  `module.ts`/`meta.ts`/`labels.ts` shape; the application package exposes each
  area as a two-line facade over `commands.ts`/`queries.ts`; workers are small
  and purpose-scoped (the largest worker file is 252 lines).
- **Naming.** Every source file is kebab-case; exported functions are
  verb-first and read at the call site; there are zero `any` casts outside of
  test files (the only greps that matched were inside prose comments).
- **Debt markers.** No TODO/FIXME/HACK comments anywhere in the tree.
  `console.log` appears only in process entry points, seeds, and scripts,
  where it is operational output rather than leftover debugging.
- **Comments.** The density is high and almost entirely _rationale_: comments
  explain invariants, prod incidents that motivated a guard, and why the
  obvious alternative is wrong. Exported surfaces carry doc comments.

## Findings and changes

The findings that remained were organizational sediment — files whose names
recorded the design pass that created them rather than what they contain, and
three files that had grown two concerns each.

### Web CSS: pass names → content names

The stylesheet layers were named after redesign passes
(`visual-refinement.css`, `conversation-polish.css`, `navigation-rethink.css`,
`navigation-bloom.css`, `mobile-chat-final.css`), and the newest file existed
only to override the one imported before it. Renamed to describe content, and
the override layer folded in:

- `visual-refinement.css` → `chrome.css` (app-wide surfaces and depth)
- `conversation-polish.css` → `conversation.css` (chat styling)
- `navigation-rethink.css` → `navigation.css` (desktop palette)
- `navigation-bloom.css` → `navigation-mobile.css`, with
  `mobile-chat-final.css` appended at its end and deleted as a file

Because `mobile-chat-final.css` was the last import and `navigation-mobile.css`
is now the last import, the concatenation preserves the cascade order of every
rule byte-for-byte — this is a rename-only change to the computed styles. The
file headers now describe the layer's content instead of the pass that
produced it. A true re-authoring into tokens/chrome/chat (round three's
deferred idea) still needs visual regression coverage and remains future work.

### `mobile-nav-bloom.tsx` → `mobile-nav-menu.tsx`

The round-three rename, now done: the component is the top-right anchored
mobile menu (all of its classes are `nav-mobile-menu-*`), so it is named
`MobileNavMenu` in a file that says so.

### `packages/tools/src/builtin/index.ts`: 1,033 lines, two concerns

The file held both the SSRF-guarded public web fetch (address classification,
DNS pinning, redirect re-validation, byte caps — ~300 lines of security
boundary) and the registration of every builtin tool. The web-fetch machinery
moved to `builtin/web-fetch.ts` with a header stating its contract; `index.ts`
(728 lines) is now only tool registration and re-exports `web-fetch.js`, so
the package surface and the poller's imports are unchanged. The tests split
the same way (`web-fetch.test.ts` for the network boundary,
`index.test.ts` for trust capabilities). This also fixed a misplaced doc
comment: the bot-challenge rationale block was stacked on top of
`extractWebText`'s doc comment; it now sits on `looksLikeBotChallenge`, the
function it describes.

### `packages/tools/src/dispatcher.ts`: risk gating vs. wording

The ~110-line switch of owner-facing approval wording
(`approvalFallbackSummary` and its helpers) is presentation, not dispatch
logic. It moved to `approval-summaries.ts` — pairing with the existing
`approval-summaries.test.ts`, which asserts summary coverage across the full
registry — leaving `dispatcher.ts` (918 lines) to the pipeline itself.

### `apps/web/app/chat/[id]/chat-client.tsx`: 1,458 lines

Nearly 400 of those lines were self-contained presentational components (day
dividers, the presence orb and rows, the work trail, notice cards, recall
provenance) plus the date/text helpers they share. They moved to
`message-view.tsx` (pure props-in/markup-out, per its header); the stateful
streaming component remains in `chat-client.tsx` at 1,072 lines. Splitting the
component's own state machine further was considered and rejected — its
hooks are interdependent and a split would trade one long readable file for
prop-drilling.

### Documentation references

`docs/anticipation-layer.md` and `docs/long-running-chat-memory.md` cite
specific line ranges in `builtin/index.ts`; those were updated to the
post-split positions.

## Deliberately left alone

- **`packages/db/src/schema.ts` (1,477 lines).** One authoritative schema
  file, one table per block, with its cross-table constraints visible in one
  place. Splitting it would scatter foreign-key context to save nothing.
- **The other long files** (`model-router/router.ts`,
  `google/email-sync.ts`, `workflow/executor/step-loop.ts`,
  `memory/import.ts`, `agent/canaries.ts`). Each was outlined for this audit
  and each is one cohesive concern, already decomposed into well-named
  file-private functions with rationale comments. Length here is subject-matter
  size, not disorganization; splitting would separate code from the invariants
  its neighbors enforce.
- **Test files above 1,000 lines.** E2E suites narrate full scenarios; their
  length is the scenario's, and they share the source's naming discipline.
