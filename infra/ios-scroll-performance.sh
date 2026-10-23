#!/usr/bin/env bash
set -Eeuo pipefail

output_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-scroll-performance"
worktree_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-scroll-performance-worktrees"
baseline_ref="${BASELINE_REF:-14ba202b8c9593623f3fe3c817319c15e40f6ffa}"
candidate_ref="${CANDIDATE_REF:-${GITHUB_SHA:-HEAD}}"
repeats="${REPEATS:-5}"
run_mode="${RUN_MODE:-diagnostic}"
phase="${PHASE:-all}"

case "$repeats" in
  1|2|3|4|5) ;;
  *) echo "REPEATS must be an integer from 1 through 5" >&2; exit 2 ;;
esac

case "$run_mode" in
  diagnostic|matrix|smoke|correctness|profile) ;;
  *) echo "RUN_MODE must be diagnostic, correctness, smoke, matrix, or profile" >&2; exit 2 ;;
esac

case "$phase" in
  build|runtime|all) ;;
  *) echo "PHASE must be build, runtime, or all" >&2; exit 2 ;;
esac

mkdir -p "$output_root" "$worktree_root"
compact_output="$output_root/compact-diagnostics"
mkdir -p "$compact_output"
exec > >(tee -a "$output_root/driver.log") 2>&1

package_raw_bundles() {
  local original_status="$1"
  local archive="$output_root/raw-xcresults.tar.gz"
  local temporary_archive="$archive.tmp"
  local package_receipt="$compact_output/package-receipt.json"
  local bundle_paths=() bundle_names=()
  rm -f "$archive" "$temporary_archive"
  while IFS= read -r -d '' bundle; do
    bundle_paths+=("$bundle")
    bundle_names+=("${bundle##*/}")
  done < <(find "$output_root" -mindepth 1 -maxdepth 1 -type d \
    \( -name '*.xcresult' -o -name '*.trace' -o -name '*-dsyms' \) -print0)

  if [[ "${#bundle_paths[@]}" -eq 0 ]]; then
    printf '{"archive":"raw-xcresults.tar.gz","bundleCount":0,"status":"no-result-bundles","scriptExitStatus":%s}\n' \
      "$original_status" > "$package_receipt"
    return 0
  fi

  rm -f "$temporary_archive"
  if run_optional_bounded 180 "$output_root/package-raw-xcresults.log" \
      tar -czf "$temporary_archive" -C "$output_root" "${bundle_names[@]}" \
      && [[ -s "$temporary_archive" ]]; then
    mv "$temporary_archive" "$archive"
    printf '{"archive":"raw-xcresults.tar.gz","bundleCount":%s,"status":"complete","scriptExitStatus":%s}\n' \
      "${#bundle_paths[@]}" "$original_status" > "$package_receipt"
    echo "Packaged ${#bundle_paths[@]} raw result/profiling bundle(s) into $archive; originals remain on disk."
  else
    rm -f "$temporary_archive"
    printf '{"archive":"raw-xcresults.tar.gz","bundleCount":%s,"status":"failed-or-timed-out","scriptExitStatus":%s,"note":"Raw result bundles were preserved; see package-raw-xcresults.log."}\n' \
      "${#bundle_paths[@]}" "$original_status" > "$package_receipt"
    echo "::warning::Could not package xcresult bundles within 180s; originals remain on disk."
  fi
}

finish_runner() {
  local original_status=$?
  trap - EXIT
  printf '{"phase":"%s","scriptExitStatus":%s}\n' "$phase" "$original_status" \
    > "$compact_output/runner-exit.json"
  if [[ "$phase" != "build" ]]; then package_raw_bundles "$original_status" || true; fi
  exit "$original_status"
}
trap finish_runner EXIT

