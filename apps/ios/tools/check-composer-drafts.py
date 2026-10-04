#!/usr/bin/env python3
"""Run the pure draft XCTest method bodies on macOS without UIKit.

This compiles the unchanged production store and the five pure test methods.
It does not run the native AppModel/network cases or validate iPhone gestures.
"""

import json
import subprocess
import tempfile
from pathlib import Path


def main() -> None:
    ios = Path(__file__).resolve().parents[1]
    store = (ios / "Assistant/Models/ConversationDrafts.swift").read_text()
    tests = (ios / "AssistantTests/ConversationDraftsTests.swift").read_text()
    pure = tests[tests.index("final class ConversationDraftsTests:") : tests.index("extension ConversationDraftsTests")]
    pure = pure.replace(": XCTestCase", "")
    methods = [line.split("func ")[1].split("(")[0] for line in pure.splitlines() if "    func test" in line]
    assertions = '''
var assertionCount = 0
func check(_ value: Bool, _ message: String = "") {
    assertionCount += 1
    precondition(value, message)
}
func XCTAssertEqual<T: Equatable>(_ a: T, _ b: T) { check(a == b) }
func XCTAssertNotEqual<T: Equatable>(_ a: T, _ b: T) { check(a != b) }
func XCTAssertNil<T>(_ a: T?) { check(a == nil) }
func XCTAssertTrue(_ a: Bool) { check(a) }
func XCTAssertFalse(_ a: Bool) { check(!a) }
'''
    calls = "\n".join(f"tests.{name}()" for name in methods)
    run = "let tests = ConversationDraftsTests()\n" + calls + '\nprint(assertionCount)\n'
    with tempfile.TemporaryDirectory(prefix="assistant-draft-check-") as directory:
        source = Path(directory) / "main.swift"
        executable = Path(directory) / "draft-check"
        source.write_text(store + assertions + pure + run)
        subprocess.run(["xcrun", "swiftc", str(source), "-o", str(executable)], check=True)
        assertions_passed = int(subprocess.check_output([str(executable)], text=True, timeout=30).strip())
    print(json.dumps({"scope": "actual pure store and XCTest method bodies; excludes UIKit and AppModel tests",
        "methods_passed": len(methods), "assertions_passed": assertions_passed}, indent=2))


if __name__ == "__main__":
    main()
