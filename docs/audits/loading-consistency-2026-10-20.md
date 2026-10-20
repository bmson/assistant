# Loading layout consistency — October 20, 2026

A separate, bounded follow-up to the conversation work in PR #621. This branch starts at `ff7f4971` and therefore includes that dependency; it does not modify the frozen PR #621 checkout. The review preserves the current palette, spacing, type and loading animation.

## Confirmed findings

Browser pixels and individual element bounds confirm that fixed-width loading bars can extend past the page gutter at 320px. The generic loader's automatic grid track can also grow wider than the page, even when a child already has `max-w-full`. At doubled root text (32px), the People and Memory supporting bars request 768px inside a 256px content area. Document `scrollWidth` alone misses this failure because horizontal overflow is clipped; the full-page capture and element rectangles expose it.

The person-loading identity disc shrinks to 44.28125 × 56px at normal text and 36.46875 × 112px at doubled text. The primitive's default corner radius also wins over its ordinary `rounded-full` caller class. The actual loaded `PersonAvatar` is already circular and does not shrink; it needs no source change.

## Small repair

- Bound the shared Skeleton with `min-w-0 max-w-full` so requested widths remain preferences inside their available space.
- Give the generic loading page one explicit, bounded grid track with `grid-cols-1`.
- Keep the person-loading disc from shrinking and explicitly apply its existing full radius above the primitive's default radius. Its adjacent bar retains its original desired width and can shrink normally.

All changes are confined to the Skeleton class and two loading components. The loaded person component, loaded page layouts, tokens, animation and data behavior are unchanged.

## Executed checks and evidence

The [verification receipt](assets/loading-consistency-2026-10-20/verification.json) records source hashes and measurements for 48 before and 48 after captures: all five actual loading components, plus the actual loaded `PersonAvatar` in a representative identity row, at 320px and 1280px, normal 16px and doubled 32px root text, light and dark themes. The loader captures use the exact root layout's main-container classes and actual global stylesheet. Motion is reduced for deterministic still images.

All final skeleton rectangles stay within their parent and viewport. Every skeleton height is preserved. Every 1280px skeleton width and height is preserved. The loaded avatar's dimensions are identical before and after; the loading disc now measures 56 × 56px or 112 × 112px with a computed circular radius. Element checks accompany visual inspection, rather than relying on document width alone.

| Example | Before | After |
| --- | --- | --- |
| People, normal text / light | ![People loading overflow](assets/loading-consistency-2026-10-20/before-people-320-16-light.png) | ![People loading bounded](assets/loading-consistency-2026-10-20/after-people-320-16-light.png) |
| Person, doubled text / dark | ![Person loading narrow identity marker](assets/loading-consistency-2026-10-20/before-person-320-32-dark.png) | ![Person loading circular identity marker](assets/loading-consistency-2026-10-20/after-person-320-32-dark.png) |
| Generic page, doubled text / light | ![Generic loading expanded grid](assets/loading-consistency-2026-10-20/before-page-320-32-light.png) | ![Generic loading bounded grid](assets/loading-consistency-2026-10-20/after-page-320-32-light.png) |

Local lint and typecheck passed. Independent QA and final-head CI remain separate gates. This is component-browser evidence, not authenticated route admission, transition timing, browser zoom, a physical-device test or production deployment. No owner reads, model calls or remote media were used.

Full original images, receipts and the capture harness are retained under `.workspace/loading-review/` in the isolated `loading-layout-review` checkout. `before` is the exact `ff7f4971` source; `after-final-circular` is the final candidate. Intermediate exploratory captures are excluded from the portable receipt. Replay from the checkout with `pnpm exec tsx --tsconfig apps/web/tsconfig.json .workspace/loading-review/capture.ts <fresh-output-directory>`.