validate_matrix_warmups() {
  python3 - "$compact_output" "$run_mode" "${variants[@]}" <<'PY'
import json
import math
import pathlib
import re
import sys

directory = pathlib.Path(sys.argv[1])
run_mode = sys.argv[2]
variants = sys.argv[3:]
expected_probe = run_mode == "smoke"
errors = []
setups = {}

def read_json(path):
    try:
        return json.loads(path.read_text())
    except Exception as error:
        errors.append(f"{path.name}: cannot read JSON receipt ({error})")
        return None

def number(value):
    return isinstance(value, (int, float)) and math.isfinite(value)

for variant in variants:
    stem = f"{variant}-500rows-warmup-00"
    receipt = read_json(directory / f"{stem}-receipt.json")
    if not receipt or receipt.get("xcodebuildExitStatus") != 0:
        errors.append(f"{variant}: 500-row warmup did not exit successfully")

    setup_receipt = read_json(directory / f"{stem}-setup.json")
    stage_records = setup_receipt.get("setups", []) if setup_receipt else []
    expected_stages = {"initial-top", "warm-target", "scored-start"}
    actual_stages = {record.get("phase") for record in stage_records if isinstance(record, dict)}
    if not setup_receipt or setup_receipt.get("setupMarkerCount") != 3 or actual_stages != expected_stages:
        errors.append(f"{variant}: expected setup records for initial-top, warm-target, and scored-start")
        continue
    digests = {record.get("canonicalFixtureSHA256") for record in stage_records}
    digest = next(iter(digests)) if len(digests) == 1 else None
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        errors.append(f"{variant}: setup record has no canonical fixture SHA-256")
    viewports = []
    for setup in stage_records:
        if setup.get("renderProbeInstrumented") is not expected_probe:
            errors.append(f"{variant}: {setup.get('phase')} setup probe instrumentation does not match {run_mode} mode")
        if setup.get("notScoredPerformance") is not expected_probe:
            errors.append(f"{variant}: {setup.get('phase')} setup score label does not match {run_mode} mode")
        if setup.get("canonicalFixtureSHA256") != digest or setup.get("messageCount") != 500:
            errors.append(f"{variant}: {setup.get('phase')} setup record fixture identity is invalid")
        if setup.get("setupValid") is not True or setup.get("positioningProtocol") != "direct-UIKit-top-target-top":
            errors.append(f"{variant}: {setup.get('phase')} setup positioning did not pass")
        if setup.get("geometrySampleCount", 0) < 4:
            errors.append(f"{variant}: {setup.get('phase')} setup has too few geometry samples")
        viewport = setup.get("viewportHeightPoints")
        observed, requested = setup.get("observedOffsetPoints"), setup.get("requestedOffsetPoints")
        if not number(viewport) or viewport <= 100:
            errors.append(f"{variant}: {setup.get('phase')} setup viewport is missing or implausible")
        else:
            viewports.append(viewport)
        if not number(observed) or not number(requested) or abs(observed - requested) > 2:
            errors.append(f"{variant}: {setup.get('phase')} setup endpoint is outside ±2 points")
    if len(viewports) != 3 or max(viewports, default=0) - min(viewports, default=0) > 2:
        errors.append(f"{variant}: setup viewports differ by more than 2 points")
    viewport = viewports[-1] if viewports else None
    setups[variant] = (digest, viewport)

    records_path = directory / f"{stem}.jsonl"
    try:
        records = [json.loads(line) for line in records_path.read_text().splitlines() if line.strip()]
    except Exception as error:
        errors.append(f"{variant}: cannot read phase records ({error})")
        continue
    timed_records = [record for record in records
                     if record.get("mode") == "full-chat-view-fixed-five-usable-viewports"]
    if len(timed_records) != 2:
        errors.append(f"{variant}: expected exactly two timed phase JSON records, found {len(timed_records)}")
    phases = {record.get("phase"): record for record in timed_records}
    for phase_name in ("fixed-five-viewports-down", "fixed-five-viewports-up"):
        record = phases.get(phase_name)
        if not record:
            errors.append(f"{variant}: missing {phase_name} phase record")
            continue
        if record.get("messageCount") != 500 or record.get("canonicalFixtureSHA256") != digest:
            errors.append(f"{variant}: {phase_name} fixture identity does not match its setup record")
        if record.get("renderProbeInstrumented") is not expected_probe:
            errors.append(f"{variant}: {phase_name} probe instrumentation does not match {run_mode} mode")
        if record.get("notScoredPerformance") is not expected_probe:
            errors.append(f"{variant}: {phase_name} score label does not match {run_mode} mode")
        phase_viewport = record.get("viewportHeightPoints")
        if not number(phase_viewport) or not number(viewport) or abs(phase_viewport - viewport) > 2:
            errors.append(f"{variant}: {phase_name} viewport differs from its setup viewport by more than 2 points")
        if record.get("timedOut") is not False or not isinstance(record.get("callbackCount"), int) or record["callbackCount"] < 30:
            errors.append(f"{variant}: {phase_name} did not produce a valid timed phase")
        endpoints = (
            record.get("observedStartOffsetPoints"), record.get("observedEndOffsetPoints"),
            record.get("requestedFromOffsetPoints"), record.get("requestedToOffsetPoints"),
        )
        if not all(number(value) for value in endpoints):
            errors.append(f"{variant}: {phase_name} is missing observed/requested endpoints")
        elif abs(endpoints[0] - endpoints[2]) > 2 or abs(endpoints[1] - endpoints[3]) > 2:
            errors.append(f"{variant}: {phase_name} observed endpoints are more than 2 points from requested endpoints")

if len(variants) > 1 and len(setups) == len(variants):
    baseline_digest, baseline_viewport = setups[variants[0]]
    for variant in variants[1:]:
        digest, viewport = setups[variant]
        if digest != baseline_digest:
            errors.append(f"{variant}: canonical fixture SHA differs from {variants[0]}")
        if number(viewport) and number(baseline_viewport) and abs(viewport - baseline_viewport) > 2:
            errors.append(f"{variant}: setup viewport differs from {variants[0]} by more than 2 points")

report = {
    "gate": "matrix-warmup",
    "runMode": run_mode,
    "expectedRenderProbeInstrumented": expected_probe,
    "variants": variants,
    "status": "failed" if errors else "passed",
    "errors": errors,
}
(directory / "matrix-warmup-gate.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
print(json.dumps(report, sort_keys=True))
sys.exit(1 if errors else 0)
PY
}

if [[ "${1:-}" == "--validate-warmups" ]]; then
  shift
  variants=("$@")
  if [[ -z "${WARMUP_RECEIPTS_DIR:-}" || "${#variants[@]}" -lt 1 ]]; then
    echo "Usage: RUN_MODE=matrix|smoke WARMUP_RECEIPTS_DIR=/path/to/receipts bash infra/ios-scroll-performance.sh --validate-warmups baseline [candidate]" >&2
    trap - EXIT
    exit 2
  fi
  compact_output="$WARMUP_RECEIPTS_DIR"
  if validate_matrix_warmups; then validation_status=0; else validation_status=$?; fi
  trap - EXIT
  exit "$validation_status"
fi

repo_root="$(git rev-parse --show-toplevel)"

resolve_commit() {
  local ref="$1"
  local sha
  sha="$(git -C "$repo_root" rev-parse --verify "${ref}^{commit}" 2>/dev/null || true)"
  if [[ -z "$sha" ]]; then
    git -C "$repo_root" fetch --no-tags origin "$ref"
    sha="$(git -C "$repo_root" rev-parse --verify 'FETCH_HEAD^{commit}')"
  fi
  printf '%s' "$sha"
}

baseline_sha="$(resolve_commit "$baseline_ref")"
candidate_sha="$(resolve_commit "$candidate_ref")"
harness_sha="$(resolve_commit "${GITHUB_SHA:-$candidate_sha}")"
if [[ "$run_mode" == "profile" && "$baseline_sha" != "$candidate_sha" ]]; then
  echo "::error::Profile mode requires identical baseline and candidate commits; this is one quiet-scroll trace, not a comparison."
  exit 2
fi
baseline_production_tree="$(git -C "$repo_root" rev-parse "${baseline_sha}:apps/ios/Assistant")"
candidate_production_tree="$(git -C "$repo_root" rev-parse "${candidate_sha}:apps/ios/Assistant")"
same_production_tree=false
if [[ "$baseline_production_tree" == "$candidate_production_tree" ]]; then
  same_production_tree=true
fi

cat > "$output_root/refs.txt" <<EOF
baseline_ref=$baseline_ref
baseline_sha=$baseline_sha
baseline_production_tree=$baseline_production_tree
candidate_ref=$candidate_ref
candidate_sha=$candidate_sha
candidate_production_tree=$candidate_production_tree
harness_sha=$harness_sha
same_production_tree=$same_production_tree
repeats=$repeats
phase=$phase
benchmark_test_class=ConversationScrollPerformanceTests
benchmark_methods=testFullChatView100RowColdMountBidirectionalStreamAndAppend,testFullChatView500RowColdMountBidirectionalStreamAndAppend
diagnostic_methods=testFullChatView100RowSettledBidirectionalDiagnostic,testFullChatView500RowSettledBidirectionalDiagnostic
correctness_method=APIClientRetryTests/testChatFollowsNewMessagesAndGrowingStreamWhileAtBottom
matrix_method=testFullChatView500RowFixedWindowBidirectional
run_mode=$run_mode
profile_method=testFullChatView500RowQuietScrollProfile
cache_plan=matrix-only: direct-UIKit-position-at-top-then-five-viewport-target-then-top-before-timing; each-result-is-a-fresh-xcodebuild-test-invocation
metric_note=CADisplayLink callback intervals are not presented-frame FPS; simulator results are comparative evidence only.
EOF

echo "Runner: $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
echo "Baseline: $baseline_sha (production tree $baseline_production_tree)"
echo "Candidate: $candidate_sha (production tree $candidate_production_tree)"
echo "Benchmark harness source: $harness_sha"
echo "Same production tree: $same_production_tree; mode: $run_mode; phase: $phase; repeats: $repeats"

latest_xcode="$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)"
if [[ -z "$latest_xcode" ]]; then
  echo "::error::No Xcode installation found on the hosted runner."
  exit 1
fi
sudo xcode-select -s "$latest_xcode"
export DEVELOPER_DIR="$latest_xcode/Contents/Developer"
echo "Selected Xcode: $latest_xcode"
xcodebuild -version | tee "$output_root/xcode-version.txt"
xcodebuild -showsdks | grep -i 'iphoneos' | tee "$output_root/ios-sdks.txt" || true

simulator_json="$output_root/simulators.json"
xcrun simctl list devices available --json > "$simulator_json"
simulator_udid="$(jq -r '[.devices | to_entries[]
  | .key as $runtime
  | select($runtime | test("SimRuntime.iOS-"))
  | ($runtime | split("iOS-")[1] | split("-") | map(tonumber)) as $version
  | select($version[0] >= 26)
  | .value[] | select(.name | startswith("iPhone"))
  | . + {runtimeVersion: $version}]
  | sort_by(.runtimeVersion) | last | .udid // empty' "$simulator_json")"
