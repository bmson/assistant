#!/usr/bin/env python3
"""Benchmark the checked-in value layout on a macOS host, without UIKit.

This measures synthetic geometry work, not iPhone rendering or frame pacing.
The source slices below keep the solver and DTOs unchanged. No owner data,
network request, simulator, or third-party Python dependency is used.
"""

import hashlib
import json
import platform
import subprocess
import tempfile
from pathlib import Path


def between(source: str, start: str, end: str) -> str:
    return source[source.index(start) : source.index(end)]


def main() -> None:
    ios = Path(__file__).resolve().parents[1]
    graph_path = ios / "Assistant/Models/RelationshipGraph.swift"
    models_path = ios / "Assistant/Models/APIModels.swift"
    graph = graph_path.read_text()
    models = models_path.read_text()
    dto = between(models, "struct KnowledgeEntity:", "struct KnowledgeSearchResponse:")
    dto += between(models, "struct KnowledgePresentation:", "struct KnowledgeSource:")
    solver = graph[: graph.index("/// A possible family connection")]
    harness = r'''
func milliseconds(_ work: () -> Void) -> Double {
    let start = DispatchTime.now().uptimeNanoseconds
    work()
    return Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
}

var rows: [[String: Any]] = []
for count in [50, 200, 1000] {
    let nodes = (0..<count).map {
        RelationshipGraphNode(id: String(format: "node-%04d", $0), label: "Item \($0)", kind: "person")
    }
    // Fixed degree-four ring topology: connected, reproducible, owner-free.
    // This is not the maximum 10,000-edge graph or a real memory distribution.
    let links = (0..<count).flatMap { index in
        [GraphLink(nodes[index].id, nodes[(index + 1) % count].id),
         GraphLink(nodes[index].id, nodes[(index + 17) % count].id)]
    }
    var seed = RelationshipGraphLayout()
    let seedMs = milliseconds { seed.update(nodes: nodes, links: links) }
    var warmup: RelationshipGraphLayout?
    let warmupMs = milliseconds { warmup = seed.prepared(maxSteps: 150, isCancelled: { false }) }
    var still: RelationshipGraphLayout?
    let stillMs = milliseconds { still = seed.prepared(maxSteps: 400, isCancelled: { false }) }
    guard var live = warmup, let still else { fatalError("Unexpected cancelled preparation") }
    // Keep live physics warm rather than measuring a settled no-op.
    live.hold(0.3)
    var steps: [Double] = []
    for _ in 0..<60 { steps.append(milliseconds { live.step() }) }
    steps.sort()
    let checksum = still.positions.reduce(0.0) { $0 + Double($1.x) + Double($1.y) }
    guard checksum.isFinite, seed.positions.count == count else { fatalError("Invalid layout") }
    rows.append([
        "nodes": count, "links": links.count, "seed_ms": seedMs,
        "prepare_150_ms": warmupMs, "prepare_400_ms": stillMs,
        "still_settled": still.isSettled,
        "live_step_median_ms": steps[steps.count / 2],
        "live_step_p95_ms": steps[Int(Double(steps.count - 1) * 0.95)],
        "live_step_max_ms": steps.last!, "geometry_checksum": checksum,
    ])
}
let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
'''
    compiler = subprocess.check_output(["xcrun", "swiftc", "--version"], text=True).strip()
    with tempfile.TemporaryDirectory(prefix="assistant-graph-benchmark-") as directory:
        source = Path(directory) / "main.swift"
        executable = Path(directory) / "graph-benchmark"
        source.write_text(solver + "\n" + dto + "\n" + harness)
        subprocess.run(["xcrun", "swiftc", "-O", str(source), "-o", str(executable)], check=True)
        rows = json.loads(subprocess.check_output([str(executable)], text=True, timeout=60))
    print(json.dumps({
        "scope": "synthetic macOS value-layout CPU work; excludes UIKit and iPhone frame timing",
        "host": platform.platform(), "architecture": platform.machine(),
        "compiler": compiler, "optimization": "-O", "samples_per_live_step": 60,
        "graph_source_sha256": hashlib.sha256(graph.encode()).hexdigest(),
        "models_source_sha256": hashlib.sha256(models.encode()).hexdigest(),
        "results": rows,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
