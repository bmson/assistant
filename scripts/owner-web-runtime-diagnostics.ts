/** Read-only diagnostics. Fixed resources and field masks; no application content is retained. */
export const DIAGNOSTIC_SERVICE =
  'projects/bmson-assistant/locations/us-west1/services/assistant-web';
export const HISTORICAL_DIAGNOSTIC_REVISION = 'assistant-web-01080-hel';
const REVISION = /^assistant-web-[a-z0-9-]{1,63}$/;
const IMAGE = /^us-west1-docker\.pkg\.dev\/bmson-assistant\/assistant\/web@sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RESOURCE_FIELDS = 'limits,cpuIdle,startupCpuBoost';
const CONFIG_FIELDS = `timeout,maxInstanceRequestConcurrency,scaling(minInstanceCount,maxInstanceCount),containers(image,resources(${RESOURCE_FIELDS}))`;
export const SERVICE_FIELDS = `name,uid,etag,generation,observedGeneration,reconciling,terminalCondition(state),traffic(type,revision,percent,tag),trafficStatuses(type,revision,percent,tag),scaling(minInstanceCount,maxInstanceCount,manualInstanceCount,scalingMode),template(${CONFIG_FIELDS})`;
export const REVISION_FIELDS = `name,uid,${CONFIG_FIELDS}`;
export const LOG_FIELDS = 'entries(timestamp,httpRequest(status,latency)),nextPageToken';
type ObjectValue = Record<string, unknown>;
type Observed<T> = { state: 'observed'; value: T } | { state: 'not_returned' };
type Reason =
  | 'invalid_configuration'
  | 'invalid_window'
  | 'identity_changed'
  | 'access_denied'
  | 'read_failed'
  | 'response_invalid'
  | 'deadline_exceeded';