if [[ -z "$simulator_udid" ]]; then
  echo "::error::No available iPhone simulator compatible with the iOS 26 deployment target found on this runner."
  xcrun simctl list devices available
  exit 1
fi
jq -r --arg udid "$simulator_udid" '.devices[][] | select(.udid == $udid) | "Simulator: \(.name) (\(.udid)) runtime=\(.state)"' "$simulator_json"
echo "simulator_udid=$simulator_udid" >> "$output_root/refs.txt"
simulator_runtime="$(jq -r --arg udid "$simulator_udid" '.devices | to_entries[] | select(any(.value[]; .udid == $udid)) | .key' "$simulator_json")"
printf 'developer_dir=%s\nsimulator_runtime=%s\n' "$DEVELOPER_DIR" "$simulator_runtime" >> "$output_root/refs.txt"

fixture_test_source="infra/ios-scroll-fixtures/ConversationScrollPerformanceTests.swift"
fixture_helper_source="infra/ios-scroll-fixtures/ConversationPerformanceFixture.swift"
render_probe_source="infra/ios-scroll-fixtures/ConversationRenderProbe.swift"
fixture_test="apps/ios/AssistantTests/ConversationScrollPerformanceTests.swift"
fixture_helper="apps/ios/AssistantTests/ConversationPerformanceFixture.swift"
project_file="apps/ios/Assistant.xcodeproj/project.pbxproj"
candidate_project_snapshot="$output_root/candidate-project.pbxproj"
git -C "$repo_root" show "${harness_sha}:${project_file}" > "$candidate_project_snapshot"

overlay_harness() {
  local tree="$1"
  mkdir -p "$tree/$(dirname "$fixture_test")"
  git -C "$repo_root" show "${harness_sha}:${fixture_test_source}" > "$tree/$fixture_test"
  git -C "$repo_root" show "${harness_sha}:${fixture_helper_source}" > "$tree/$fixture_helper"
  local message_bubble="$tree/apps/ios/Assistant/Components/MessageBubble.swift"
  local render_probe="$output_root/ConversationRenderProbe.swift"
  git -C "$tree" show "HEAD:apps/ios/Assistant/Components/MessageBubble.swift" > "$message_bubble"
  git -C "$repo_root" show "${harness_sha}:${render_probe_source}" > "$render_probe"
  python3 - "$message_bubble" "$render_probe" "$run_mode" <<'PY'
from pathlib import Path
import sys

target, probe_path = map(Path, sys.argv[1:3])
run_mode = sys.argv[3]
text = target.read_text()
body_anchor = "        // The inner menus below cover the prose bubbles;"
parse_anchor = "    init?(part: MessagePart, formRendererAvailable: Bool) {\n"
if "ConversationRenderProbe" in text:
    raise SystemExit("MessageBubble already contains the test-only render probe")
if text.count(body_anchor) != 1:
    raise SystemExit(f"Expected exactly one MessageBubble body anchor, found {text.count(body_anchor)}")
if text.count(parse_anchor) != 1:
    raise SystemExit(f"Expected exactly one explicit card parser anchor, found {text.count(parse_anchor)}")

probe_text = probe_path.read_text()
instrumentation_flag = "    static let callSitesInstalled = false\n"
if probe_text.count(instrumentation_flag) != 1:
    raise SystemExit("Expected exactly one render-probe instrumentation flag")
if run_mode == "smoke":
    probe_text = probe_text.replace(
        instrumentation_flag,
        "    static let callSitesInstalled = true\n",
        1,
    )
    text = text.replace(
        body_anchor,
        "#if DEBUG\n        let _ = ConversationRenderProbe.shared.recordBodyEvaluation()\n        #endif\n" + body_anchor,
        1,
    )
    text = text.replace(
        parse_anchor,
        parse_anchor + "#if DEBUG\n        if part.type == \"data-card\" {\n            ConversationRenderProbe.shared.recordExplicitCardParseAttempt()\n        }\n        #endif\n",
        1,
    )
probe_path.write_text(probe_text)
text += probe_text
target.write_text(text)
PY

  # The test fixture is the only build-registration change allowed in a source
  # tree. Copy just its four PBX records; never overlay the candidate project,
  # which could include unrelated production registration changes.
  if ! grep -q 'C000000000000000000000C4 /\* ConversationPerformanceFixture.swift \*/' "$tree/$project_file"; then
    python3 - "$tree/$project_file" "$candidate_project_snapshot" <<'PY'
from pathlib import Path
import sys

target = Path(sys.argv[1])
candidate = Path(sys.argv[2])
text = target.read_text()
source = candidate.read_text().splitlines()
file_ref_id = "C000000000000000000000C4"
build_file_id = "B000000000000000000000C4"
file_ref = next((line for line in source if line.lstrip().startswith(file_ref_id + " ") and "PBXFileReference" in line), None)
build_file = next((line for line in source if line.lstrip().startswith(build_file_id + " ") and "PBXBuildFile" in line), None)
group_ref = next((line for line in source if line.strip().startswith(file_ref_id + " ") and line.rstrip().endswith(",")), None)
source_ref = next((line for line in source if line.strip().startswith(build_file_id + " ") and line.rstrip().endswith(",") and "in Sources" in line), None)
if not all((file_ref, build_file, group_ref, source_ref)):
    raise SystemExit("Candidate project does not contain all four fixture registration records")

def insert_before(marker: str, line: str) -> None:
    global text
    if marker not in text:
        raise SystemExit(f"Baseline project lacks expected section marker: {marker}")
    text = text.replace(marker, line + "\n" + marker, 1)

insert_before("/* End PBXBuildFile section */", build_file)
insert_before("/* End PBXFileReference section */", file_ref)
group_anchor = "\t\t\t\tC00000000000000000000020 /* APIModelsTests.swift */,"
if group_anchor not in text:
    raise SystemExit("Baseline test group lacks the expected APIModelsTests anchor")
text = text.replace(group_anchor, group_anchor + "\n" + group_ref, 1)
sources_anchor = "\t\t\t\tB000000000000000000000C1 /* ConversationScrollPerformanceTests.swift in Sources */,"
if sources_anchor not in text:
    raise SystemExit("Baseline test sources lack the expected scroll benchmark anchor")
text = text.replace(sources_anchor, sources_anchor + "\n" + source_ref, 1)
target.write_text(text)
PY
  fi

  printf 'test_sha256=%s\n' "$(shasum -a 256 "$tree/$fixture_test" | awk '{print $1}')"
  printf 'fixture_sha256=%s\n' "$(shasum -a 256 "$tree/$fixture_helper" | awk '{print $1}')"
  printf 'messagebubble_sha256=%s\n' "$(shasum -a 256 "$message_bubble" | awk '{print $1}')"
  printf 'overlay_script_sha256=%s\n' "$(shasum -a 256 "$repo_root/infra/ios-scroll-performance.sh" | awk '{print $1}')"
  printf 'render_probe_sha256=%s\n' "$(shasum -a 256 "$render_probe" | awk '{print $1}')"
  printf 'project_fixture_registered=%s\n' "$(grep -q 'ConversationPerformanceFixture.swift' "$tree/$project_file" && echo yes || echo no)"
}

