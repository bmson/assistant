# Knowledge graph: evidence-led exploration

## Direction

The graph should help answer “What do we know about this person or project, why do we believe it, and what needs correcting?” A whole-graph drawing is useful for orientation, but the selected item and its source-backed connections are the primary interface.

Keep PostgreSQL/pgvector, the existing offline extraction pipeline, owner-only recall boundaries, and source-level review. This increment does not add a graph database, import more private sources, run extraction, or create inferred relationships.

## Implemented

- Map labels and search honor owner display-name overrides while preserving search by original names.
- Opening an item explicitly loads its neighborhood instead of relying on its presence in the newest 500 edges. The existing 200-node/500-edge bounds still apply.
- Web and iOS group identical directed, time-qualified connections for presentation; supporting evidence and review remain attached to the original rows. No stored facts are merged or deleted.
- The inspector uses complete relationship sentences, never reverses an incoming relation, and distinguishes reviewed connections from unreviewed extraction. Multiple sources are not presented as a numerical truth score.
- Web offers a focus filter, keyboard-accessible item browser, source excerpts/full notes, connected-item traversal, and an explicit link to the correct edit/review panel. The same inspector works on a phone without requiring a dense canvas.
- Small graphs fit the canvas. Responsive dragging converts screen pixels into SVG units, distinguishes a drag from a node click, and cancels cleanly.
- iOS keeps selection after refresh/review, ignores obsolete loads, exposes connected-item traversal with a return trail, and groups evidence under a compact disclosure. Corrections remain source-specific.
- Proactive gap questions use graph recall's current-source eligibility checks: rejected, quarantined, stale, unembedded, or unsupported source projections cannot create questions. Uncertain-connection questions identify both endpoints rather than an unnamed “something.”

## Next improvements, not implemented

1. **A single connection read model across every surface.** Currently the overview counters, review list, and recall count source-level edges; the new inspector groups claims. Introduce explicit `connectionCount`, `sourceCount`, and `needsReviewCount` in the application projection, with independent review state for each source. Extend the native API before moving aggregation into storage.
2. **Time-aware knowledge and disagreements.** Display current, historical, and conflicting claims separately. `validFrom`/`validUntil` already exist, but a past employer must not answer a current-employer question. The gap detector's legacy predicate equivalents also suppress present-day questions for historical predicates (`born_in` vs `lives_in`, `worked_at` vs `works_at`). Replace these with temporal rules and owner-relevant, paced questions; do not automatically resolve disagreements or erase history.
3. **Useful connections to existing work.** Link graph entities to explicitly associated Situation Packs, commitments, and people. Keep those references inspectable; semantic guesses should be suggestions the owner accepts, not silently established facts. Decide source scope before adding ingestion or schema changes.
4. **Explain a connection, with evidence at every step.** Existing bounded graph paths can support “How are these connected?” Show each hop, date span, and source separately; distinguish a path from proof of a new relationship. Evaluate with directed-family, former-employer, duplicate-name, rejected-source, and missing-evidence cases.
5. **Native browsing at scale.** The iPhone canvas now supports bounded neighborhood expansion and search. Native paging and shared history/navigation semantics remain future work beyond the explicit 200-node canvas bound.

## Validation

- `pnpm test` prepares only the isolated `_test` database.
- `pnpm typecheck`, `pnpm lint`, and `git diff --check`.
- Native simulator tests plus manual connected-item traversal and review-preserves-selection checks.
- `scripts/visual-qa/knowledge-graph.ts` seeds synthetic data only into a local `_test` database and checks desktop/mobile navigation, direction, grouping, responsive panning, overflow, and browser errors. Run against localhost:3107 with development authentication enabled. It must not run concurrently with database-resetting tests.

Live account validation requires an authenticated bot.bmson.com session. Local verification does not imply deployment or a production migration.

### Editing relationship evidence from People

