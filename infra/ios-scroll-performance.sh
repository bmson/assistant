#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(git rev-parse --show-toplevel)"
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
  diagnostic|matrix) ;;
  *) echo "RUN_MODE must be diagnostic or matrix" >&2; exit 2 ;;
esac

case "$phase" in
  build|runtime|all) ;;
  *) echo "PHASE must be build, runtime, or all" >&2; exit 2 ;;
esac

mkdir -p "$output_root" "$worktree_root"
exec > >(tee -a "$output_root/driver.log") 2>&1

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
matrix_method=testFullChatView500RowFixedWindowBidirectional
run_mode=$run_mode
cache_plan=one-warmup-per-variant-and-fixture; each-result-is-a-fresh-xcodebuild-test-invocation; phases-inside-a-test-share-one-app-process
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

fixture_test="apps/ios/AssistantTests/ConversationScrollPerformanceTests.swift"
fixture_helper="apps/ios/AssistantTests/ConversationPerformanceFixture.swift"
project_file="apps/ios/Assistant.xcodeproj/project.pbxproj"
candidate_project_snapshot="$output_root/candidate-project.pbxproj"
git -C "$repo_root" show "${harness_sha}:${project_file}" > "$candidate_project_snapshot"

overlay_harness() {
  local tree="$1"
  for path in "$fixture_test" "$fixture_helper"; do
    mkdir -p "$tree/$(dirname "$path")"
    git -C "$repo_root" show "${harness_sha}:${path}" > "$tree/$path"
  done

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
  local label="$1" count="$2" method="$3" phase="$4" iteration="$5"
  local result="$output_root/${label}-${count}rows-${phase}-${iteration}.xcresult"
  local log="$output_root/${label}-${count}rows-${phase}-${iteration}.log"
  set_variant_common "$label"

  # UIAccessibility's Reduce Motion value is get-only on supported SDKs.
  # The XCTest fixture asserts it is disabled and embeds the value in its JSON.
  # Terminating the hosted app before every result gives Swift's process-local
  # render memos the same cold-start boundary on both sides.
  xcrun simctl terminate "$simulator_udid" com.baldvinsmarason.assistant >/dev/null 2>&1 || true
  echo "Run: variant=$label fixture=${count}-rows phase=$phase iteration=$iteration cache=fresh-app-process device=$simulator_udid"
  run_xcode_bounded 180 "$log" xcodebuild "${common[@]}" \
    -resultBundlePath "$result" \
    "-only-testing:AssistantTests/ConversationScrollPerformanceTests/$method" \
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
  run_xcode_bounded 180 "$log" xcodebuild "${common[@]}" \
    -resultBundlePath "$result" \
    "-only-testing:AssistantTests/ConversationScrollPerformanceTests/$method" \
    test-without-building
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
if [[ "$same_production_tree" != true ]]; then variants+=(candidate); fi

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

if [[ "$run_mode" == "matrix" ]]; then
  # The fixed-window matched selector is the sole measured case in matrix
  # mode. It is deliberately untraced: no profiler startup/shutdown affects
  # these paired samples.
  echo "Running untraced matched 500-row fixed-window matrix; variants=${variants[*]} repeats=$repeats."
  matrix_failures=0
  for label in "${variants[@]}"; do
    run_case "$label" 500 testFullChatView500RowFixedWindowBidirectional warmup 00 \
      || matrix_failures=$((matrix_failures + 1))
  done
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
      run_case "$label" 500 testFullChatView500RowFixedWindowBidirectional recorded "$run_label" \
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
run_case baseline 100 testFullChatView100RowColdMountBidirectionalStreamAndAppend updates-diagnostic 00 \
  || diagnostic_failures=$((diagnostic_failures + 1))

if [[ "$diagnostic_failures" -gt 0 ]]; then
  echo "::error::$diagnostic_failures settled-scroll diagnostic(s) failed; preserving results and skipping the stateful/warmup matrix."
  exit 1
fi

echo "Settled-scroll diagnostics complete. CADisplayLink intervals are simulator callbacks, not presented-frame FPS."