add_worktree() {
  local label="$1" sha="$2" path="$worktree_root/$1"
  if git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local existing_sha
    existing_sha="$(git -C "$path" rev-parse HEAD)"
    if [[ "$existing_sha" != "$sha" ]]; then
      echo "::error::Existing $label worktree is at $existing_sha, expected $sha."
      return 1
    fi
    echo "Reusing $label worktree at $sha"
  else
    if [[ -e "$path" ]]; then
      echo "::error::$label worktree path exists but is not a Git worktree: $path"
      return 1
    fi
    git -C "$repo_root" worktree add --detach "$path" "$sha" >/dev/null
  fi
  overlay_harness "$path" > "$output_root/$label-fixtures.txt"
  echo "Prepared $label worktree at $sha"
}

add_worktree baseline "$baseline_sha"
if [[ "$same_production_tree" != true ]]; then
  add_worktree candidate "$candidate_sha"
else
  echo "Skipping a redundant candidate build: apps/ios/Assistant production trees match."
fi

build_state="$output_root/build-state.txt"
expected_build_state="baseline_sha=$baseline_sha
candidate_sha=$candidate_sha
harness_sha=$harness_sha
run_mode=$run_mode
render_probe_protocol=smoke-messagebubble-body-and-explicit-card-parser-v1
baseline_production_tree=$baseline_production_tree
candidate_production_tree=$candidate_production_tree"
if [[ "$phase" == "runtime" ]]; then
  if [[ ! -f "$build_state" ]] || [[ "$(cat "$build_state")" != "$expected_build_state" ]]; then
    echo "::error::Runtime phase has no matching completed build state; run PHASE=build first with the same refs."
    exit 1
  fi
fi

set_variant_common() {
  local label="$1" tree="$worktree_root/$1"
  local derived="$RUNNER_TEMP/ios-scroll-derived/$label"
  common=(
    -project "$tree/apps/ios/Assistant.xcodeproj"
    -scheme Assistant
    -configuration Release
    -destination "id=$simulator_udid"
    -destination-timeout 60
    -derivedDataPath "$derived"
    -parallel-testing-enabled NO
    ENABLE_TESTABILITY=YES
    SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG
    ONLY_ACTIVE_ARCH=YES
    CODE_SIGNING_ALLOWED=NO
    CODE_SIGNING_REQUIRED=NO
    CODE_SIGN_IDENTITY=
  )

}

build_variant() {
  local label="$1"
  local log="$output_root/$label-build.log"
  local derived="$RUNNER_TEMP/ios-scroll-derived/$label"
  set_variant_common "$label"
  mkdir -p "$derived"
  echo "Building $label once for testing."
  run_xcode_bounded 1800 "$log" xcodebuild "${common[@]}" build-for-testing

  # Keep matching debug symbols beside the raw trace so call trees can be
  # symbolicated after artifact download, even when a test itself fails.
  local symbol_root="$output_root/${label}-dsyms"
  mkdir -p "$symbol_root"
  local copied=0
  while IFS= read -r -d '' symbol; do
    ditto "$symbol" "$symbol_root/$(basename "$symbol")"
    copied=$((copied + 1))
  done < <(find "$derived/Build/Products" -maxdepth 5 -type d \
    \( -name 'Assistant.app.dSYM' -o -name 'AssistantTests.xctest.dSYM' \) -print0 2>/dev/null || true)
  echo "Archived $copied app/test dSYM bundle(s) for $label at $symbol_root."
}

run_xcode_bounded() {
  local timeout_seconds="$1" log="$2"
  shift 2
  local status=0
  python3 - "$timeout_seconds" "$log" "$@" <<'PY' || status=$?
import os
import signal
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
log_path = sys.argv[2]
command = sys.argv[3:]
with open(log_path, "wb") as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        status = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        log.write(f"\nTimed out after {timeout_seconds}s; terminating xcodebuild process group.\n".encode())
        log.flush()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                log.write(b"xcodebuild did not reap after SIGKILL before the final 5s bound.\n")
                status = 124
        status = 124
sys.exit(status)
PY
  cat "$log"
  if [[ "$status" -ne 0 ]]; then
    echo "::error::Benchmark xcodebuild failed or exceeded its ${timeout_seconds}s guard; details are in $log."
  fi
  return "$status"
}

