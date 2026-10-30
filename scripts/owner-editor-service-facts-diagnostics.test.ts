import { describe, expect, it } from 'vitest';
import { inventoryFailureDiagnostic } from './owner-editor-inventory-diagnostics.js';
import { serviceFacts } from './owner-editor-release-inventory.js';
import {
  auditServiceFacts,
  InventoryServiceFactsError,
  sanitizeServiceAudit,
} from './owner-editor-service-facts-diagnostics.js';

type Env = { name: string; value: unknown; valueSource?: unknown; valueFrom?: unknown };
const secret = 'PRIVATE_do_not_emit_value_id_url';
function fixture() {
  return {
    name: 'projects/bmson-assistant/locations/us-west1/services/assistant-web',
    template: {
      serviceAccount: 'deployer@bmson-assistant.iam.gserviceaccount.com',
      containers: [
        {
          image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'a'.repeat(64)}`,
          env: [
            ...Object.entries({
              PERSISTENCE_DRIVER: 'firestore',
              FIRESTORE_DATABASE_ID: 'assistant-production',
              ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
              ASSISTANT_RELEASE_SCHEMA_MIN: '1',
              ASSISTANT_RELEASE_SCHEMA_MAX: '1',
              ASSISTANT_RELEASE_API_CONTRACT: '1',
              ASSISTANT_WORKSPACE_ID: 'private_workspace',
              FIRESTORE_AGENT_ID: '11111111-1111-4111-8111-111111111111',
            }).map(([name, value]) => ({ name, value })),
            { name: 'PRIVATE_UNRELATED_FIELD', value: secret },
          ] as Env[],
        },
      ],
    },
    trafficStatuses: [{ revision: 'assistant-web-00001-abc', percent: 100 }] as {
      revision: string;
      percent: number;
      uri?: string;
    }[],
    reconciling: false,
  };
}
function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Fixture row missing');
  return value;
}
function closed(value: unknown) {
  const text = JSON.stringify(value);
  for (const privateValue of [
    secret,
    'private_workspace',
    '11111111-1111-4111-8111-111111111111',
    'PRIVATE_UNRELATED_FIELD',
    'deployer@',
    'assistant-web-00001-abc',
    'https://',
    'sha256:',
  ])
    expect(text).not.toContain(privateValue);
}
describe('bounded service facts rejection diagnostics', () => {
  it('keeps valid facts and audit checks unchanged', () => {
    const value = fixture();
    const facts = serviceFacts(value, 'web');
    expect(facts.image).toBe(first(value.template.containers).image);
    expect(facts.servingRevisionVerified).toBe(false);
    const audit = auditServiceFacts(value, 'web');
    expect(audit.reasons).toEqual([]);
    expect(Object.values(audit.issues).every((v) => v === false)).toBe(true);
    closed(audit);
  });
  it.each([
    [
      'service_identity',
      (v: ReturnType<typeof fixture>) => {
        v.name = secret;
      },
    ],
    [
      'account',
      (v: ReturnType<typeof fixture>) => {
        v.template.serviceAccount = secret;
      },
    ],
    [
      'container',
      (v: ReturnType<typeof fixture>) => {
        v.template.containers = [];
      },
    ],
    [
      'image',
      (v: ReturnType<typeof fixture>) => {
        first(v.template.containers).image = secret;
      },
    ],
    [
      'env_literal',
      (v: ReturnType<typeof fixture>) => {
        first(v.template.containers).env.push({ name: 'RELEASE_SHA', value: 42 });
      },
    ],
    [
      'env_length',
      (v: ReturnType<typeof fixture>) => {
        first(v.template.containers).env.push({ name: 'RELEASE_SHA', value: 'x'.repeat(129) });
      },
    ],
    [
      'env_chars',
      (v: ReturnType<typeof fixture>) => {
        first(v.template.containers).env.push({
          name: 'ASSISTANT_RELEASE_MANIFEST',
          value: `${secret}/invalid`,
        });
      },
    ],
    [
      'env_duplicate',
      (v: ReturnType<typeof fixture>) => {
        first(v.template.containers).env.push({ name: 'PERSISTENCE_DRIVER', value: 'firestore' });
      },
    ],
    [
      'env_secret_ref',
      (v: ReturnType<typeof fixture>) => {
        first(v.template.containers).env.push({
          name: 'RELEASE_SHA',
          value: 'abc',
          valueSource: { secretKeyRef: { secret } },
        });
      },
    ],
    [
      'persistence',
      (v: ReturnType<typeof fixture>) => {
        first(first(v.template.containers).env).value = 'postgres';
      },
    ],
    [
      'traffic_count',
      (v: ReturnType<typeof fixture>) => {
        v.trafficStatuses.push({
          revision: 'assistant-web-historical',
          percent: 0,
          uri: `https://${secret}`,
        });
      },
    ],
    [
      'revision',
      (v: ReturnType<typeof fixture>) => {
        first(v.trafficStatuses).revision = secret;
      },
    ],
    [
      'percent',
      (v: ReturnType<typeof fixture>) => {
        first(v.trafficStatuses).percent = 50;
      },
    ],
    [
      'reconciling',
      (v: ReturnType<typeof fixture>) => {
        v.reconciling = true;
      },
    ],
  ])('reports fixed %s group without leaking or accepting invalid facts', (group, mutate) => {
    const raw = fixture();
    mutate(raw);
    let failure: unknown;
    try {
      serviceFacts(raw, 'web');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InventoryServiceFactsError);
    const result = inventoryFailureDiagnostic('web_service', failure);
    expect(result).toMatchObject({
      errorClass: 'ServiceFactsError',
      readiness: 'unknown',
      authorityEstablished: false,
      mutationAuthorized: false,
      serviceFacts: {
        reasons: expect.arrayContaining([group]),
        issues: { [group as string]: true },
        diagnosticHintsOnly: true,
      },
    });
    closed(result);
  });
  it('reports all simultaneous failures, safe counts and static invalid field names', () => {
    const raw = fixture();
    first(raw.template.containers).image = secret;
    first(raw.template.containers).env.push({
      name: 'ASSISTANT_RELEASE_MANIFEST',
      value: `${'x'.repeat(129)}/${secret}`,
    });
    raw.trafficStatuses.push({ revision: 'assistant-web-historical', percent: 0 });
    raw.reconciling = true;
    const result = sanitizeServiceAudit(auditServiceFacts(raw, 'web'));
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'image',
        'env_length',
        'env_chars',
        'traffic_count',
        'percent',
        'reconciling',
      ]),
    );
    expect(result.invalidEnvFields).toEqual(['ASSISTANT_RELEASE_MANIFEST']);
    expect(result.counts).toMatchObject({
      trafficRows: 2,
      trafficZero: 1,
      trafficHundred: 1,
      trafficOther: 0,
      trafficInvalid: 0,
    });
    closed(result);
  });
  it('diagnoses absent editor target without changing its existing nonfatal contract', () => {
    const raw = fixture();
    first(raw.template.containers).env = first(raw.template.containers).env.filter(
      (e) => e.name !== 'FIRESTORE_AGENT_ID',
    );
    expect(serviceFacts(raw, 'web').editorMetadataTarget).toBeNull();
    expect(auditServiceFacts(raw, 'web').issues.editor_target).toBe(true);
  });
  it('uses unknown for accessors, never invokes getters/coercion and captures descriptors once', () => {
    const raw = fixture();
    let calls = 0;
    Object.defineProperty(raw, 'trafficStatuses', {
      get() {
        calls++;
        throw new Error(secret);
      },
    });
    Object.defineProperty(first(raw.template.containers), 'image', {
      get() {
        calls++;
        return secret;
      },
    });
    const audit = auditServiceFacts(raw, 'web');
    expect(audit.issues.traffic_count).toBeNull();
    expect(audit.counts.trafficRows).toBeNull();
    expect(audit.issues.image).toBeNull();
    expect(calls).toBe(0);
    closed(audit);
    const reads = new Map<PropertyKey, number>();
    const proxy = new Proxy(fixture(), {
      getOwnPropertyDescriptor(target, key) {
        const n = (reads.get(key) ?? 0) + 1;
        reads.set(key, n);
        return n === 1
          ? Object.getOwnPropertyDescriptor(target, key)
          : { configurable: true, value: secret };
      },
    });
    closed(auditServiceFacts(proxy, 'web'));
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    closed(
      auditServiceFacts(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error(secret);
            },
          },
        ),
        'web',
      ),
    );
  });
  it('bounds all counts and revalidates typed diagnostic metadata without getters', () => {
    const raw = fixture();
    raw.trafficStatuses = Array(1001).fill({ revision: secret, percent: 100 });
    const audit = auditServiceFacts(raw, 'web');
    expect(audit.issues.diagnostic_bound).toBe(true);
    expect(audit.counts.trafficRows).toBeNull();
    closed(audit);
    const error = new InventoryServiceFactsError(raw, 'web');
    Object.defineProperty(error, 'facts', {
      get() {
        throw new Error(secret);
      },
    });
    const result = inventoryFailureDiagnostic('web_service', error);
    closed(result);
    expect(result).toMatchObject({
      serviceFacts: { service: 'unknown', reason: 'unknown_validation', invalidEnvFields: [] },
    });
    const poisoned = {
      service: secret,
      issues: { image: secret },
      counts: { trafficRows: secret },
      invalidEnvFields: [secret, 'RELEASE_SHA'],
    };
    expect(sanitizeServiceAudit(poisoned)).toMatchObject({
      service: 'unknown',
      issues: { image: null },
      counts: { trafficRows: null },
      invalidEnvFields: ['RELEASE_SHA'],
    });
  });
});
