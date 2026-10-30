import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inventoryFailureDiagnostic } from './owner-editor-inventory-diagnostics.js';
import { serviceFacts } from './owner-editor-release-inventory.js';
import {
  auditServiceFacts,
  InventoryServiceFactsError,
  sanitizeServiceAudit,
} from './owner-editor-service-facts-diagnostics.js';
import { sanitizeTrafficDetails, trafficDetails } from './owner-editor-traffic-details.js';

const secret = 'PRIVATE_do_not_emit';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const revision = 'assistant-web-00001-abc';
const tag = 'candidate-40403696377-1';
const uri = `https://${tag}---assistant-web-test-uw.a.run.app`;
describe('fixed bounded traffic detail diagnostics', () => {
  it('distinguishes omitted proto3 zero from invalid present values without changing gates', () => {
    const snapshots = [
      { revision, percent: 100, tag: undefined, uri: undefined },
      { revision, percent: undefined, tag, uri },
      ...[null, '0', 50, -1, NaN, Symbol('unreadable')].map((percent) => ({
        revision,
        percent,
        tag: secret,
        uri: secret,
      })),
    ];
    const result = sanitizeTrafficDetails(trafficDetails(snapshots, 'web'));
    expect(result.rows[1]).toMatchObject({
      percentType: 'absent',
      percentPresent: false,
      percentValue: null,
      protoJsonDefaultZero: true,
      effectivePercent: 0,
      tagPresent: true,
      tagShapeValid: true,
      tagSha256: hash(tag),
      tagKind: 'candidate_run_attempt',
      tagRunId: '40403696377',
      tagRunAttempt: 1,
      ownershipProven: false,
      uriPresent: true,
      uriShapeValid: true,
      uriMatchesTag: true,
      uriSha256: hash(uri),
      revisionSha256: hash(revision),
      sameRevisionAsUniqueHundred: true,
    });
    expect(result.rows[2]).toMatchObject({
      percentType: 'null',
      protoJsonDefaultZero: false,
      effectivePercent: null,
    });
    expect(result.rows[3]).toMatchObject({ percentType: 'string', effectivePercent: null });
    expect(result.rows[4]).toMatchObject({ percentType: 'number', effectivePercent: 50 });
    expect(result.rows[5]).toMatchObject({ percentType: 'number', effectivePercent: null });
    expect(result.rows[7]).toMatchObject({
      percentType: 'unknown',
      percentPresent: null,
      effectivePercent: null,
    });
    for (const value of [secret, tag, uri, revision])
      expect(JSON.stringify(result)).not.toContain(value);
  });
  it('reports different or ambiguous 100% revision comparisons, never infers release ownership', () => {
    const single = trafficDetails(
      [
        { revision, percent: 100, tag: undefined, uri: undefined },
        { revision: 'assistant-web-old', percent: undefined, tag: 'resume-40403696377-1', uri },
      ],
      'web',
    );
    expect(single.rows[1]).toMatchObject({
      sameRevisionAsUniqueHundred: false,
      tagKind: 'resume_run_attempt',
      ownershipProven: false,
    });
    const multiple = trafficDetails(
      [
        { revision, percent: 100, tag, uri },
        { revision: 'assistant-web-other', percent: 100, tag, uri },
      ],
      'web',
    );
    expect(multiple.rows.every((r) => r.sameRevisionAsUniqueHundred === null)).toBe(true);
    for (const candidate of [
      'operator-tag',
      'candidate-00000000000000000000-999999',
      'candidate-'.concat('a'.repeat(20)),
    ]) {
      const result = trafficDetails([{ revision, percent: 100, tag: candidate, uri }], 'web');
      expect(result.rows[0]?.ownershipProven).toBe(false);
      expect(JSON.stringify(result)).not.toContain(candidate);
    }
  });
  it('never emits URI contents or trusts arbitrary hosts/query strings as tag endpoints', () => {
    for (const url of [
      `https://${secret}.example/`,
      `https://${tag}---assistant-web-test-uw.a.run.app/?token=${secret}`,
      `https://${secret}@${tag}---assistant-web-test-uw.a.run.app/`,
    ]) {
      const result = trafficDetails([{ revision, percent: 0, tag, uri: url }], 'web');
      expect(result.rows[0]).toMatchObject({ uriShapeValid: false, uriMatchesTag: null });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
  it('captures native provider fields once, suppresses getters and preserves strict two-entry rejection', () => {
    const values = { revision, tag, uri };
    const reads = new Map<PropertyKey, number>();
    const tagged = new Proxy(values, {
      getOwnPropertyDescriptor(target, key) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    const raw = { trafficStatuses: [{ revision, percent: 100 }, tagged] };
    const audit = auditServiceFacts(raw, 'web');
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    expect(audit.issues.traffic_count).toBe(true);
    expect(audit.trafficDetails.rows[1]).toMatchObject({
      protoJsonDefaultZero: true,
      effectivePercent: 0,
    });
    const base = {
      name: 'projects/bmson-assistant/locations/us-west1/services/assistant-web',
      template: {
        serviceAccount: 'deployer@bmson-assistant.iam.gserviceaccount.com',
        containers: [
          {
            image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'a'.repeat(64)}`,
            env: Object.entries({
              PERSISTENCE_DRIVER: 'firestore',
              FIRESTORE_DATABASE_ID: 'assistant-production',
              ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
              ASSISTANT_RELEASE_SCHEMA_MIN: '1',
              ASSISTANT_RELEASE_SCHEMA_MAX: '1',
              ASSISTANT_RELEASE_API_CONTRACT: '1',
            }).map(([name, value]) => ({ name, value })),
          },
        ],
      },
      ...raw,
    };
    expect(() => serviceFacts(base, 'web')).toThrow(InventoryServiceFactsError);
    const result = inventoryFailureDiagnostic(
      'web_service',
      new InventoryServiceFactsError(base, 'web'),
    );
    expect(result).toMatchObject({
      readiness: 'unknown',
      authorityEstablished: false,
      mutationAuthorized: false,
      serviceFacts: {
        issues: { traffic_count: true },
        trafficDetails: {
          rows: expect.arrayContaining([
            expect.objectContaining({ effectivePercent: 0, ownershipProven: false }),
          ]),
        },
      },
    });
    const hostile = Object.defineProperty({}, 'percent', {
      get() {
        throw new Error(secret);
      },
    });
    expect(
      auditServiceFacts({ trafficStatuses: [hostile] }, 'web').trafficDetails.rows[0]?.percentType,
    ).toBe('unknown');
  });
  it('caps detail rows, preserves unknown input and revalidates modified typed details', () => {
    expect(
      trafficDetails(Array(33).fill({ revision, percent: 0, tag, uri }), 'web').rows,
    ).toHaveLength(32);
    expect(
      trafficDetails(Array(33).fill({ revision, percent: 0, tag, uri }), 'web').truncated,
    ).toBe(true);
    expect(trafficDetails(null, 'web')).toMatchObject({ rows: [], truncated: null });
    const result = trafficDetails([{ revision, percent: 0, tag, uri }], 'web');
    const row = result.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error('Fixture row missing');
    Object.assign(row, {
      ownershipProven: true,
      effectivePercent: 99,
      percentValue: secret,
      tagRunId: secret,
      uriSha256: secret,
      tagKind: secret,
    });
    Object.defineProperty(row, 'tagSha256', {
      get() {
        throw new Error(secret);
      },
    });
    const safe = sanitizeTrafficDetails(result);
    expect(safe.rows[0]).toMatchObject({
      ownershipProven: false,
      effectivePercent: null,
      tagRunId: null,
      tagSha256: null,
      uriSha256: null,
      tagKind: 'unknown',
    });
    expect(JSON.stringify(safe)).not.toContain(secret);
    const error = new InventoryServiceFactsError({}, 'web');
    const poisoned = {
      ...error.facts,
      trafficDetails: Object.defineProperty({}, 'rows', {
        get() {
          throw new Error(secret);
        },
      }),
    };
    expect(sanitizeServiceAudit(poisoned).trafficDetails.rows).toEqual([]);
  });
});