extract_phase_diagnostics() {
  local log="$1" output="$2" label="$3" count="$4" phase_name="$5" iteration="$6"
  python3 - "$log" "$output" "$label" "$count" "$phase_name" "$iteration" <<'PY'
import json
import pathlib
import sys

log_path, output_path, variant, fixture_rows, run_phase, iteration = sys.argv[1:]
fixture_rows_requested = int(fixture_rows) if fixture_rows.isdigit() else None
text = pathlib.Path(log_path).read_text(errors="replace") if pathlib.Path(log_path).exists() else ""
marker = "FULL_CHAT_VIEW_PHASE_DIAGNOSTIC"
decoder = json.JSONDecoder()
records = []
raw_records = []
cursor = 0
while True:
    marker_at = text.find(marker, cursor)
    if marker_at < 0:
        break
    start = marker_at + len(marker)
    while start < len(text) and text[start].isspace():
        start += 1
    try:
        record, end = decoder.raw_decode(text, start)
    except json.JSONDecodeError:
        cursor = start + 1
        continue
    cursor = end
    if not isinstance(record, dict):
        continue
    raw_records.append(record)

    samples = record.get("requestedAndObservedOffsetSamples") or []
    first = samples[0] if samples else {}
    last = samples[-1] if samples else {}
    compact = {
        "variant": variant,
        "fixtureRowsRequested": fixture_rows_requested,
        "runPhase": run_phase,
        "iteration": iteration,
        "mode": record.get("mode"),
        "renderProbeInstrumented": record.get("renderProbeInstrumented"),
        "notScoredPerformance": record.get("notScoredPerformance"),
        "phase": record.get("phase"),
        "messageCount": record.get("messageCount"),
        "canonicalFixtureSHA256": record.get("canonicalFixtureSHA256") or record.get("fixtureSHA256"),
        "viewportHeightPoints": record.get("viewportHeightPoints"),
        "contentHeightPoints": record.get("contentHeightPoints"),
        "reduceMotionEnabled": record.get("reduceMotionEnabled"),
        "requestedFromOffsetPoints": record.get("requestedFromOffsetPoints"),
        "requestedToOffsetPoints": record.get("requestedToOffsetPoints"),
        "observedStartOffsetPoints": first.get("observedYPoints"),
        "observedEndOffsetPoints": last.get("observedYPoints"),
        "callbackCount": record.get("callbackCount"),
        "timedOut": record.get("timedOut"),
        "phaseErrorType": record.get("phaseErrorType"),
        "phaseErrorDescription": record.get("phaseErrorDescription"),
    }
    if isinstance(record.get("phaseMeasurement"), dict):
        measurement = record["phaseMeasurement"]
        compact.update({
            "phase": record.get("phase") or measurement.get("name"),
            "callbackCount": record.get("callbackCount", measurement.get("callbackCount")),
            "timedOut": record.get("timedOut", measurement.get("timedOut")),
            "requestedFromOffsetPoints": record.get("requestedFromOffsetPoints", measurement.get("fromOffsetPoints")),
            "requestedToOffsetPoints": record.get("requestedToOffsetPoints", measurement.get("toOffsetPoints")),
            "observedStartOffsetPoints": measurement.get("observedStartOffsetPoints", compact["observedStartOffsetPoints"]),
            "observedEndOffsetPoints": measurement.get("observedEndOffsetPoints", compact["observedEndOffsetPoints"]),
        })
    if record.get("mode") == "fixed-window-setup":
        geometry = record.get("geometrySamples") or []
        final_geometry = geometry[-1] if geometry else {}
        compact.update({
            "phase": record.get("phase"),
            "positioningProtocol": record.get("positioningProtocol"),
            "setupValid": record.get("setupValid"),
            "requestedOffsetPoints": record.get("requestedOffsetPoints"),
            "viewportHeightPoints": final_geometry.get("viewportHeightPoints"),
            "contentHeightPoints": final_geometry.get("contentHeightPoints"),
            "observedOffsetPoints": final_geometry.get("observedOffsetPoints"),
            "geometrySampleCount": len(geometry),
        })
    records.append(compact)

with open(output_path, "w", encoding="utf-8") as output:
    for record in records:
        output.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
raw_output_path = output_path.removesuffix(".jsonl") + "-phase-reports.jsonl"
with open(raw_output_path, "w", encoding="utf-8") as output:
    for record in raw_records:
        output.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
setup_records = [record for record in records if record.get("mode") == "fixed-window-setup"]
raw_setup_records = [record for record in raw_records if record.get("mode") == "fixed-window-setup"]
setup_path = output_path.removesuffix(".jsonl") + "-setup.json"
setup_receipt = {
    "variant": variant,
    "fixtureRowsRequested": fixture_rows_requested,
    "runPhase": run_phase,
    "iteration": iteration,
    "setupMarkerCount": len(setup_records),
    "setups": setup_records,
    "rawSetups": raw_setup_records,
}
pathlib.Path(setup_path).write_text(json.dumps(setup_receipt, sort_keys=True, separators=(",", ":")) + "\n")
print(f"Extracted {len(records)} compact benchmark record(s) to {output_path}")
print(f"Preserved {len(raw_records)} full benchmark report(s) to {raw_output_path}")
print(f"Wrote setup receipt to {setup_path}")
PY
}

write_case_receipt() {
  local label="$1" case_tag="$2" count="$3" phase_name="$4" iteration="$5" exit_status="$6"
  local expected_count="null"
  [[ "$count" =~ ^[0-9]+$ ]] && expected_count="$count"
  local receipt="$compact_output/${label}-${case_tag}-${phase_name}-${iteration}-receipt.json"
  printf '{"variant":"%s","messageCountExpected":%s,"phase":"%s","iteration":"%s","xcodebuildExitStatus":%s}\n' \
    "$label" "$expected_count" "$phase_name" "$iteration" "$exit_status" > "$receipt"
}

variant_common() {
  local label="$1" tree="$worktree_root/$1" derived="$RUNNER_TEMP/ios-scroll-derived/$1"
  printf '%s\n' \
    -project "$tree/apps/ios/Assistant.xcodeproj" \
    -scheme Assistant \
    -configuration Release \
    -destination "id=$simulator_udid" \
    -destination-timeout 60 \
    -derivedDataPath "$derived" \
    -parallel-testing-enabled NO \
    ENABLE_TESTABILITY=YES \
    SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG \
    ONLY_ACTIVE_ARCH=YES \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY=
}

run_case() {
  local label="$1" case_tag="$2" count="$3" method="$4" phase="$5" iteration="$6"
  local test_class="${7:-ConversationScrollPerformanceTests}"
  local result="$output_root/${label}-${case_tag}-${phase}-${iteration}.xcresult"
  local log="$output_root/${label}-${case_tag}-${phase}-${iteration}.log"
  set_variant_common "$label"

  # UIAccessibility's Reduce Motion value is get-only on supported SDKs.
  # The XCTest fixture asserts it is disabled and embeds the value in its JSON.
  # Terminating the hosted app before every result gives Swift's process-local
  # render memos the same cold-start boundary on both sides.
  xcrun simctl terminate "$simulator_udid" com.baldvinsmarason.assistant >/dev/null 2>&1 || true
  echo "Run: variant=$label case=$case_tag phase=$phase iteration=$iteration cache=fresh-app-process device=$simulator_udid"
  local status=0
  run_xcode_bounded 180 "$log" xcodebuild "${common[@]}" \
    -resultBundlePath "$result" \
    "-only-testing:AssistantTests/$test_class/$method" \
    test-without-building || status=$?
  extract_phase_diagnostics "$log" \
    "$compact_output/${label}-${case_tag}-${phase}-${iteration}.jsonl" \
    "$label" "$count" "$phase" "$iteration"
  write_case_receipt "$label" "$case_tag" "$count" "$phase" "$iteration" "$status"
  return "$status"
}

