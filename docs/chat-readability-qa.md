# Chat readability and response-card validation

Updated September 2, 2026. Changes are implemented in the web transcript and native Swift message renderer; they are not a production deployment.

## Card structure

The existing paper-on-green visual system is preserved: paper `#ffffff`, ink `#15201a`, muted sage `#5e7266`, separator `#d3e1d7`, inset `#e6efe9`, and leaf accent `#217a4b`. Existing app typefaces and native system fonts remain in use.

| Content | Presentation |
| --- | --- |
| Latest-answer context | Quiet sentence-case header inside the card; never sticky or offset while scrolling |
| Ordinary prose | Unboxed text, comfortable reading measure, preserved single line breaks |
| Named sections | Stronger heading type and one quiet divider; short bold list labels are recognized conservatively |
| Code | Small code icon and language header, separate monospaced body, safe wrapping |
| Quotes | Small quote icon and tinted inset; native quoted lists retain their structure |
| Tables | Readable labels and values; wide web tables become labeled records on phones; native rows wrap vertically |
| Checklists | Hanging alignment keeps wrapped labels beside their checkboxes |
| Arithmetic | Web KaTeX with safe wrapping and currency normalization; native elementary arithmetic fallback, not a full TeX engine |

The frontend-design skill guided this restrained hierarchy: structural UI encodes content types, while ordinary paragraphs remain simple. No decorative gradient rails were added.

## Exercise and evidence

The corpus contains 30 plausible user messages, generated once with the original framing and once with revised readability framing. The saved 60 responses were rendered again after the UI changes; they were not silently rewritten to make the screenshots pass.

- Corpus and generation/staging utility: `scripts/visual-qa/chat-readability-prompts.json` and `chat-readability.ts`.
- Generation is a separately opted-in, metered operation. It requires an allocator-marked disposable PostgreSQL target and an explicit cap, for example `pnpm exec tsx scripts/visual-qa/chat-readability.ts generate baseline --max-usd=0.50` with `ASSISTANT_ALLOW_LIVE_CHAT_READABILITY=1`. Each attempt is preflight-reserved against one archived per-run task; unknown/open usage stops the run. Run-ID keyed response files are create-only, with private append-only usage journals and recovery manifests. After capture/review, `pnpm exec tsx scripts/visual-qa/chat-readability.ts cleanup` removes only namespaced fixture messages from manifest-verified conversations and retains cost accounting.
- Repeatable web capture: `pnpm exec tsx scripts/visual-qa/capture-readability.ts` with the local web app and database running. Optional case numbers select targeted rechecks, for example `...capture-readability.ts 13 18`.
- Web screenshots: `.artifacts/chat-readability/semantic-ui/{baseline,reframed}-{1280,390}/`. Each response has a start and end screenshot: 240 images covering 60 responses at two widths.
- Native screenshots: `.artifacts/chat-readability/semantic-ui/native-verified/manifest.json` maps 60 Swift ImageRenderer attachments to the same response IDs. These render the actual `MessageBubble`, not a web imitation.
- Native reproduction: run the `Assistant` Xcode test scheme. `AssistantMarkdownTests.testReadabilityCorpusSnapshots` attaches the saved corpus renders when local generated-response files exist; otherwise it skips that optional visual test. Export its attachments with `xcresulttool export attachments --test-id 'AssistantMarkdownTests/testReadabilityCorpusSnapshots()'`.
- Independent reviewer reports: `.artifacts/chat-readability/semantic-ui/baseline-review.md`, `reframed-review.md`, and `native-review.md`.

The first web recapture raced initial scroll restoration and was rejected. The capture utility now waits for initial layout, uses normal transcript scrolling, and places ending content above the composer lane. Reviewers inspected all 240 corrected web screenshots and all 60 initial native renders, then rechecked affected cases after fixes.

## Defects found and corrected

| Finding | Resolution |
| --- | --- |
| Current answer covered scrolled text | Removed web sticky positioning and native visual-effect offsets |
| Font hierarchy did not apply in Swift | Shared text helper now accepts the semantic font directly |
| Hard breaks created extra blank lines | Removed the duplicate newline following a rendered hard break |
| Explicit and generated dividers doubled | Corrected selector specificity and retained one separator |
| Code/quote blocks lacked recognizable structure | Added quiet icon headers and consistent inset styling |
| Small, fragmented mobile tables | Raised table type and used labeled records for wide tables |
| Native table headers showed Markdown or truncation | Inline Markdown rendering and vertically wrapping labels |
| Native quoted lists collapsed | Rendered quote contents as structured Markdown blocks |
| Formula syntax appeared as red/raw source | Normalized mixed Markdown/currency in web math and added readable native arithmetic |
| Checklist continuations fell below the checkbox | Correct hanging text alignment |

## Verification boundaries

- Final independent review: reframed 30/30 pass; baseline 29/30 pass with one content-only partial (case 24). No unresolved material native rendering defect remains after all 60 initial cards and 18 corrected cards were inspected.
- Production web build, repository lint, architecture boundaries, and typechecks pass. The build retains an existing `unpdf` import warning unrelated to this formatting work.
- The final full JavaScript suite passed: 197 files / 1,706 tests. The focused formatting/card suite passes 29 tests, including the wide-table regression.
- Native final-source run passed 81 tests, including the 60-render corpus capture. Result bundle: `/tmp/assistant-ios-readability-final-derived/Logs/Test/Test-Assistant-2026.09.02_08-40-19--0700.xcresult`.
- Web metrics across 120 case/width combinations found zero page-level horizontal overflows and zero overflowing code blocks. Current-answer positioning is `static`.
- Independent reviewers confirmed the web current-answer header disappears during scrolling. Native offset removal is source-verified; component snapshots do not prove native gesture behavior or composer overlap.
- Long web replies can extend beyond both sampled viewport images. Native full-card images cover their full rendered content. This is not a claim that every transient scroll position, Dynamic Type setting, theme, or device has been validated.
- Some original generated responses are incomplete, notably the missing Final QA section in case 24 and an unfinished ending in case 30. Formatting preserves that source; it does not invent missing content. Revised framing improves completeness and scanability.
- Advanced unsupported native TeX remains outside this exercise's elementary arithmetic support.

Generated outputs and screenshots stay in ignored `.artifacts`; reusable code, tests, the corpus, and this report are reviewable in the repository.