- Tap a specific entry inside Relationship evidence or Recorded details to inspect its complete source, correct the relationship with a new owner note, or remove the claim.
- `GET /api/mobile/v1/knowledge/relations/:id` resolves an exact owner-scoped row, independent of browse/review limits. `DELETE` retires that row as rejected, preserving its original source and unrelated claims. Missing rows return 404, never a false success.
- Corrections reuse the existing source-backed replacement operation. Native correction previews preserve subject/object direction, including son/daughter predicates; custom predicates remain editable. Saving refreshes the current person and invalidates other cached dossiers.
- Requires both the updated mobile server routes and a new iOS build. No schema migration is needed.
- `scripts/visual-qa/people-evidence.ts` creates a conflicting parent/son pair in a local `_test` database without invoking models. Tests cover exact-row access beyond browse limits, source/sibling preservation, preview direction, failed removals, and cache invalidation. Visual inspection covered disclosure, source detail, and correction form; removal was verified through the local API after simulator window switching prevented the final confirmation tap. No real relationship records were changed.

### Verified on September 6, 2026

- Final repository run: 209 test files, 1,893 passing tests; typecheck, lint, architecture boundaries, and diff checks passed.
- Final native run: 136 passing tests, zero failures or skips. The earlier locked-session scroll test failure did not recur in either unlocked rerun.
- Simulator interaction: followed Alex → Robin; expanded two supporting sources under one connection; confirmed a source without changing selection or collapsing evidence; marked one source inaccurate while preserving the remaining source; returned to Alex.
- Visually inspected the final grouped native cards in dark mode and the responsive web inspector. Browser navigation, source grouping, responsive panning, and phone overflow checks passed using isolated synthetic data.
- No production mutation, graph migration, model extraction, push, or deployment was performed.

### Person pages and expandable trees — September 7, 2026

- Important dates now have an Edit action on web and iPhone, including a direct entry from the native person page. Edits update the same occasion ID, can correct or clear the year and notes, preserve reminder lead time, and refresh the directory and dossier. The shared application command rejects impossible calendar dates and missing or foreign-owner occasion IDs. Mobile uses `PATCH /api/mobile/v1/memory/occasions/:id`. No schema change is needed.
- Web person pages put dates and the connection tree before the folded record list. The knowledge map offers a Tree switch for the selected item. Branches load on demand, group identical directed and time-qualified claims, show cycle references, and support focus navigation with breadcrumbs. Each expansion starts with 50 source records and can grow to the existing 250-record cap; the remaining count is visible. Tree traversal explores the selected item's neighborhood beyond the overview filters.
- Source inspection resolves the exact claim directly, independent of the review-page limit. Remove controls retire one source-backed claim as rejected, preserve original notes and other claims, and refresh People as well as Knowledge. If another source supports the same relationship, that connection remains visible.
- iPhone offers a native expandable people tree from both the person page and the directory connection browser. It preserves ancestor references, refreshes the visible branch after removal, and links to profiles for further exploration. At five nested levels, the profile link continues navigation. Native traversal requires an explicitly linked contact and uses the existing bounded dossier; the web tree also traverses places, projects, and organizations.