validate_xctest_case_results() {
  local label="$1" case_tag="$2" phase_name="$3" iteration="$4" log="$5" xcode_status="$6"
  shift 6
  python3 - "$label" "$case_tag" "$phase_name" "$iteration" "$log" "$xcode_status" "$compact_output/${label}-${case_tag}-${phase_name}-${iteration}-test-gate.json" "$@" <<'PY'
import json
import pathlib
import re
import sys

label, case_tag, phase, iteration, log_path, xcode_status, output_path, *expected = sys.argv[1:]
text = pathlib.Path(log_path).read_text(errors="replace") if pathlib.Path(log_path).exists() else ""
pattern = re.compile(r"Test Case '-\[AssistantTests\.([A-Za-z0-9_]+) ([A-Za-z0-9_]+)\]' (passed|failed|skipped)(?:\s|$)")
observed = {}
for test_class, test_name, status in pattern.findall(text):
    observed.setdefault(f"{test_class}/{test_name}", []).append(status)

errors = []
if xcode_status != "0":
    errors.append(f"xcodebuild exited with status {xcode_status}")
if not expected:
    errors.append("no expected XCTest cases were supplied")
for selector in expected:
    statuses = observed.get(selector, [])
    if statuses != ["passed"]:
        errors.append(f"{selector}: expected exactly one completed pass, observed {statuses or 'no completion'}")
unexpected = sorted(set(observed) - set(expected))
if unexpected:
    errors.append(f"unexpected completed XCTest cases: {unexpected}")

passed = sum(status == "passed" for statuses in observed.values() for status in statuses)
failed = sum(status == "failed" for statuses in observed.values() for status in statuses)
skipped = sum(status == "skipped" for statuses in observed.values() for status in statuses)
report = {
    "variant": label,
    "case": case_tag,
    "phase": phase,
    "iteration": iteration,
    "xcodebuildExitStatus": int(xcode_status),
    "expectedSelectors": expected,
    "completedPassCount": passed,
    "failedCount": failed,
    "skippedCount": skipped,
    "observed": observed,
    "status": "passed" if not errors else "failed",
    "errors": errors,
}
pathlib.Path(output_path).write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
print(json.dumps(report, sort_keys=True))
sys.exit(1 if errors else 0)
PY
}

run_card_semantics_case() {
  local label="$1"
  shift
  local case_tag="card-semantics"
  local phase_name="preflight"
  local iteration="00"
  local result="$output_root/${label}-${case_tag}-${phase_name}-${iteration}.xcresult"
  local log="$output_root/${label}-${case_tag}-${phase_name}-${iteration}.log"
  local selectors=() selector status=0
  for selector in "$@"; do selectors+=("-only-testing:AssistantTests/APIModelsTests/$selector"); done
  set_variant_common "$label"
  xcrun simctl terminate "$simulator_udid" com.baldvinsmarason.assistant >/dev/null 2>&1 || true
  echo "Run: variant=$label case=$case_tag selectedTests=${#selectors[@]} device=$simulator_udid"
  run_xcode_bounded 180 "$log" xcodebuild "${common[@]}" \
    -resultBundlePath "$result" "${selectors[@]}" test-without-building || status=$?
  local expected=()
  for selector in "$@"; do expected+=("APIModelsTests/$selector"); done
  validate_xctest_case_results "$label" "$case_tag" "$phase_name" "$iteration" "$log" "$status" "${expected[@]}"
}

run_quiet_scroll_profile() {
  local label="$1"
  local instrument_log="$output_root/profile-instrument-options.log"
  local instrument_json="$output_root/profile-instrument-options.json"
  local result="$output_root/${label}-quiet-scroll-profile.xcresult"
  local log="$output_root/${label}-quiet-scroll-profile.log"
  local profile_trace="$output_root/quiet-scroll-profile.trace"

  xcrun xctrace list instruments > "$output_root/profile-instruments.txt" 2> "$instrument_log"
  if ! grep -Fxq 'Time Profiler' "$output_root/profile-instruments.txt" \
      || ! grep -Fxq 'Points of Interest' "$output_root/profile-instruments.txt"; then
    echo "::error::Selected Xcode lacks the required Time Profiler or Points of Interest instrument; profile was not started."
    return 1
  fi
  if ! xcrun xctrace record --template 'Time Profiler' --instrument 'Points of Interest' \
      --show-recording-options > "$instrument_json" 2> "$instrument_log"; then
    echo "::error::Selected Xcode cannot configure Time Profiler and Points of Interest together; profile was not started."
    return 1
  fi
  if ! jq -e 'has("Time Profiler") and has("Points of Interest")' "$instrument_json" >/dev/null; then
    echo "::error::Combined recording options did not expose both required instruments; profile was not started."
    return 1
  fi

  set_variant_common "$label"
  xcrun simctl terminate "$simulator_udid" com.baldvinsmarason.assistant >/dev/null 2>&1 || true
  echo "Quiet-scroll profile: one app-only 8s Time Profiler + Points of Interest capture on $simulator_udid."
  python3 infra/ios-scroll-profile.py \
    --udid "$simulator_udid" \
    --output "$output_root" \
    --compact "$compact_output" \
    --result "$result" \
    --log "$log" \
    --trace "$profile_trace" \
    --dsym-root "$output_root/${label}-dsyms" \
    --xcode-version "$(cat "$output_root/xcode-version.txt")" \
    --simulator-runtime "$simulator_runtime" \
    -- "${common[@]}" \
    -resultBundlePath "$result" \
    "-only-testing:AssistantTests/ConversationScrollPerformanceTests/testFullChatView500RowQuietScrollProfile" \
    test-without-building
}

run_settled_diagnostic() {
  local label="$1" count="$2" method="$3" iteration="diagnostic-00"
  local result="$output_root/${label}-${count}rows-${iteration}.xcresult"
  local log="$output_root/${label}-${count}rows-${iteration}.log"
  set_variant_common "$label"

  # Keep these runs independent of warmup and prior app/task state. Each one
  # starts with a freshly terminated hosted app and has a hard 180s guard.
  xcrun simctl terminate "$simulator_udid" com.baldvinsmarason.assistant >/dev/null 2>&1 || true
  echo "Settled-scroll diagnostic: variant=$label fixture=${count}-rows device=$simulator_udid timeout=180s"
  local status=0
  run_xcode_bounded 180 "$log" xcodebuild "${common[@]}" \
    -resultBundlePath "$result" \
    "-only-testing:AssistantTests/ConversationScrollPerformanceTests/$method" \
    test-without-building || status=$?
  extract_phase_diagnostics "$log" \
    "$compact_output/${label}-${count}rows-settled-diagnostic-00.jsonl" \
    "$label" "$count" settled-diagnostic 00
  write_case_receipt "$label" "${count}rows" "$count" settled-diagnostic 00 "$status"
  return "$status"
}

