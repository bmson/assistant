# Relationship map preparation

The relationship map stays in UIKit so drawing and finger movement do not
rebuild SwiftUI. Its deterministic value-layout retains existing node positions
when the snapshot expands. Pan, pinch, connect, selection, and viewport ownership
remain in `RelationshipGraphCanvasView`.

Opening the map previously ran as many as 150 force steps synchronously inside
`configure`. Reduce Motion and force tuning could run 400 synchronously; the
Memory preview then kept stepping and fitting on the main display loop. Each
force step scans node pairs. Removing the synchronous batch is therefore a
substantive change in where computation happens, even without a frame benchmark.

The canvas now draws its deterministic seed immediately and prepares a
`Sendable` copy in a detached task. The interactive map warms for at most 150
steps. The Memory preview and Reduce Motion prepare at most 400. The worker
checks cancellation between steps and before returning a result; it never
mutates UIKit, the current viewport, or the live layout. Normal motion adopts
the prepared positions through the existing position interpolation, avoiding
an abrupt node jump. Reduce Motion and the preview adopt a still replacement.

Each topology or force replacement advances a generation and cancels the old
task. Publication requires the current generation, matching node identity, and
no active touch/navigation. Display-only settings changed during preparation
are reapplied without reheating physics. Completion can fit a camera that has
not been touched; the owner's panned, zoomed, or selected camera is retained.

Touch, pan, pinch, connect, and explicit camera commands cancel an unfinished
normal warmup. The visible positions become the starting point for subsequent
live physics, which still pauses during navigation. Reduce Motion retains a
request for a still layout and resumes its background preparation after release.
Temporary window removal cancels work and resumes the request on return.
Representable dismantling drops the request; deallocation also cancels the
worker, whose capture of the view is weak.

There is no global graph cache, new dependency, network operation, or memory
retention policy. Node IDs, topology, gesture math, safe areas, and navigation
commands retain their existing contracts.

## Remaining performance work

This refactor removes the opening force batch from the UI thread. It does not
make the force solver subquadratic or establish a measured frame rate. Cold
seeding, topology derivation, live force steps, accessibility projection, and
drawing still run on the main thread. Pairwise node repulsion and the crossing
resolution pass require profiling at the supported node and edge caps. A
cancelled task stops between steps; an individual expensive step cannot be
interrupted. The 400-step preparation is a bound, not a guarantee of convergence
for every graph and force setting.

Before changing the solver or gesture cadence, record time to a useful preview,
main-thread frame time, cancellation latency, and peak memory on a supported
iPhone with expected and maximum graph sizes. Check normal/reduced motion,
touch before preparation completes, topology and force changes during work,
rapid presentation/dismissal, selection and resize, and pan-to-pinch handoff.

## Repeatable host baseline

Run `python3 apps/ios/tools/benchmark-graph.py` from the repository on macOS.
The dependency-free runner extracts the unchanged checked-in layout and DTO
definitions, compiles an optimized host executable, and reports source hashes,
compiler/host identity, cold seeding, bounded preparation and 60 warm live steps.
It uses synthetic degree-four rings at 50, 200 and 1,000 nodes, never owner data.
Temporary source and binaries are removed after the run.

The [October 3 result](../../../docs/audits/assets/graph-layout-host-2026-10-03.json)
used arm64 macOS, Swift 6.4 and `-O`:

| Nodes / links | Seed | 150-step preparation | 400-step preparation | Live step median / p95 |
| --- | --- | --- | --- | --- |
| 50 / 100 | 0.30 ms | 9.46 ms | 15.98 ms | 0.004 / 0.183 ms |
| 200 / 400 | 0.28 ms | 59.18 ms | 178.18 ms | 0.072 / 1.017 ms |
| 1,000 / 2,000 | 1.37 ms | 553.90 ms | 1,039.36 ms | 1.637 / 7.547 ms |

This single synthetic run makes the opening batch's CPU cost concrete and
provides a repeatable solver baseline. It excludes UIKit drawing, text,
accessibility, device thermals, task scheduling and user gestures, and does not
cover the 10,000-edge cap. Its sample p95 is a host geometry statistic, not an
iPhone or production frame claim. Preparation moves this work off the interface
thread; it does not remove the work. Maximum-density and device measurements
are still required before choosing solver or rendering budgets.

## Validation

Focused source tests cover cancellation without mutating the seed, agreement
with the existing force steps, smooth adoption, obsolete snapshot and force
results, display-only tuning, touch-owned positions/viewport, removal, and
Reduce Motion deferral during navigation. The existing Reduce Motion connection
test now awaits preparation before checking regrouping and the preserved camera.

The native audit records the latest generic build-for-testing result. No runnable
simulator runtime is installed in this environment. Compilation checks the app,
extension, and test sources; it does not execute XCTest, render a screenshot,
measure a frame, or verify physical gestures.