Design uses the existing green-paper canvas (#eef5f0), white panels (#ffffff), leaf accent (#217a4b), ink (#15201a), and quiet borders (#d3e1d7), with the app's existing type system. Indentation and branch lines carry the hierarchy. Dates remain visible while administrative records sit behind disclosure. Names and relationship sentences wrap; expansion feedback respects Reduced Motion.

Validation: 211 repository test files / 1,904 passing tests; 160 passing native tests, followed by a passing targeted snapshot run after refining field labels and tree presentation. Typecheck, lint, architecture boundaries, and diff checks passed. `scripts/visual-qa/person-tree.ts` uses only synthetic local `_test` data to exercise persisted birthday edits, cleared year/notes, preserved lead time, invalid dates, nested expansion, cycles, focus/breadcrumb navigation, cancellation, source inspection, partial evidence removal, and phone overflow. The existing map interaction regression script also passed. Light/dark native screenshots were inspected. Native touch traversal and removal were not manually exercised on a physical phone. Requires a web release and a new iOS build; no production records were changed.

### iPhone force-directed relationship graph — September 7, 2026

- A full-screen native canvas opens from People, a person’s Explore graph action, and Knowledge. Small nodes and subtle lines reveal connected clusters; node size reflects distinct neighbors. Drag individual nodes, pan the background, pinch or use zoom buttons, and fit the graph. Selecting a node highlights its neighborhood without resetting the viewport. Filters show people or a selected neighborhood; search reaches items beyond the current snapshot.
- UIKit owns drawing and gestures. A bounded spring simulation preserves existing positions as the graph expands, stops after settling or leaving the foreground, and respects Reduce Motion. Labels avoid node dots and other labels. The native list alternative opens automatically at accessibility text sizes and remains available through Graph options. VoiceOver can select canvas nodes or use the searchable list.
- Connections opens a source-level inspector with directed sentences, dates, review state, original notes, editing, removal, and navigation to the other endpoint. Removing one claim retains its original note and any other supporting source. Explicitly linked contacts open their person profiles.
- `GET /api/mobile/v1/knowledge/graph` uses the existing owner-scoped, active-source graph query. It resolves a person’s actual graph entity, supports isolated selected items, includes contact links, and exposes truncation. The existing snapshot bounds remain; native expansion caps the canvas at 200 nodes and 1,000 source rows. Searching beyond the node bound opens that item’s neighborhood. No storage migration or new extraction is involved; this increment adds no web graph UI.
- Validation: 212 repository test files / 1,909 passing tests; typecheck and lint passed. All 166 native tests passed, followed by focused gesture and snapshot tests for the final refinements. Native tests cover source deduplication, refresh/removal merging, 200-node finite layout, pinning, pan cancellation, selection stability, and zoom anchoring. Inspected light/dark, dense, empty, and large-text simulator screenshots. Touch gestures and frame rate have not been profiled on a physical iPhone.
- Delivery requires the mobile API release and a new iOS build. No production records were changed and no deployment was performed.

### Connecting loose groups — September 7, 2026

- The mobile graph completes eligible existing connections between visible nodes after selecting the bounded overview. This recovers older bridges hidden by recent source rows and also shows relationships among the neighbors of a focused item. It adds no inferred claims, includes no new endpoints during completion, caps the response at 1,000 source rows, and preserves partial-view indicators and source eligibility.
- Disconnected components occupy separate areas, with subtle group surfaces, stable centers, and an explicit Tidy layout action. Low-degree labels no longer collide with their own node hit bounds. Summary controls now reserve space above the canvas instead of obscuring nodes.
- The group count opens Connect loose groups. Small groups can be focused, expanded, or connected; single items appear in one compact list. Counts and prompts describe the loaded view, and the People-only filter explains hidden place/project bridges.
- Select an item and use Connect to search existing entities, browse other groups, or use shared recorded neighbors as a navigation hint. The owner explicitly chooses the predicate and source note. The editor preserves chosen entity IDs, supports reversing endpoints, prevents self-links and saving without a relationship, and requires a deliberate new-item path. Successful saves reload the neighborhood and update connected groups.
- Native list navigation scrolls the selected item's controls into view at accessibility sizes. Group and connection sheets share the app's canvas and accent colors.
- Validation: 1,910 repository tests and 170 native tests passed, with further focused simulator snapshots after visual refinements. Typecheck, lint, and diff checks passed. The integration test creates 500 recent rows plus an older bridge, checks recovery without new nodes, and confirms rejected claims remain excluded. Inspected light/dark graph, group browser, connection chooser, and editor screenshots. Manual touch walkthrough was blocked by the locked Mac; physical-device frame-rate profiling remains outstanding.

### A readable, stationary iPhone graph — September 7, 2026

- The directory graph now starts with named starting points and search. Opening a person or item shows its center and at most four direct neighbors, with stable alphabetical pages and a visible loaded-connection count. The full map is an explicit overview. Search, the full connected-item list, and source inspection keep the rest reachable; no stored entities or claims are removed.
- Focused maps label each line and show the recorded direction with an arrow. Multiple distinct directed or time-qualified claims use a relationship count; duplicate source notes do not multiply that count. Selecting a neighbor shows a complete relationship sentence and an explicit Open map action. Back navigation restores the previous item and connection page.
- The canvas no longer runs a live spring simulation. Tapping preserves positions and the viewport, blank taps keep the selection, and dragging pans even when it starts over a node. Reposition nodes is an explicit option. Overview layout is computed before drawing; evidence refresh preserves existing positions. The selection panel reserves steady space, and viewport offsets compensate for changes in canvas size.
- Large accessibility text uses the full connection list and vertically stacked controls. Focused node labels support two lines. Existing native colors and typography are retained.
- Validation: 184 native tests passed, followed by four focused passing tests after the final accessibility refinement. Coverage includes 200-item paging without omissions, directed evidence preservation, pan-over-node behavior, cancellation, selection, evidence refresh, and viewport stability when controls change height. Repository lint and architecture checks passed with eight existing TypeScript non-null-assertion warnings; diff checks passed.
- Hands-on simulator walkthrough used an isolated synthetic 80-item graph: reproduced the crowded overview and selection shift, then exercised named entry, neighbor selection, Open map, return navigation, paging, connection inspection, and zoom. Final light/dark and accessibility screenshots were inspected under `.artifacts/graph-usability-final/`. Simulator drag automation did not reliably perform a gesture; pan/cancellation were verified through native tests. The Mac locked before the final manual rerun. Physical-device touch and frame-rate validation remain unperformed.
- This is a local iOS change and requires a new iOS build. No API, schema, production records, push, or deployment were changed.

### Opening on a name rather than on the whole graph — September 13, 2026

The map on both surfaces drew everything it had. At the scale a real graph reaches
that is not a dense map but an unreadable one: two hundred names overlapping in one
frame, no name legible, no way in, and — on web — an inspector pointed at whichever
node the relaxation happened to emit first.

- **Web opens on starting points.** Search, plus the best-connected items of each kind
  with their connection counts, grouped and named. The whole-graph drawing is an
  explicit choice, one button away. The relaxation no longer runs when the map opens;
  it is computed when the overview is asked for.
- **The focused view is its own drawing, not the overview zoomed in.** The item in hand
  sits at the centre of an ellipse of up to twelve neighbours, ranked most-connected
  first, with positions computed for exactly the items on screen — so no name can
  collide with another. Each spoke carries the vocabulary's direction-free phrase, an
  arrowhead in the recorded direction, and a count when more than one distinct claim
  supports it. An incoming claim is never reworded from the centre's side. Below `md`
  the same spokes render as a list: a 356px canvas cannot hold readable names.
- **The web overview is readable.** Names are rationed by a collision pass — the
  selection and the biggest hubs first, each placed only where it lands on empty canvas
  — and drawn outside the panned group at a constant on-screen size, measured from the
  rendered width, so zooming reveals more rather than shrinking what is there. The
  canvas reports how many items in view are too crowded to name. A kind legend was added;
  nothing had explained the colours.
- **The iPhone focused map pages six, not four.** Four was never a readability limit: it
  was the number of fixed corner slots the canvas had, and a fifth neighbour was drawn
  on top of the first. Spokes now sit on an ellipse taller than it is wide, so each name
  gets its own horizontal band. Direction arrows and relationship phrases claim their
  space so a name is not drawn with an arrow through it, phrases moved two thirds of the
  way out where the spokes have fanned apart, and a name on a focused map is never
  dropped — if all four sides are contested it takes the least contested one.
- **The iPhone overview names its hubs.** It previously named everything above one zoom
  level and nothing below it, and a real graph never fits above that zoom, so it arrived
  as two hundred anonymous dots. It now spends a ration of names on the most connected
  items, slid back inside the canvas rather than clipped by its edge.
- Two native drawing faults behind the above: dots and names were painted interleaved, so
  the hub's name — placed first, being the most important — spent the rest of the pass
  being covered by the dots drawn after it; and label backings were translucent, so the
  lines the placement search cannot see about showed through as a stroke across the word.

No storage migration, API change, extraction run, or new inferred relationship. Source-level
review, evidence, correction, and removal are untouched. Delivery needs a web release and a
new iOS build.

Validation: 261 repository test files / 2,314 passing tests; `pnpm typecheck`, `pnpm lint`,
architecture boundaries, and `git diff --check` pass. 197 native tests pass on the iOS 27
simulator, including new coverage for ring separation (the old slot list wrapped with `% 4`,
which that test fails) and for the overview naming its biggest hub (which fails against the
old zoom gate). `scripts/visual-qa/knowledge-graph.ts` was updated to the new flow and passes
against an isolated local `_test` database: starting points on arrival, no overview canvas
until asked for, named spokes carrying their phrases, pan on the whole map, return to focus,
and the ring absent at phone width with the spokes listed instead. Focused and overview
native canvases were rendered and inspected in light and dark. Three repository tests failed
under a non-UTC `ASSISTANT_TIMEZONE` in the local `.env` and pass at UTC; they are unrelated
to this change. Touch gestures and frame rate on a physical iPhone remain unprofiled, and
nothing was verified against the live account.

The dev server's client bundle does not boot when addressed as `127.0.0.1` — the RSC payload
never runs, so nothing hydrates — which is why the QA script now uses `localhost`, as
`launch.json` already did. That is a pre-existing dev-server issue, not part of this change.

### iPhone memory and map, rebuilt for touch — September 26, 2026

The owner found the phone's memory pages too busy to use — a wall of bordered buttons, a
second graph inside Knowledge, and a map that was hard to move around — and asked for the
map to behave like Obsidian's graph. This reverses the September 13 decision to open the
iPhone map on a list of names: the whole map is now the front door, and the failure mode
that decision guarded against (two hundred overlapping names) is handled by fading names
in with zoom instead.

- **The map is alive.** A d3-style force simulation (repulsion, links pulling to a rest
  length, weak gravity, cooling `alpha`) runs on a display link while it settles and stops
  when it is at rest. A cold start is run most of the way before the first frame so the map
  opens recognisable. Reduce Motion settles it synchronously.
- **Touch like Obsidian.** Drag a dot and its neighbours follow, then the map settles; drag
  the background to pan, with momentum; pinch to zoom, two-finger pan while pinching;
  double-tap to zoom in, or to fly to a dot. This replaces the explicit "Reposition nodes"
  toggle and the drag-always-pans rule from September 7.
- **Zoom in to learn more.** Names fade in by zoom × importance, so hubs are named from
  further out than leaves; a collision pass and an 18-name ration at low zoom still apply,
  and names already showing are preferred so they do not flicker. Closer in, each name gains
  "Kind · N links", arrowheads appear on every line in the recorded direction, and past
  1.9× every line carries its phrase. A selection dims everything outside its neighbourhood.
- **Connect by drawing.** Hold a dot, drag onto another, let go: a short sheet asks only how
  they relate (suggested phrases by kind, or free words, with swap direction) and an
  optional note. With no note the source reads "Connected by the owner on the relationship
  map." — the claim still carries a truthful source, as the server requires.
- **Full screen, few controls.** Close, a count pill that fits the map, Find, and one
  options menu float over the canvas. Selecting a dot brings up an opaque card: name, kind,
  counts, the neighbours as tappable chips (the way to walk the graph), and three actions —
  Connections, Connect, and a menu with Open profile and Rename or merge. The focused
  six-spoke ring, paging, Tidy and Reposition were removed. Connections are a list of
  sentences with swipe-to-confirm; each opens its source, Confirm, Show on the map, Correct
  and Remove.
- **Memory home is one list.** A live preview of the map (tap for full screen), anything
  waiting for approval, five facts with the rest one tap away, and a More section (Open
  loops, Profile summary, Writing voice, Tidy up the map, Your data). A fact is a row: tap
  for a sheet with everything that can be done to it; swipe to confirm/approve or
  forget/reject; long-press for the same. The metric tiles, the people cards (People owns
  those), the voice panel and the organizer moved off the home page.
- **Knowledge became "Tidy up the map".** Its browsing half duplicated the map and was
  removed, along with `KnowledgeGraphView`; the cleanup findings remain.

No API, schema, or stored-data change; it needs a new iOS build. Accessibility text sizes
and the "Show as a list" option still get the whole map as a list; VoiceOver elements still
describe each dot's connections. Validation: the full native suite passes on the iOS 27
simulator, with new coverage for settling, collision spacing, drag-follows-neighbour,
node-drag vs pan, the connect gesture (self and empty drops ignored), label fading, and
snapshots of the memory home and the map opened on an item in light and dark. Touch feel
and frame rate have not been checked on a physical iPhone.

### The map keeps up with changes; a note is optional — September 26, 2026

- **Saved changes now show on the map.** After a save, confirm or correction the phone re-fetched
  the item's neighbourhood but skipped merging it whenever the map already held 200 items — which
  on a real account is always — so nothing visibly changed. The map is now a sliding window of up
  to 320 items: a fetched neighbourhood always merges, fresh claims about the item replace its old
  ones, and when the window is full the items furthest away in hops (unreachable first, then the
  least connected) are let go. The neighbourhood just fetched, the selection and the last twelve
  items visited are never let go, so walking back retraces familiar ground. Letting go marks the
  view partial. A drawn connection also appears instantly as a provisional line, replaced by the
  real claim when the fetch returns.
- **The source note is optional**, on web and iPhone, for new connections and corrections alike.
  The owner stating the relationship is the provenance: an owner-drawn edge is still saved as a
  durable owner memory, reading `Anna parent of Baldvin.`, with ` Owner note: …` appended only when
  a note was written. Relationship and endpoints remain required.
- **Connect to something new.** Letting a connection thread go on open canvas, pulled at least
  90pt from its item, opens the connect sheet with a name and type for a new item; the thread
  shows a "+" once it is far enough out. The card's Connect button now uses the same short sheet
  for both existing and new items instead of the long connection form.
- **Hide me.** The owner's own item is hidden by default, because it links to nearly everything
  and pulls the map into one star. "Show me" in the options menu brings it back, as does picking
  yourself from Find or a neighbour chip. Your connections still appear on other people's cards.

Server change (core owner-fact creation, both persistences) plus a new iOS build.

### Graph search stopped crashing the server — September 27, 2026

Find on the iPhone map never returned: every keystroke called the browse overview
(`GET /api/mobile/v1/knowledge?q=`), which on Firestore loads every entity, relation and full
memory document to answer one page. Production logs showed those requests taking 18–54s and the
container dying with "JavaScript heap out of memory" at ~510 MB, so they came back as 503s and
the phone waited on them.

- `GET /api/mobile/v1/knowledge?mode=search&q=` now answers type-ahead from the existing
  projected entity search (names and kinds only, owner-scoped, up to 30 results; names that
  start with the query, then names with a word that does, lead). Postgres uses the same
  `searchKnowledgeGraphEntities` the web merge picker does.
- The iPhone's Find, the Connect sheet's search and the merge picker use it, with a 300ms
  debounce, and show "couldn't search" instead of a spinner when a request fails. An older
  server that ignores `mode` still answers with `entities`, so the app degrades gracefully.
- The browse overview itself is still heavy on Firestore; nothing on the iPhone calls it for
  search any more, but it remains a follow-up.

### A more complete overview and connection picker — September 29, 2026

- Web and mobile graph overviews scan all eligible source-backed relationship records before applying display bounds. The former newest-500-record slice no longer decides which people exist on the opening map. Each distinct directed, time-qualified connection receives space before additional evidence rows, preserving older people even when a recent pair has many sources.
- The expanded overview holds up to 1,000 items and 10,000 source rows; the native merge window uses the same bounds. Larger views still report truncation and remain searchable. Existing source eligibility, evidence IDs, review state, and owner scoping are retained. No records are inferred or changed.
- Both native connection editors offer the missing extended family choices, including grandmother, grandfather, grandparent, grandchildren, aunt, uncle, niece, nephew, and cousin, along with the missing existing work/date/location choices. Family previews preserve subject/object direction. Grandchild is also included in the shared vocabulary used by web.
- Validation: focused graph/predicate/transport regression tests, repository typecheck and lint/architecture checks, and native app/test compilation. The full database suite cannot start because local PostgreSQL and Docker are unavailable. Native tests cannot execute because no simulator runtime is available. No physical-device performance or production account verification was performed. Delivery requires a web/API release and an iOS build; no deployment was performed.

### Regrouping after connections — September 29, 2026

- Disconnected components have separate, stable centers, and first placement follows a hub-led spanning tree so related branches begin together. A bridge merges its groups' destinations and reheats the existing layout; unrelated components keep their destinations. Hubs retain a minimum spring strength so new connections between busy items can still pull them closer.
- A spatially bounded corridor force clears bubbles away from other connections. At rest, a bounded endpoint-swap pass accepts only changes that reduce crossings, preserve components and bubble clearance, and keep incident line length within 15% of its prior length. The resulting targets ease into place. Dense graphs can still have crossings.
- Reduce Motion now resolves changed topology before painting rather than freezing an added line's endpoints. Regrouping waits while a pan, pinch, or connection gesture owns the canvas. Selection and the camera remain unchanged. Evidence changes that retain the same topology do not wake the layout.
- Validation: 17 actual graph-model XCTest cases passed on macOS using the repository model and fixtures, including cluster joins, crossing clearance, directed topology, finite 200-node layout, pinning, and unchanged-refresh stability. The temporary macOS harness replaced the test's simulator-only diagnostic attachment with console output. iOS app and test compilation passed; simulator UI tests and physical-device performance were not executed because no simulator runtime is available. An optimized Mac benchmark exercised 1,000 synthetic nodes; this is not phone frame-rate validation. No release or deployment was performed.

### Reviewable family suggestions — September 29, 2026

- Saving a parent/child or sibling connection on iPhone checks the refreshed graph for related family connections. A recorded mother/father/parent plus a sibling can suggest the same parent for that sibling; two children of one recorded parent can suggest a sibling connection; two parent steps can suggest a grandparent, preserving an explicitly recorded mother/father role. Inverse child and sibling relationships are recognized, and source duplicates do not multiply suggestions.
- The review sheet explains each suggestion and shows its supporting connection sentences, review status, and original source notes. It does not assume siblings share both parents. Add connection performs a normal owner-backed save; Not right persists a dismissal on this phone. Unaccepted proposals never become evidence for subsequent proposals. Accepted connections can offer another reviewable step.
- Before accepting, the app reloads the eligible graph, checks the original support IDs and the proposed role, and suppresses already recorded or changed proposals. Rejected/unknown and dated support is not used. Eligible unreviewed evidence remains explicitly labelled and is not silently confirmed. Both native connection forms use the committed relation ID to scope suggestions to the connection just saved. The graph refreshes after review closes.
- This runs deterministic rules on the graph available to the phone, within the existing overview bounds; at most 40 proposals are offered per step. No inferred relations are written without a separate owner action. Non-family saves do not perform the additional suggestion read. Existing active-source/owner-scoped mobile graph reads are reused; no API transport or database migration is required.
- Validation: graph/family model XCTest cases passed on macOS against repository source and fixtures; iOS app and test compilation passed. Tests cover mother-of-sibling suggestions from either trigger, inverse direction, existing/inverse claims, grandparents, half-sibling wording, unreviewed-source labels, rejection, temporal qualifiers, removed evidence, duplicate sources, and cycles. Simulator UI execution and physical-device interaction remain unverified because no simulator runtime is available. This is a local iOS change and requires a new iPhone build; no deployment or production mutation was performed.