start_time_profiler() {
  local trace="$1" trace_log="$2"
  python3 - "$trace" "$trace_log" <<'PY' &
import os
import signal
import subprocess
import sys
import time

trace, log_path = sys.argv[1:]
state_path = trace + ".state"

def mark_state(value):
    with open(state_path, "w", encoding="utf-8") as state_file:
        state_file.write(value + "\n")

with open(log_path, "wb", buffering=0) as log:
    child = subprocess.Popen(
        ["xcrun", "xctrace", "record", "--template", "Time Profiler", "--all-processes",
         "--time-limit", "5m", "--output", trace],
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    with open(trace + ".pid", "w", encoding="utf-8") as pid_file:
        pid_file.write(str(child.pid))

    def stop(_signal, _frame):
        log.write(b"\nStopping trace supervisor; signaling xctrace process group with SIGINT.\n")
        try:
            os.killpg(child.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            status = child.wait(timeout=30)
            log.write(f"xctrace exited after SIGINT with status {status}.\n".encode())
            mark_state("complete-after-interrupt" if status == 0 else f"incomplete-after-interrupt-exit-{status}")
            return
        except subprocess.TimeoutExpired:
            log.write(b"xctrace did not stop within 30s; escalating to SIGTERM.\n")
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            status = child.wait(timeout=10)
            log.write(f"xctrace exited after SIGTERM with status {status}.\n".encode())
            mark_state(f"incomplete-after-term-exit-{status}")
            return
        except subprocess.TimeoutExpired:
            log.write(b"xctrace did not stop within 10s; escalating to SIGKILL.\n")
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            status = child.wait(timeout=5)
            log.write(f"xctrace reaped after SIGKILL with status {status}.\n".encode())
        except subprocess.TimeoutExpired:
            log.write(b"xctrace did not reap after SIGKILL; trace may be incomplete.\n")
        mark_state("incomplete-after-kill")
        raise SystemExit(0)

    signal.signal(signal.SIGUSR1, stop)
    while child.poll() is None:
        time.sleep(0.25)
    log.write(f"xctrace exited on its own with status {child.returncode}.\n".encode())
    mark_state("complete" if child.returncode == 0 else f"incomplete-exit-{child.returncode}")
PY
  trace_supervisor_pid=$!
  sleep 3
  if ! kill -0 "$trace_supervisor_pid" 2>/dev/null; then
    wait "$trace_supervisor_pid" 2>/dev/null || true
    trace_supervisor_pid=""
    return 1
  fi
  return 0
}

stop_time_profiler() {
  local supervisor_pid="$1" trace="$2"
  [[ -n "$supervisor_pid" ]] || return 0
  kill -USR1 "$supervisor_pid" 2>/dev/null || true
  for _ in {1..50}; do
    local state
    state="$(ps -o stat= -p "$supervisor_pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -z "$state" || "$state" == Z* ]]; then
      wait "$supervisor_pid" 2>/dev/null || true
      rm -f "$trace.pid"
      return 0
    fi
    sleep 1
  done

  echo "Trace supervisor exceeded 50s shutdown bound; killing it and the recorded xctrace process group."
  if [[ -s "$trace.pid" ]]; then
    local child_pid
    child_pid="$(cat "$trace.pid")"
    kill -KILL "-$child_pid" 2>/dev/null || true
  fi
  printf 'incomplete-supervisor-shutdown-timeout\n' > "$trace.state"
  kill -KILL "$supervisor_pid" 2>/dev/null || true
  wait "$supervisor_pid" 2>/dev/null || true
  rm -f "$trace.pid"
  echo "Trace may be incomplete; test xcresults and logs remain preserved."
}

run_optional_bounded() {
  local timeout_seconds="$1" log="$2"
  shift 2
  python3 - "$timeout_seconds" "$log" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
log_path = sys.argv[2]
command = sys.argv[3:]
with open(log_path, "wb") as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        status = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        log.write(f"\nOptional command timed out after {timeout_seconds}s; escalating to SIGTERM.\n".encode())
        log.flush()
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            status = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log.write(b"Optional command did not stop after SIGTERM; escalating to SIGKILL.\n")
            log.flush()
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                status = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                log.write(b"Optional command was killed but not reaped before the bound.\n")
                status = 124
sys.exit(status)
PY
}

run_traced_settled_diagnostics() {
  local label="$1"
  local trace="$output_root/${label}-settled-100-and-500rows-time-profiler.trace"
  local trace_log="$output_root/${label}-settled-time-profiler.log"
  local failures=0

  echo "Starting Time Profiler across settled 100- and 500-row diagnostics; scope=host-all-processes simulator=$simulator_udid. This is CPU diagnostic evidence, not presented-frame timing."
  local trace_pid=""
  if ! start_time_profiler "$trace" "$trace_log"; then
    echo "Time Profiler did not start; continuing both settled-scroll diagnostics without a trace. See $trace_log."
    run_settled_diagnostic "$label" 100 testFullChatView100RowSettledBidirectionalDiagnostic || failures=$((failures + 1))
    run_settled_diagnostic "$label" 500 testFullChatView500RowSettledBidirectionalDiagnostic || failures=$((failures + 1))
    return "$failures"
  fi
  trace_pid="$trace_supervisor_pid"

  # Keep the same trace alive through both cold scroll fixtures. Each xcodebuild
  # call still has its own hard timeout and result bundle; an early failing
  # assertion does not suppress the other row count.
  run_settled_diagnostic "$label" 100 testFullChatView100RowSettledBidirectionalDiagnostic \
    || failures=$((failures + 1))
  run_settled_diagnostic "$label" 500 testFullChatView500RowSettledBidirectionalDiagnostic \
    || failures=$((failures + 1))
  stop_time_profiler "$trace_pid" "$trace"
  if [[ -f "$trace/Info.plist" || -d "$trace" ]]; then
    local trace_state="unknown"
    [[ -f "$trace.state" ]] && trace_state="$(cat "$trace.state")"
    echo "Preserved Time Profiler trace at $trace state=$trace_state (settled diagnostic failures=$failures)."
    run_optional_bounded 60 "$output_root/${label}-settled-time-profiler-export.log" \
      xcrun xctrace export --input "$trace" --toc \
      --output "$output_root/${label}-settled-time-profiler-toc.xml" \
      || echo "Could not export the trace table of contents within 60s; raw trace and dSYMs are preserved."
  else
    echo "No finalized Time Profiler trace found; see $trace_log. Both diagnostic test results retained."
  fi
  return "$failures"
}


variants=(baseline)
if [[ "$same_production_tree" != true || "$run_mode" == "smoke" ]]; then variants+=(candidate); fi

# Compile every source variant before collecting any measurements. This keeps
# first-build host load out of the baseline/candidate observation window.
if [[ "$phase" != "runtime" ]]; then
  for label in "${variants[@]}"; do build_variant "$label"; done
  printf '%s\n' "$expected_build_state" > "$build_state"
  echo "Saved build state for a separate runtime step at $build_state."
fi

if [[ "$phase" == "build" ]]; then
  echo "Build phase complete; no simulator tests were run."
  exit 0
fi

# First boot on a hosted image can spend minutes preparing the runtime. Keep
# that setup outside the per-test timeout and all measurement boundaries.
run_xcode_bounded 300 "$output_root/simulator-boot.log" \
  xcrun simctl bootstatus "$simulator_udid" -b

if [[ "$run_mode" == "profile" ]]; then
  echo "Running exactly one quiet-scroll profile on identical ref $baseline_sha; no matrix or render probe will run."
  if run_quiet_scroll_profile baseline; then
    echo "Quiet-scroll trace capture finished; profile acceptance remains gated on same-trace PID/signpost/sample validation."
    exit 0
  else
    echo "::error::Quiet-scroll profile capture failed or could not prove its target/phase evidence. Raw traces and receipts are preserved."
    exit 1
  fi
fi