export class DiagnosticError extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
function fail(reason: Reason = 'invalid_configuration'): never {
  throw new DiagnosticError(reason);
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as ObjectValue;
}
function optional<T>(value: unknown, validate: (value: unknown) => T): Observed<T> {
  return value === undefined
    ? { state: 'not_returned' }
    : { state: 'observed', value: validate(value) };
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2147483647)
    fail();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') fail();
  return value;
}
function literal(value: unknown, expression: RegExp): string {
  if (typeof value !== 'string' || !expression.test(value)) fail();
  return value;
}
export function durationSeconds(value: unknown): number {
  const text = literal(value, /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,9})?s$/);
  const seconds = Number(text.slice(0, -1));
  if (seconds > 86400) fail();
  return seconds;
}
function revision(value: unknown): string {
  return literal(value, REVISION);
}
function canonicalIdentity(raw: unknown) {
  const value = object(raw);
  if (
    value.name !== DIAGNOSTIC_SERVICE ||
    value.reconciling !== false ||
    object(value.terminalCondition).state !== 'CONDITION_SUCCEEDED'
  )
    fail();
  const generation = literal(value.generation, /^[1-9][0-9]{0,19}$/);
  if (value.observedGeneration !== generation) fail();
  const normalize = (rows: unknown) => {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) fail();
    const normalized = rows.map((rawRow) => {
      const row = object(rawRow);
      if (row.type !== 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION') fail();
      const percent = row.percent === undefined ? 0 : integer(row.percent);
      if (percent > 100) fail();
      return {
        revision: revision(row.revision),
        percent,
        tag: optional(row.tag, (tag) => literal(tag, /^[a-z0-9-]{1,63}$/)),
      };
    });
    return normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  };
  const desired = normalize(value.traffic),
    observed = normalize(value.trafficStatuses);
  if (JSON.stringify(desired) !== JSON.stringify(observed)) fail();
  const current = desired.filter((row) => row.percent === 100);
  const canonical = current[0];
  if (
    current.length !== 1 ||
    !canonical ||
    desired.some((row) => row.percent > 0 && row !== canonical)
  )
    fail();
  return {
    uid: literal(value.uid, UUID),
    etag: literal(value.etag, /^[ -~]{1,512}$/),
    generation,
    revision: canonical.revision,
  };
}
function scaling(raw: unknown, service = false) {
  const value = raw === undefined ? {} : object(raw);
  return {
    minInstances: optional(value.minInstanceCount, integer),
    maxInstances: optional(value.maxInstanceCount, integer),
    ...(service
      ? {
          manualInstances: optional(value.manualInstanceCount, integer),
          mode: optional(value.scalingMode, (mode) =>
            literal(mode, /^(AUTOMATIC|MANUAL|SCALING_MODE_UNSPECIFIED)$/),
          ),
        }
      : {}),
  };
}
function configuration(raw: unknown) {
  const value = object(raw);
  if (
    !Array.isArray(value.containers) ||
    value.containers.length < 1 ||
    value.containers.length > 10
  )
    fail();
  const web = value.containers
    .map(object)
    .filter((container) => typeof container.image === 'string' && IMAGE.test(container.image));
  const container = web[0];
  if (web.length !== 1 || !container) fail();
  const resources = container.resources === undefined ? {} : object(container.resources);
  const limits = resources.limits === undefined ? {} : object(resources.limits);
  const quantity = (v: unknown) => {
    const text = literal(
      v,
      /^(?:[1-9][0-9]{0,8}(?:\.[0-9]{1,3})?|0\.[0-9]{1,3})(?:m|[KMGTPE]i?)?$/,
    );
    if (!(Number.parseFloat(text) > 0)) fail();
    return text;
  };
  return {
    scope: 'web_container_only' as const,
    image: literal(container.image, IMAGE),
    timeoutSeconds: optional(value.timeout, durationSeconds),
    concurrency: optional(value.maxInstanceRequestConcurrency, integer),
    scaling: scaling(value.scaling),
    cpu: optional(limits.cpu, quantity),
    memory: optional(limits.memory, quantity),
    cpuIdle: optional(resources.cpuIdle, bool),
    startupCpuBoost: optional(resources.startupCpuBoost, bool),
  };
}
export function diagnosticWindow(start: string, end: string, now: number) {
  const iso = (value: string) => {
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value
    )
      fail('invalid_window');
    return Date.parse(value);
  };
  const from = iso(start),
    to = iso(end);
  if (from >= to || to - from > 900000 || to > now || now - from > 86400000) fail('invalid_window');
  return { start, end };
}
export function libraryLogFilter(window: { start: string; end: string }, current: string) {
  diagnosticWindow(window.start, window.end, Date.now());
  revision(current);
  return [
    'resource.type="cloud_run_revision"',
    'resource.labels.project_id="bmson-assistant"',
    'resource.labels.location="us-west1"',
    'resource.labels.service_name="assistant-web"',
    `resource.labels.revision_name="${current}"`,
    'logName="projects/bmson-assistant/logs/run.googleapis.com%2Frequests"',
    `timestamp>="${window.start}"`,
    `timestamp<"${window.end}"`,
    'httpRequest.requestUrl=~"^https://bot[.]bmson[.]com/profile/knowledge[?]view=library(&[_]rsc=[A-Za-z0-9_-]{1,128})?$"',
  ].join('\n');
}
/** The production caller supplies only a token from the existing protected WIF. */
export function runtimeDiagnosticClient(
  token: string,
  request: typeof fetch = fetch,
  monotonic: () => number = performance.now.bind(performance),
) {
  literal(token, /^[A-Za-z0-9._~-]{1,16384}$/);
  const deadline = monotonic() + 60000;
  let calls = 0;
  async function json(url: URL, body?: ObjectValue) {
    if (++calls > 6) fail('deadline_exceeded');
    const milliseconds = Math.floor(Math.min(15000, deadline - monotonic()));
    if (milliseconds <= 0) fail('deadline_exceeded');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DiagnosticError('deadline_exceeded'));
      }, milliseconds);
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([
        request(url, {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        expired,
      ]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        fail(response.status === 401 || response.status === 403 ? 'access_denied' : 'read_failed');
      }
      if (!response.body) fail('response_invalid');
      reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), expired]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256 * 1024) fail('response_invalid');
        parts.push(part.value);
      }
      return object(JSON.parse(Buffer.concat(parts).toString('utf8')));
    } catch (error) {
      if (error instanceof DiagnosticError) throw error;
      fail('read_failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }
  const run = (path: string, fields: string) => {
    const url = new URL(`https://run.googleapis.com/v2/${path}`);
    url.searchParams.set('fields', fields);
    return json(url);
  };
  return {
    service: () => run(DIAGNOSTIC_SERVICE, SERVICE_FIELDS),
    revision: (name: string) =>
      run(`${DIAGNOSTIC_SERVICE}/revisions/${revision(name)}`, REVISION_FIELDS),
    logs: (window: { start: string; end: string }, name: string, cursor?: string) => {
      if (cursor !== undefined && (cursor.length < 1 || cursor.length > 4096))
        fail('response_invalid');
      const url = new URL('https://logging.googleapis.com/v2/entries:list');
      url.searchParams.set('fields', LOG_FIELDS);
      return json(url, {
        resourceNames: ['projects/bmson-assistant'],
        filter: libraryLogFilter(window, name),
        orderBy: 'timestamp desc',
        pageSize: 100,
        ...(cursor ? { pageToken: cursor } : {}),
      });
    },
  };
}
export async function collectRuntimeDiagnostics(
  client: ReturnType<typeof runtimeDiagnosticClient>,
  window: { start: string; end: string },
  includeHistorical = false,
) {
  diagnosticWindow(window.start, window.end, Date.now());
  const first = await client.service(),
    identity = canonicalIdentity(first);
  const rawCurrent = await client.revision(identity.revision);
  if (rawCurrent.name !== `${DIAGNOSTIC_SERVICE}/revisions/${identity.revision}`) fail();
  const current = configuration(rawCurrent);
  const historical = includeHistorical
    ? await client.revision(HISTORICAL_DIAGNOSTIC_REVISION)
    : undefined;
  if (
    historical &&
    historical.name !== `${DIAGNOSTIC_SERVICE}/revisions/${HISTORICAL_DIAGNOSTIC_REVISION}`
  )
    fail();
  let timing: ObjectValue;
  try {
    const entries: unknown[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 2; page++) {
      const result = await client.logs(window, identity.revision, cursor);
      const rows = result.entries === undefined ? [] : result.entries;
      if (!Array.isArray(rows) || rows.length > 100) fail('response_invalid');
      entries.push(...rows);
      cursor =
        result.nextPageToken === undefined
          ? undefined
          : literal(result.nextPageToken, /^[\x21-\x7e]{1,4096}$/);
      if (!cursor) break;
      if (seen.has(cursor)) fail('response_invalid');
      seen.add(cursor);
    }
    const durations: number[] = [],
      buckets = new Map<string, { minute: string; statusClass: string; count: number }>();
    let invalid = 0,
      missingDuration = 0;
    for (const raw of entries) {
      try {
        const entry = object(raw),
          http = object(entry.httpRequest);
        const stamp = literal(
          entry.timestamp,
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.[0-9]{1,9})?Z$/,
        );
        const time = Date.parse(stamp);
        if (
          !Number.isFinite(time) ||
          new Date(time).toISOString().slice(0, 19) !== stamp.slice(0, 19) ||
          time < Date.parse(window.start) ||
          time >= Date.parse(window.end)
        )
          fail();
        const status = integer(http.status);
        if (status < 100 || status > 599) fail();
        const minute = `${new Date(time).toISOString().slice(0, 16)}:00Z`,
          statusClass = `${Math.floor(status / 100)}xx`,
          key = `${minute}/${statusClass}`;
        const bucket = buckets.get(key) ?? { minute, statusClass, count: 0 };
        bucket.count++;
        buckets.set(key, bucket);
        try {
          durations.push(durationSeconds(http.latency) * 1000);
        } catch {
          missingDuration++;
        }
      } catch {
        invalid++;
      }
    }
    durations.sort((a, b) => a - b);
    const percentile = (p: number) => {
      const value = durations[Math.ceil(durations.length * p) - 1];
      return durations.length < 10 || value === undefined ? null : Math.round(value);
    };
    timing = {
      status: 'bounded_sample',
      scope: 'canonical_library_url_optional_rsc_current_revision',
      window,
      returnedEntries: entries.length,
      invalidEntries: invalid,
      missingOrInvalidDurations: missingDuration,
      validDurations: durations.length,
      truncated: cursor !== undefined,
      coverage: 'bounded_sample_not_whole_backend_or_browser',
      buckets: [...buckets.values()].sort(
        (a, b) => a.minute.localeCompare(b.minute) || a.statusClass.localeCompare(b.statusClass),
      ),
      sampleP50Milliseconds: percentile(0.5),
      sampleP95Milliseconds: percentile(0.95),
    };
  } catch (error) {
    timing = {
      status: 'unavailable',
      reason: error instanceof DiagnosticError ? error.reason : 'read_failed',
    };
  }
  const final = await client.service();
  if (JSON.stringify(canonicalIdentity(final)) !== JSON.stringify(identity))
    fail('identity_changed');
  return {
    format: 1,
    service: DIAGNOSTIC_SERVICE,
    identity,
    currentRevision: {
      revision: identity.revision,
      uid: optional(rawCurrent.uid, (uid) => literal(uid, UUID)),
      ...current,
    },
    nextRevisionTemplate: configuration(object(first).template),
    serviceScaling: scaling(object(first).scaling, true),
    ...(historical
      ? {
          historicalRevision: {
            revision: HISTORICAL_DIAGNOSTIC_REVISION,
            uid: optional(historical.uid, (uid) => literal(uid, UUID)),
            ...configuration(historical),
          },
        }
      : {}),
    timing,
    mutationAuthority: false,
    servingSourceSHA: { state: 'not_qualified_by_configuration_read' },
  };
}
