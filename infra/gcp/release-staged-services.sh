#!/usr/bin/env bash
# Stages Cloud Run services on tagged, zero-traffic revisions, checks the
# candidate pair, then promotes with an explicit rollback map. Promotion of two
# services is not atomic; the probes after the first promotion bound the mixed
# window and restore the captured traffic map on failure.

release_service_json() {
  gcloud run services describe "$1" --project "$PROJECT" --region "$REGION" --format=json
}

release_service_env() {
  local json="$1" name="$2"
  node -e 'const s=JSON.parse(process.argv[1]); const e=s.spec?.template?.spec?.containers?.[0]?.env??s.spec?.containers?.[0]?.env??[]; process.stdout.write(String(e.find(x=>x.name===process.argv[2])?.value??""))' "$json" "$name"
}

release_serving_revision() {
  node -e 'const s=JSON.parse(process.argv[1]);const rows=(s.status?.traffic??[]).filter(x=>Number(x.percent)>0);if(rows.length!==1||Number(rows[0].percent)!==100||!rows[0].revisionName)process.exit(2);process.stdout.write(rows[0].revisionName)' "$1"
}

release_revision_json() {
  gcloud run revisions describe "$2" --project "$PROJECT" --region "$REGION" --format=json
}

release_drain_revision() {
  local revision="$1" description timeout remaining delay
  description="$(release_revision_json assistant-web "$revision")" || return 1
  timeout="$(node -e 'const s=JSON.parse(process.argv[1]);process.stdout.write(String(s.spec?.timeoutSeconds??""))' "$description")"
  if [[ ! "$timeout" =~ ^[0-9]+$ ]] || (( timeout < 1 || timeout > 600 )); then
    echo "  cannot safely drain ${revision}: its Cloud Run request timeout is missing or outside 1..600 seconds." >&2
    return 1
  fi
  remaining=$((timeout + 10))
  (( remaining > 600 )) && remaining=600
  echo "  draining requests from ${revision} for ${remaining}s (timeout ${timeout}s with a 10s grace, capped at 600s)."
  while (( remaining > 0 )); do
    delay=$remaining
    (( delay > 30 )) && delay=30
    echo "  drain progress: waiting ${delay}s; ${remaining}s remain."
    sleep "$delay"
    remaining=$((remaining - delay))
  done
}

release_drain_web_inflight() {
  local service_json="$1" revisions revision
  revisions="$(node -e 'const s=JSON.parse(process.argv[1]);const r=(s.status?.traffic??[]).filter(x=>x.revisionName&&Number(x.percent)>0).map(x=>x.revisionName);if(!r.length)process.exit(2);process.stdout.write(r.join("\n"))' "$service_json")" || return 1
  while IFS= read -r revision; do
    [[ -n "$revision" ]] || continue
    release_drain_revision "$revision" || return 1
  done <<<"$revisions"
}