if [[ "$run_mode" == "matrix" ]]; then
  # The fixed-window matched selector is the sole measured case in matrix
  # mode. It is deliberately untraced: no profiler startup/shutdown affects
  # these paired samples.
  echo "Running untraced matched 500-row fixed-window matrix; variants=${variants[*]} repeats=$repeats."
  matrix_failures=0
  for label in "${variants[@]}"; do
    run_case "$label" 500rows 500 testFullChatView500RowFixedWindowBidirectional warmup 00 \
      || matrix_failures=$((matrix_failures + 1))
  done
  warmup_validation_status=0
  validate_matrix_warmups || warmup_validation_status=$?
  if [[ "$matrix_failures" -gt 0 || "$warmup_validation_status" -gt 0 ]]; then
    echo "::error::At least one matrix warmup failed validation; recorded pairs were skipped. Warmup logs and compact receipts are preserved."
    exit 1
  fi
  for ((run = 1; run <= repeats; run++)); do
    if [[ "${#variants[@]}" -eq 1 ]]; then
      order=(baseline)
    elif ((run % 2 == 1)); then
      order=(baseline candidate)
    else
      order=(candidate baseline)
    fi
    printf -v run_label '%02d' "$run"
    for label in "${order[@]}"; do
      run_case "$label" 500rows 500 testFullChatView500RowFixedWindowBidirectional recorded "$run_label" \
        || matrix_failures=$((matrix_failures + 1))
    done
  done
  if [[ "$matrix_failures" -gt 0 ]]; then
    echo "::error::$matrix_failures matrix case(s) failed; all paired cases were still collected."
    exit 1
  fi
  echo "Untraced fixed-window matrix complete. CADisplayLink intervals are simulator callbacks, not presented-frame FPS."
  exit 0
fi

if [[ "$run_mode" == "correctness" ]]; then
  correctness_failures=0
  echo "Running only the bottom-follow streaming correctness case on ${variants[*]}; no fixed-window warmup or performance matrix will run."
  for label in "${variants[@]}"; do
    run_case "$label" bottom-follow - testChatFollowsNewMessagesAndGrowingStreamWhileAtBottom correctness 00 APIClientRetryTests \
      || correctness_failures=$((correctness_failures + 1))
  done
  if [[ "$correctness_failures" -gt 0 ]]; then
    echo "::error::$correctness_failures bottom-follow correctness case(s) failed."
    exit 1
  fi
  echo "Bottom-follow correctness passed on all variants. No performance matrix was run."
  exit 0
fi

if [[ "$run_mode" == "smoke" ]]; then
  smoke_failures=0
  echo "Running explicit card-semantics preflight on baseline and candidate before bottom-follow or timing."
  for label in "${variants[@]}"; do
    if [[ "$label" == "baseline" ]]; then
      run_card_semantics_case "$label" \
        testSuggestionContextOnlySuppressesItsExplicitMatchingAlert \
        testLegacyTextCardsReformatSuppliedCalendarExamplesConservatively \
        || smoke_failures=$((smoke_failures + 1))
    else
      run_card_semantics_case "$label" \
        testSuggestionContextOnlySuppressesItsExplicitMatchingAlert \
        testLegacyTextCardsReformatSuppliedCalendarExamplesConservatively \
        testBubbleCardsDoNotInferLegacyAfterExplicitCardsArePairedAway \
        testBubbleCardsInferLegacyOnlyWhenNoExplicitCardParses \
        testBubbleCardReusePreservesPairingAndFormRendererCapability \
        || smoke_failures=$((smoke_failures + 1))
    fi
  done
  if [[ "$smoke_failures" -gt 0 ]]; then
    echo "::error::$smoke_failures card-semantics preflight(s) failed; bottom-follow and fixed-window cases were skipped."
    exit 1
  fi

  echo "Card semantics passed with exact 2/5 completed cases. Running bottom-follow correctness on both variants."
  for label in "${variants[@]}"; do
    local_status=0
    run_case "$label" bottom-follow - testChatFollowsNewMessagesAndGrowingStreamWhileAtBottom correctness-smoke 00 APIClientRetryTests \
      || local_status=$?
    validate_xctest_case_results "$label" bottom-follow correctness-smoke 00 \
      "$output_root/${label}-bottom-follow-correctness-smoke-00.log" "$local_status" \
      APIClientRetryTests/testChatFollowsNewMessagesAndGrowingStreamWhileAtBottom \
      || smoke_failures=$((smoke_failures + 1))
  done
  if [[ "$smoke_failures" -gt 0 ]]; then
    echo "::error::$smoke_failures bottom-follow correctness case(s) failed; fixed-window cases were skipped."
    exit 1
  fi

  echo "Bottom-follow correctness passed on all variants; running one fixed-window setup case per variant."
  for label in "${variants[@]}"; do
    run_case "$label" 500rows 500 testFullChatView500RowFixedWindowBidirectional warmup 00 \
      || smoke_failures=$((smoke_failures + 1))
  done
  if ! validate_matrix_warmups; then smoke_failures=$((smoke_failures + 1)); fi
  if [[ "$smoke_failures" -gt 0 ]]; then
    echo "::error::$smoke_failures smoke case(s) or fixed-window setup validation failed; no recorded performance pairs were run."
    exit 1
  fi
  echo "Correctness smoke and fixed-window setup passed; no recorded performance pairs were run."
  exit 0
fi

# Always begin with scroll-only diagnostics, before warmups or the stateful
# keyboard/stream benchmark. Continue through both row counts after a failure
# so the artifact still separates baseline rendering from interaction phases.
diagnostic_failures=0
for label in "${variants[@]}"; do
  if [[ "$run_mode" == "diagnostic" && "$label" == "baseline" ]] \
      && xcrun xctrace list templates 2>"$output_root/xctrace-templates.log" \
      | grep -Fq 'Time Profiler'; then
    run_traced_settled_diagnostics "$label" || diagnostic_failures=$((diagnostic_failures + 1))
  else
    run_settled_diagnostic "$label" 100 testFullChatView100RowSettledBidirectionalDiagnostic \
      || diagnostic_failures=$((diagnostic_failures + 1))
    run_settled_diagnostic "$label" 500 testFullChatView500RowSettledBidirectionalDiagnostic \
      || diagnostic_failures=$((diagnostic_failures + 1))
  fi
done

# One bounded reproduction keeps the former typing/stream/append measurements
# available, but it runs only after both narrowed scroll-only cases finish.
# Its failure is recorded and never prevents the other diagnostics above.
run_case baseline 100rows 100 testFullChatView100RowColdMountBidirectionalStreamAndAppend updates-diagnostic 00 \
  || diagnostic_failures=$((diagnostic_failures + 1))

if [[ "$diagnostic_failures" -gt 0 ]]; then
  echo "::error::$diagnostic_failures settled-scroll diagnostic(s) failed; preserving results and skipping the stateful/warmup matrix."
  exit 1
fi

echo "Settled-scroll diagnostics complete. CADisplayLink intervals are simulator callbacks, not presented-frame FPS."
