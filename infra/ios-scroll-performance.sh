#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(git rev-parse --show-toplevel)"
output_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-scroll-performance"
worktree_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-scroll-performance-worktrees"
baseline_ref="${BASELINE_REF:-14ba202b8c9593623f3fe3c817319c15e40f6ffa}"
candidate_ref="${CANDIDATE_REF:-${GITHUB_SHA:-HEAD}}"
repeats="${REPEATS:-5}"

case "$repeats" in
  1|2|3|4|5) ;;
  *) echo "REPEATS must be an integer from 1 through 5" >&2; exit 2 ;;
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
benchmark_test_class=ConversationScrollPerformanceTests
benchmark_methods=testFullChatView100RowColdMountBidirectionalStreamAndAppend,testFullChatView500RowColdMountBidirectionalStreamAndAppend
cache_plan=one-warmup-per-variant-and-fixture; each-result-is-a-fresh-xcodebuild-test-invocation; phases-inside-a-test-share-one-app-process
metric_note=CADisplayLink callback intervals are not presented-frame FPS; simulator results are comparative evidence only.
EOF

echo "Runner: $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
echo "Baseline: $baseline_sha (production tree $baseline_production_tree)"
echo "Candidate: $candidate_sha (production tree $candidate_production_tree)"
echo "Benchmark harness source: $harness_sha"
echo "Same production tree: $same_production_tree; repeats: $repeats"

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
  git -C "$repo_root" worktree add --detach "$path" "$sha" >/dev/null
  overlay_harness "$path" > "$output_root/$label-fixtures.txt"
  echo "Prepared $label worktree at $sha"
}

add_worktree baseline "$baseline_sha"
if [[ "$same_production_tree" != true ]]; then
  add_worktree candidate "$candidate_sha"
else
  echo "Skipping a redundant candidate build: apps/ios/Assistant production trees match."
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
  set_variant_common "$label"
  mkdir -p "$RUNNER_TEMP/ios-scroll-derived/$label"
  echo "Building $label once for testing."
  set -o pipefail
  xcodebuild "${common[@]}" build-for-testing 2>&1 | tee "$log"
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
            process.wait()
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

variants=(baseline)
if [[ "$same_production_tree" != true ]]; then variants+=(candidate); fi

# Compile every source variant before collecting any measurements. This keeps
# first-build host load out of the baseline/candidate observation window.
for label in "${variants[@]}"; do build_variant "$label"; done

# First boot on a hosted image can spend minutes preparing the runtime. Keep
# that setup outside the per-test timeout and all measurement boundaries.
run_xcode_bounded 300 "$output_root/simulator-boot.log" \
  xcrun simctl bootstatus "$simulator_udid" -b

# Retain the original rows-only benchmark as supplemental historical evidence;
# its callback cadence is separate from the controlled full-ChatView matrix.
for label in "${variants[@]}"; do
  run_case "$label" original100 testSyntheticTranscriptScrollFrameIntervals supplemental 00
done

# Warm the simulator and test installation separately for each fixture size;
# warmup xcresults are named and excluded from the five recorded observations.
for label in "${variants[@]}"; do
  run_case "$label" 100 testFullChatView100RowColdMountBidirectionalStreamAndAppend warmup 00
  run_case "$label" 500 testFullChatView500RowColdMountBidirectionalStreamAndAppend warmup 00
done

# Pair baseline and candidate per fixture and alternate their order by repeat
# to reduce systematic host-temperature / simulator-load drift.
for ((run = 1; run <= repeats; run++)); do
  if [[ "${#variants[@]}" -eq 1 ]]; then
    order=(baseline)
  elif ((run % 2 == 1)); then
    order=(baseline candidate)
  else
    order=(candidate baseline)
  fi
  printf -v run_label '%02d' "$run"
  for count in 100 500; do
    if [[ "$count" == 100 ]]; then
      method=testFullChatView100RowColdMountBidirectionalStreamAndAppend
    else
      method=testFullChatView500RowColdMountBidirectionalStreamAndAppend
    fi
    for label in "${order[@]}"; do run_case "$label" "$count" "$method" recorded "$run_label"; done
  done
done

# One optional diagnostic sample per variant, separate from the paired matrix.
# xctrace's all-process mode is host-wide CPU evidence, not simulator hitches or
# presented-frame timing; the device identity is included for context. It is
# deliberately best-effort and cannot invalidate the recorded benchmark runs.
if xctrace_templates="$(xcrun xctrace list templates 2>"$output_root/xctrace-templates.log")"; then
  trace_template=""
  if grep -Fq 'Time Profiler' <<< "$xctrace_templates"; then trace_template='Time Profiler'
  elif grep -Fq 'Animation Hitches' <<< "$xctrace_templates"; then trace_template='Animation Hitches'
  fi
  if [[ -n "$trace_template" ]]; then
    for label in "${variants[@]}"; do
      trace="$output_root/${label}-hostwide-${trace_template// /-}.trace"
      trace_log="$output_root/${label}-hostwide-trace.log"
      trace_run_log="$output_root/${label}-hostwide-trace-run.log"
      echo "Optional diagnostic: template=$trace_template scope=host-all-processes simulator=$simulator_udid variant=$label (not benchmark data)."
      xcrun xctrace record --template "$trace_template" --all-processes \
        --time-limit 5m --output "$trace" > "$trace_log" 2>&1 &
      trace_pid=$!
      sleep 3
      if kill -0 "$trace_pid" 2>/dev/null; then
        set +e
        run_case "$label" 100 testFullChatView100RowColdMountBidirectionalStreamAndAppend diagnostic 00 \
          > "$trace_run_log" 2>&1
        trace_case_status=$?
        kill -INT "$trace_pid" 2>/dev/null || true
        wait "$trace_pid" 2>/dev/null || true
        set -e
        echo "Optional host-wide $label trace test exit: $trace_case_status; recorded matrix remains authoritative."
      else
        wait "$trace_pid" 2>/dev/null || true
        echo "Optional host-wide trace did not start; see $trace_log."
      fi
    done
  else
    echo "No supported Time Profiler or Animation Hitches template; retained XCTest measurements and xcresults."
  fi
else
  echo "xctrace is unavailable; retained XCTest measurements and xcresults."
fi

echo "Benchmark runs complete. CADisplayLink samples are simulator callback intervals, not presented-frame FPS."