release_read_contract() {
  local values driver="${RELEASE_PERSISTENCE_DRIVER:-postgres}" schema_version
  schema_version="$(node "${BASH_SOURCE[0]%/*}/release-schema-version.mjs" "$driver")" || return 1
  values="$(node -e '
    const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); const driver=process.argv[2]; const version=Number(process.argv[3]);
    for (const name of ["agent","web"]) { const x=c.components[name]; if (!x) process.exit(2); }
    const a=c.components.agent,w=c.components.web;
    process.stdout.write([
      version,a.apiContract,a.peerApi.min,a.peerApi.max,a.schema[driver].min,a.schema[driver].max,
      w.apiContract,w.peerApi.min,w.peerApi.max,w.schema[driver].min,w.schema[driver].max,
    ].join("\t"));
  ' "${BASH_SOURCE[0]%/*}/release-contracts.json" "$driver" "$schema_version")" || return 1
  RELEASE_STORAGE_DRIVER="$driver"
  IFS=$'\t' read -r RELEASE_SCHEMA_VERSION RELEASE_AGENT_API RELEASE_AGENT_PEER_MIN RELEASE_AGENT_PEER_MAX \
    RELEASE_AGENT_SCHEMA_MIN RELEASE_AGENT_SCHEMA_MAX RELEASE_WEB_API RELEASE_WEB_PEER_MIN \
    RELEASE_WEB_PEER_MAX RELEASE_WEB_SCHEMA_MIN RELEASE_WEB_SCHEMA_MAX <<<"$values"
}

release_in_range() {
  local value="$1" minimum="$2" maximum="$3"
  [[ "$value" =~ ^[0-9]+$ && "$minimum" =~ ^[0-9]+$ && "$maximum" =~ ^[0-9]+$ ]] &&
    (( value >= minimum && value <= maximum ))
}

# Run before backup/migration so an incompatible live image cannot be stranded
# on a changed database schema. The deploy provisioner stamps these declarations
# onto existing service templates; missing metadata fails closed.
release_preflight_compatibility() {
  local selected="$1" agent_service_json web_service_json agent_json web_json agent_revision web_revision
  local agent_api agent_peer_min agent_peer_max agent_schema_min agent_schema_max
  local web_api web_peer_min web_peer_max web_schema_min web_schema_max
  release_read_contract || return 1
  agent_service_json="$(release_service_json assistant-agent)" || return 1
  web_service_json="$(release_service_json assistant-web)" || return 1
  agent_revision="$(release_serving_revision "$agent_service_json")" || {
    echo '  live assistant-agent must have exactly one 100% serving revision for contract checks.' >&2; return 1;
  }
  web_revision="$(release_serving_revision "$web_service_json")" || {
    echo '  live assistant-web must have exactly one 100% serving revision for contract checks.' >&2; return 1;
  }
  agent_json="$(release_revision_json assistant-agent "$agent_revision")" || return 1
  web_json="$(release_revision_json assistant-web "$web_revision")" || return 1
  agent_api="$(release_service_env "$agent_json" ASSISTANT_RELEASE_API_CONTRACT)"
  agent_peer_min="$(release_service_env "$agent_json" ASSISTANT_RELEASE_WEB_API_MIN)"
  agent_peer_max="$(release_service_env "$agent_json" ASSISTANT_RELEASE_WEB_API_MAX)"
  agent_schema_min="$(release_service_env "$agent_json" ASSISTANT_RELEASE_SCHEMA_MIN)"
  agent_schema_max="$(release_service_env "$agent_json" ASSISTANT_RELEASE_SCHEMA_MAX)"
  local agent_schema_driver
  agent_schema_driver="$(release_service_env "$agent_json" ASSISTANT_RELEASE_SCHEMA_DRIVER)"
  web_api="$(release_service_env "$web_json" ASSISTANT_RELEASE_API_CONTRACT)"
  web_peer_min="$(release_service_env "$web_json" ASSISTANT_RELEASE_AGENT_API_MIN)"
  web_peer_max="$(release_service_env "$web_json" ASSISTANT_RELEASE_AGENT_API_MAX)"
  web_schema_min="$(release_service_env "$web_json" ASSISTANT_RELEASE_SCHEMA_MIN)"
  web_schema_max="$(release_service_env "$web_json" ASSISTANT_RELEASE_SCHEMA_MAX)"
  local web_schema_driver
  web_schema_driver="$(release_service_env "$web_json" ASSISTANT_RELEASE_SCHEMA_DRIVER)"
  if [[ "$agent_schema_driver" != "$RELEASE_STORAGE_DRIVER" || ( "$selected" == agent,web && "$web_schema_driver" != "$RELEASE_STORAGE_DRIVER" ) ]]; then
    echo "  live services do not declare the selected ${RELEASE_STORAGE_DRIVER} storage contract." >&2
    return 1
  fi
  if ! release_in_range "$RELEASE_SCHEMA_VERSION" "$agent_schema_min" "$agent_schema_max"; then
    echo "  live assistant-agent does not declare compatibility with ${RELEASE_STORAGE_DRIVER} schema ${RELEASE_SCHEMA_VERSION}; require a reviewed compatibility bridge or a separately reviewed drained upgrade before migration. Historical artifact ranges must not be relabeled." >&2
    return 1
  fi
  if [[ "$selected" == agent,web ]] && ! release_in_range "$RELEASE_SCHEMA_VERSION" "$web_schema_min" "$web_schema_max"; then
    echo "  live assistant-web does not declare compatibility with ${RELEASE_STORAGE_DRIVER} schema ${RELEASE_SCHEMA_VERSION}; require a reviewed compatibility bridge or a separately reviewed drained upgrade before migration." >&2
    return 1
  fi
  if [[ "$selected" == web ]]; then
    if ! release_in_range "$agent_api" "$RELEASE_WEB_PEER_MIN" "$RELEASE_WEB_PEER_MAX"; then
      echo '  selected web release is incompatible with the live agent API contract.' >&2
      return 1
    fi
  else
    if ! release_in_range "$RELEASE_AGENT_API" "$web_peer_min" "$web_peer_max" ||
      ! release_in_range "$web_api" "$agent_peer_min" "$agent_peer_max" ||
      ! release_in_range "$agent_api" "$RELEASE_WEB_PEER_MIN" "$RELEASE_WEB_PEER_MAX" ||
      ! release_in_range "$web_api" "$RELEASE_AGENT_PEER_MIN" "$RELEASE_AGENT_PEER_MAX"; then
      echo '  live/new service API contract ranges do not prove both mixed-version combinations safe.' >&2
      return 1
    fi
  fi
  return 0
}

release_traffic_map() {
  node -e '
    const s=JSON.parse(process.argv[1]); const rows=s.status?.traffic??[];
    if (!rows.length) throw new Error("service has no captured traffic target");
    const targets=rows.filter(x=>x.revisionName && Number(x.percent)>0).map(x=>`${x.revisionName}=${Number(x.percent)}`);
    if (!targets.length) throw new Error("service traffic has no named revision target");
    process.stdout.write(targets.join(","));
  ' "$1"
}

release_tag_url() {
  node -e 'const s=JSON.parse(process.argv[1]); const x=(s.status?.traffic??[]).find(t=>t.tag===process.argv[2]); if(!x?.url) process.exit(2); process.stdout.write(x.url)' "$1" "$2"
}

release_component_digest() {
  local component="$1" digest
  digest="$(gcloud artifacts docker images describe "${IMAGE_ROOT}/${component}:${TAG}" \
    --project "$PROJECT" --format='value(image_summary.digest)')" || return 1
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || {
    echo "  ${component}:${TAG} did not resolve to an immutable sha256 digest" >&2
    return 1
  }
  printf '%s' "$digest"
}

release_validate_worker_override() {
  case "${RELEASE_EMAIL_OBSERVER_WORKER_ENABLED:-}" in
    ''|true|false) return 0 ;;
    *) echo 'RELEASE_EMAIL_OBSERVER_WORKER_ENABLED must be exactly true or false when set' >&2; return 2 ;;
  esac
}

release_restore_traffic() {
  local service="$1" map="$2"
  [[ -n "$map" ]] || return 0
  gcloud run services update-traffic "$service" --project "$PROJECT" --region "$REGION" \
    --to-revisions "$map" --quiet
}

release_wait_http() {
  local url="$1" path="$2" expected="$3" field="$4" payload value
  for _attempt in $(seq 1 "${RELEASE_HEALTH_ATTEMPTS:-12}"); do
    payload="$(curl --fail --silent --max-time 10 "${url}${path}")" || payload=""
    value="$(node -e 'try {const x=JSON.parse(process.argv[1]);process.stdout.write(String(x[process.argv[2]]??""))} catch {}' "$payload" "$field")"
    if [[ "$value" == "$expected" ]]; then return 0; fi
    sleep "${RELEASE_HEALTH_INTERVAL_SECONDS:-5}"
  done
  echo "  readiness probe ${url}${path} did not report ${field}=${expected}" >&2
  return 1
}

release_worker_enabled() {
  local module="$1" modules=",${RELEASE_MODULES:-all},"
  [[ "$modules" == ',all,' || "$modules" == *",${module},"* ]] && return 0
  # The deployment plan names this image after its documents capability.
  [[ "$module" == processor && "$modules" == *",documents,"* ]]
}

release_job_image() {
  node -e 'const x=JSON.parse(process.argv[1]);const spec=x.spec?.template?.spec?.template?.spec??x.template?.template;process.stdout.write(String(spec?.containers?.[0]?.image??""))' "$1"
}

release_restore_jobs() {
  local job image failed=false
  while IFS='|' read -r job image; do
    [[ -n "$job" && -n "$image" ]] || continue
    if ! gcloud run jobs update "$job" --project "$PROJECT" --region "$REGION" --image "$image" --quiet; then
      echo "  could not restore ${job} to ${image}" >&2
      failed=true
    fi
  done <<<"${RELEASE_CHANGED_JOBS:-}"
  [[ "$failed" == false ]]
}

release_staged_services() {
  local selected="${RELEASE_COMPONENTS:-agent,web}" staging_tag="candidate-${TAG}"
  local agent_digest='' web_digest='' browser_digest='' code_digest='' processor_digest=''
  local manifest_path manifest_sha manifest_selected="$selected"
  local worker
  local worker_env_override="${RELEASE_EMAIL_OBSERVER_WORKER_ENABLED:-}"
  local agent_candidate_env
  local web_candidate_env web_resume_env web_resume_tag="resume-${TAG}"
  local web_writes_paused=false
  local RELEASE_CHANGED_JOBS=''
  local agent_before='' web_before='' agent_old_traffic='' web_old_traffic=''
  local agent_candidate_url='' web_candidate_url='' agent_promotion_attempted=false web_promotion_attempted=false
  local live_agent_json live_agent_api live_agent_schema_driver live_agent_schema_min live_agent_schema_max

  release_validate_worker_override || return $?

  case "$selected" in
    full|agent,web|web,agent) selected='agent,web' ;;
    web) ;;
    *) echo 'RELEASE_COMPONENTS must be agent,web (default) or web' >&2; return 2 ;;
  esac
  if [[ "$selected" == web && "${RELEASE_SCHEMA_UNCHANGED:-false}" != true ]]; then
    echo 'web-only release requires RELEASE_SCHEMA_UNCHANGED=true' >&2
    return 2
  fi
  release_read_contract || return 1
  if [[ "$selected" == agent,web && "$RELEASE_STORAGE_DRIVER" == firestore ]]; then
    web_writes_paused=true
  fi

  web_digest="$(release_component_digest web)" || return 1
  if [[ "$selected" == agent,web ]]; then
    agent_digest="$(release_component_digest agent)" || return 1
    for worker in browser code processor; do
      if release_worker_enabled "$worker"; then
        case "$worker" in
          browser) browser_digest="$(release_component_digest browser)" || return 1 ;;
          code) code_digest="$(release_component_digest code)" || return 1 ;;
          processor) processor_digest="$(release_component_digest processor)" || return 1 ;;
        esac
        manifest_selected="${manifest_selected},${worker}"
      fi
    done
  else
    local live_agent_service_json live_agent_revision
    live_agent_service_json="$(release_service_json assistant-agent)" || return 1
    live_agent_revision="$(release_serving_revision "$live_agent_service_json")" || return 1
    live_agent_json="$(release_revision_json assistant-agent "$live_agent_revision")" || return 1
    live_agent_api="$(release_service_env "$live_agent_json" ASSISTANT_RELEASE_API_CONTRACT)"
    live_agent_schema_driver="$(release_service_env "$live_agent_json" ASSISTANT_RELEASE_SCHEMA_DRIVER)"
    live_agent_schema_min="$(release_service_env "$live_agent_json" ASSISTANT_RELEASE_SCHEMA_MIN)"
    live_agent_schema_max="$(release_service_env "$live_agent_json" ASSISTANT_RELEASE_SCHEMA_MAX)"
    if [[ "$live_agent_schema_driver" != "$RELEASE_STORAGE_DRIVER" ]]; then
      echo "  web-only release requires live-agent metadata for ${RELEASE_STORAGE_DRIVER}." >&2
      return 1
    fi
  fi
  manifest_path="${RELEASE_MANIFEST_PATH:-${TMPDIR:-/tmp}/assistant-release-${TAG}-$$.json}"
  node "${BASH_SOURCE[0]%/*}/release-manifest.mjs" create "$manifest_path" "$TAG" \
    "$IMAGE_ROOT" "$manifest_selected" "$RELEASE_STORAGE_DRIVER" "$agent_digest" "$web_digest" "$browser_digest" "$code_digest" "$processor_digest" \
    "${live_agent_api:-}" "${live_agent_schema_min:-}" "${live_agent_schema_max:-}" || return 1
  node "${BASH_SOURCE[0]%/*}/release-manifest.mjs" validate "$manifest_path" \
    "${live_agent_api:-}" "${live_agent_schema_min:-}" "${live_agent_schema_max:-}" || return 1
  manifest_sha="$(node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(x.manifestDigest)' "$manifest_path")"
  echo "Release manifest ${manifest_sha}: ${selected}; web=${web_digest}${agent_digest:+, agent=${agent_digest}}"

  # Capture all rollback targets before the first mutation.
  web_before="$(release_service_json assistant-web)" || return 1
  web_old_traffic="$(release_traffic_map "$web_before")" || return 1
  if [[ "$selected" == agent,web ]]; then
    agent_before="$(release_service_json assistant-agent)" || return 1
    agent_old_traffic="$(release_traffic_map "$agent_before")" || return 1
  fi

  # Candidate revisions carry the manifest identity and compatibility contract.
  # --no-traffic and a tag expose a revision URL without moving user traffic.
  if [[ "$selected" == agent,web ]]; then
    agent_candidate_env="ASSISTANT_RELEASE_API_CONTRACT=${RELEASE_AGENT_API},ASSISTANT_RELEASE_WEB_API_MIN=${RELEASE_AGENT_PEER_MIN},ASSISTANT_RELEASE_WEB_API_MAX=${RELEASE_AGENT_PEER_MAX},ASSISTANT_RELEASE_SCHEMA_DRIVER=${RELEASE_STORAGE_DRIVER},ASSISTANT_RELEASE_SCHEMA_MIN=${RELEASE_AGENT_SCHEMA_MIN},ASSISTANT_RELEASE_SCHEMA_MAX=${RELEASE_AGENT_SCHEMA_MAX},ASSISTANT_RELEASE_SCHEMA_VERSION=${RELEASE_SCHEMA_VERSION},ASSISTANT_RELEASE_MANIFEST=${manifest_sha}"
    if [[ -n "$worker_env_override" ]]; then
      agent_candidate_env="${agent_candidate_env},EMAIL_OBSERVER_WORKER_ENABLED=${worker_env_override}"
    fi
    gcloud run services update assistant-agent --project "$PROJECT" --region "$REGION" \
      --image "${IMAGE_ROOT}/agent@${agent_digest}" --no-traffic --tag "$staging_tag" \
      --update-env-vars "$agent_candidate_env" --quiet || return 1
    local staged_agent_json
    staged_agent_json="$(release_service_json assistant-agent)" || return 1
    agent_candidate_url="$(release_tag_url "$staged_agent_json" "$staging_tag")" || return 1
    release_wait_http "$agent_candidate_url" /ready true ready || return 1
  fi

  web_candidate_env="ASSISTANT_RELEASE_API_CONTRACT=${RELEASE_WEB_API},ASSISTANT_RELEASE_AGENT_API_MIN=${RELEASE_WEB_PEER_MIN},ASSISTANT_RELEASE_AGENT_API_MAX=${RELEASE_WEB_PEER_MAX},ASSISTANT_RELEASE_SCHEMA_DRIVER=${RELEASE_STORAGE_DRIVER},ASSISTANT_RELEASE_SCHEMA_MIN=${RELEASE_WEB_SCHEMA_MIN},ASSISTANT_RELEASE_SCHEMA_MAX=${RELEASE_WEB_SCHEMA_MAX},ASSISTANT_RELEASE_SCHEMA_VERSION=${RELEASE_SCHEMA_VERSION},ASSISTANT_RELEASE_MANIFEST=${manifest_sha},ASSISTANT_RELEASE_WRITES_PAUSED=${web_writes_paused}"
  gcloud run services update assistant-web --project "$PROJECT" --region "$REGION" \
    --image "${IMAGE_ROOT}/web@${web_digest}" --no-traffic --tag "$staging_tag" \
    --update-env-vars "$web_candidate_env" --quiet || return 1
  local staged_web_json
  staged_web_json="$(release_service_json assistant-web)" || return 1
  web_candidate_url="$(release_tag_url "$staged_web_json" "$staging_tag")" || return 1
  release_wait_http "$web_candidate_url" /api/health "$TAG" sha || return 1
  # Persistence readiness and the secret-safe web-to-agent canary both run
  # against the no-traffic candidate before any user traffic moves.
  release_wait_http "$web_candidate_url" /api/ready true ready || return 1
  release_wait_http "$web_candidate_url" /api/release-probe true ready || return 1
  release_wait_http "$web_candidate_url" /api/release-probe "$web_writes_paused" writesPaused || return 1

  # Cloud Run Jobs do not support traffic tags. Update their templates only
  # after both service candidates pass readiness, remember the old image, and
  # restore those templates if any later promotion check fails.
  if [[ "$selected" == agent,web ]]; then
    local worker job service_account digest description old_image new_image
    for worker in browser code processor; do
      release_worker_enabled "$worker" || continue
      case "$worker" in
        browser) job=assistant-browser; service_account="assistant-browser@${PROJECT}.iam.gserviceaccount.com"; digest="$browser_digest" ;;
        code) job=assistant-code; service_account="assistant-code@${PROJECT}.iam.gserviceaccount.com"; digest="$code_digest" ;;
        processor) job=assistant-processor; service_account="assistant-processor@${PROJECT}.iam.gserviceaccount.com"; digest="$processor_digest" ;;
      esac
      [[ -n "$digest" ]] || continue
      if ! description="$(gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" --format=json 2>/dev/null)"; then
        # These module jobs may not have been provisioned yet. They have no
        # running revision to make stale, and the deploy script reports drift.
        echo "  ${job} is not provisioned; skipping its optional worker image."
        continue
      fi
      if declare -F verify_database_free_template >/dev/null; then
        verify_database_free_template job "$job" false || { release_restore_jobs || true; return 1; }
      fi
      old_image="$(release_job_image "$description")"
      [[ -n "$old_image" ]] || { release_restore_jobs || true; return 1; }
      new_image="${IMAGE_ROOT}/${worker}@${digest}"
      RELEASE_CHANGED_JOBS="${RELEASE_CHANGED_JOBS}${job}|${old_image}"$'\n'
      if ! gcloud run jobs update "$job" --project "$PROJECT" --region "$REGION" \
        --image "$new_image" --service-account "$service_account" --quiet; then
        release_restore_jobs || true
        return 1
      fi
      description="$(gcloud run jobs describe "$job" --project "$PROJECT" --region "$REGION" --format=json)" || {
        release_restore_jobs || true
        return 1
      }
      if [[ "$(release_job_image "$description")" != "$new_image" ]]; then
        release_restore_jobs || true
        echo "  ${job} template does not use the release-manifest image." >&2
        return 1
      fi
    done
  fi

  local promoted_ok=true web_paused_revision='' web_resume_revision='' web_resume_promotion_attempted=false
  if [[ "$selected" == agent,web ]]; then
    # Promote web first. Firestore full-stack upgrades keep its workspace routes
    # paused, then drain requests on the old web before changing the agent. Other
    # pairs rely on the serving-revision compatibility preflight and tagged probe.
    # Neither path probes a legacy live web image for a route it may not have.
    local staged_web_revision
    staged_web_revision="$(node -e 'const s=JSON.parse(process.argv[1]);const x=(s.status?.traffic??[]).find(t=>t.tag===process.argv[2]);process.stdout.write(x?.revisionName??"")' "$staged_web_json" "$staging_tag")"
    if [[ -z "$staged_web_revision" ]]; then
      promoted_ok=false
    else
      if [[ "$web_writes_paused" == true ]]; then web_paused_revision="$staged_web_revision"; fi
      web_promotion_attempted=true
      if ! gcloud run services update-traffic assistant-web \
        --project "$PROJECT" --region "$REGION" --to-revisions "${staged_web_revision}=100" --quiet; then
        promoted_ok=false
      fi
      local live_web_url
      if [[ "$promoted_ok" == true ]]; then
        live_web_url="$(gcloud run services describe assistant-web --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || promoted_ok=false
      fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/health "$TAG" sha; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/ready true ready; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe true ready; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe "$web_writes_paused" writesPaused; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true && "$web_writes_paused" == true ]] && ! release_drain_web_inflight "$web_before"; then promoted_ok=false; fi
    fi
  fi

  if [[ "$promoted_ok" == true && "$selected" == agent,web ]]; then
    local staged_agent_revision
    staged_agent_revision="$(node -e 'const s=JSON.parse(process.argv[1]);const x=(s.status?.traffic??[]).find(t=>t.tag===process.argv[2]);process.stdout.write(x?.revisionName??"")' "$staged_agent_json" "$staging_tag")"
    if [[ -z "$staged_agent_revision" ]]; then
      promoted_ok=false
    else
      agent_promotion_attempted=true
      if ! gcloud run services update-traffic assistant-agent \
        --project "$PROJECT" --region "$REGION" --to-revisions "${staged_agent_revision}=100" --quiet; then
        promoted_ok=false
      fi
      # The now-live new web probes the newly promoted agent. Any failure
      # restores agent then web, reversing the promotion order.
      local live_web_url
      if [[ "$promoted_ok" == true ]]; then
        live_web_url="$(gcloud run services describe assistant-web --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || promoted_ok=false
      fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/health "$TAG" sha; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/ready true ready; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe true ready; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe "$web_writes_paused" writesPaused; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true && "$web_writes_paused" == true ]]; then
        web_resume_env="${web_candidate_env%ASSISTANT_RELEASE_WRITES_PAUSED=true}ASSISTANT_RELEASE_WRITES_PAUSED=false"
        if ! gcloud run services update assistant-web --project "$PROJECT" --region "$REGION" \
          --image "${IMAGE_ROOT}/web@${web_digest}" --no-traffic --tag "$web_resume_tag" \
          --update-env-vars "$web_resume_env" --quiet; then
          promoted_ok=false
        fi
        local staged_resume_web_json resume_web_url
        if [[ "$promoted_ok" == true ]]; then
          staged_resume_web_json="$(release_service_json assistant-web)" || promoted_ok=false
        fi
        if [[ "$promoted_ok" == true ]]; then
          resume_web_url="$(release_tag_url "$staged_resume_web_json" "$web_resume_tag")" || promoted_ok=false
        fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$resume_web_url" /api/health "$TAG" sha; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$resume_web_url" /api/ready true ready; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$resume_web_url" /api/release-probe true ready; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$resume_web_url" /api/release-probe false writesPaused; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]]; then
          web_resume_revision="$(node -e 'const s=JSON.parse(process.argv[1]);const x=(s.status?.traffic??[]).find(t=>t.tag===process.argv[2]);process.stdout.write(x?.revisionName??"")' "$staged_resume_web_json" "$web_resume_tag")"
          if [[ -z "$web_resume_revision" ]]; then
            promoted_ok=false
          else
            web_resume_promotion_attempted=true
            if ! gcloud run services update-traffic assistant-web --project "$PROJECT" --region "$REGION" \
              --to-revisions "${web_resume_revision}=100" --quiet; then promoted_ok=false; fi
          fi
        fi
        if [[ "$promoted_ok" == true ]]; then
          live_web_url="$(gcloud run services describe assistant-web --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || promoted_ok=false
        fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/health "$TAG" sha; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/ready true ready; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe true ready; then promoted_ok=false; fi
        if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe false writesPaused; then promoted_ok=false; fi
      fi
    fi
  elif [[ "$promoted_ok" == true ]]; then
    local staged_web_revision
    staged_web_revision="$(node -e 'const s=JSON.parse(process.argv[1]);const x=(s.status?.traffic??[]).find(t=>t.tag===process.argv[2]);process.stdout.write(x?.revisionName??"")' "$staged_web_json" "$staging_tag")"
    if [[ -z "$staged_web_revision" ]]; then
      promoted_ok=false
    else
      web_promotion_attempted=true
      if ! gcloud run services update-traffic assistant-web \
        --project "$PROJECT" --region "$REGION" --to-revisions "${staged_web_revision}=100" --quiet; then
        promoted_ok=false
      fi
      local live_web_url
      if [[ "$promoted_ok" == true ]]; then
        live_web_url="$(gcloud run services describe assistant-web --project "$PROJECT" --region "$REGION" --format='value(status.url)')" || promoted_ok=false
      fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/health "$TAG" sha; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/ready true ready; then promoted_ok=false; fi
      if [[ "$promoted_ok" == true ]] && ! release_wait_http "$live_web_url" /api/release-probe true ready; then promoted_ok=false; fi
    fi
  fi

  if [[ "$promoted_ok" != true ]]; then
    echo '  staged release failed a promotion/readiness check; restoring captured Cloud Run traffic.' >&2
    local rollback_failed=false
    if [[ "$web_resume_promotion_attempted" == true && -n "$web_paused_revision" ]]; then
      # The unpaused web revision can write to the new storage contract. If we
      # cannot first repause it and drain its in-flight requests, restoring the
      # old agent would expose the old agent to writes it cannot safely handle.
      # Keep the current agent and job templates in place until an operator can
      # verify traffic and complete a safe recovery.
      if ! release_restore_traffic assistant-web "${web_paused_revision}=100"; then
        echo '  CRITICAL: could not repause the new web revision; leaving the current agent and jobs in place.' >&2
        return 1
      fi
      if ! release_drain_revision "$web_resume_revision"; then
        echo '  CRITICAL: new web is paused but its in-flight requests could not be drained; leaving the current agent and jobs in place.' >&2
        return 1
      fi
    fi
    if [[ "$agent_promotion_attempted" == true ]] && ! release_restore_traffic assistant-agent "$agent_old_traffic"; then rollback_failed=true; fi
    if [[ "$web_promotion_attempted" == true ]] && ! release_restore_traffic assistant-web "$web_old_traffic"; then rollback_failed=true; fi
    if ! release_restore_jobs; then rollback_failed=true; fi
    if [[ "$rollback_failed" == true ]]; then
      echo '  CRITICAL: automatic rollback failed; inspect both services traffic immediately.' >&2
    else
      echo '  previous service traffic was restored.' >&2
    fi
    return 1
  fi

  echo "Release manifest saved at ${manifest_path}"
  return 0
}
