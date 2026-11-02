import { describe, expect, it } from 'vitest';
import { HISTORICAL_WEB_TAGS, tagHash, WEB_SERVICE } from './owner-web-tag-retirement.js';
import { describeWebTrafficDiscrepancy } from './owner-web-traffic-discrepancy.js';

const secret = 'PRIVATE_ENV_CREDENTIAL_URI_PAYLOAD';
const old = HISTORICAL_WEB_TAGS[0],
  current = HISTORICAL_WEB_TAGS[1];
if (!old || !current) throw new Error('Missing reviewed fixture pins');
const row = (proof = old, percent = 0) => ({
  type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
  revision: proof.revision,
  tag: proof.tag,
  percent,
});
const snapshot = (desired: unknown[], observed: unknown[]) => ({
  name: WEB_SERVICE,
  traffic: desired,
  trafficStatuses: observed,
  template: { containers: [{ env: [{ name: 'SECRET', value: secret }] }] },
  annotations: { private: secret },
});

describe('bounded canonical traffic discrepancy hints', () => {
  it('reports no canonical difference for order, status URI, long revision names and omitted zero', () => {
    const desired = [
      { type: row().type, revision: `${WEB_SERVICE}/revisions/${old.revision}`, tag: old.tag },
      row(current, 100),
    ];
    const result = describeWebTrafficDiscrepancy(
      snapshot(desired, [
        { ...row(current, 100), uri: secret },
        { ...row(), uri: secret },
      ]),
    );
    expect(result.comparison).toBe('canonical_multiset_equal');
    expect(result).toMatchObject({
      desiredOnlyIdentities: 0,
      observedOnlyIdentities: 0,
      desired: { rowCount: 2, comparableRows: 2, omittedPercentRows: 1 },
      observed: { rowCount: 2, omittedPercentRows: 0 },
      ownershipProven: false,
      mutationAuthority: false,
      repairProposed: false,
      readiness: 'unknown',
    });
    expect(result.categories).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('reports exact missing-tag membership and hashes without raw tag, revision, URI or env', () => {
    const result = describeWebTrafficDiscrepancy(
      snapshot([row(), row(current, 100)], [row(current, 100)]),
    );
    expect(result.comparison).toBe('canonical_multiset_differs');
    expect(result.categories).toEqual(
      expect.arrayContaining([
        'row_count_differs',
        'desired_only_identity',
        'tag_absent_from_observed',
      ]),
    );
    expect(result.byTag).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagSha256: tagHash(old.tag),
          tagMembership: 'historical_old',
          desiredCount: 1,
          observedCount: 0,
          presence: 'desired_only',
          desired: [
            expect.objectContaining({
              revisionSha256: tagHash(old.revision),
              revisionMembership: 'historical_old',
              effectivePercent: 0,
              count: 1,
            }),
          ],
        }),
      ]),
    );
    const text = JSON.stringify(result);
    for (const excluded of [
      old.tag,
      current.tag,
      old.revision,
      current.revision,
      secret,
      'uri',
      'containers',
      'annotations',
    ])
      expect(text).not.toContain(excluded);
  });
  it('distinguishes percent assignment changes for a known tag', () => {
    const result = describeWebTrafficDiscrepancy(snapshot([row(current, 100)], [row(current, 0)]));
    expect(result.categories).toEqual(
      expect.arrayContaining(['percent_multiset_differs', 'same_tag_percent_assignment_differs']),
    );
    expect(result.byTag?.[0]).toMatchObject({
      tagMembership: 'historical_current',
      presence: 'both',
      percentAssignmentDiffers: true,
      revisionAssignmentDiffers: false,
      desired: [{ effectivePercent: 100, count: 1 }],
      observed: [{ effectivePercent: 0, count: 1 }],
    });
  });
  it('distinguishes a revision reassignment even when field multisets alone are unchanged', () => {
    const result = describeWebTrafficDiscrepancy(
      snapshot(
        [row(), row(current, 100)],
        [
          { ...row(), revision: current.revision },
          { ...row(current, 100), revision: old.revision },
        ],
      ),
    );
    expect(result.comparison).toBe('canonical_multiset_differs');
    expect(result.categories).toContain('same_tag_revision_assignment_differs');
    expect(result.categories).not.toContain('revision_multiset_differs');
  });
  it('reports duplicate multiplicity without pretending it is a different revision/percent assignment', () => {
    const result = describeWebTrafficDiscrepancy(
      snapshot([row(), row(), row(current, 100)], [row(), row(current, 100)]),
    );
    expect(result.categories).toContain('desired_duplicate_identity');
    expect(result.desired?.duplicateIdentities).toEqual([expect.objectContaining({ count: 2 })]);
    expect(result.byTag?.find((tag) => tag.tagMembership === 'historical_old')).toMatchObject({
      desiredCount: 2,
      observedCount: 1,
      revisionAssignmentDiffers: false,
      percentAssignmentDiffers: false,
    });
    expect(result).toMatchObject({ desiredOnlyIdentities: 1, observedOnlyIdentities: 0 });
  });
  it('does not infer ownership for unknown operator aliases or untagged allocation', () => {
    const operator = { ...row(), tag: 'operator-private-name', revision: 'assistant-web-operator' };
    const result = describeWebTrafficDiscrepancy(
      snapshot(
        [operator, { type: row().type, revision: current.revision, percent: 100 }],
        [row(), row(current, 100)],
      ),
    );
    expect(result.byTag).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagSha256: tagHash(operator.tag), tagMembership: 'other' }),
        expect.objectContaining({ tagSha256: null, tagMembership: 'absent' }),
      ]),
    );
    expect(result.ownershipProven).toBe(false);
    expect(JSON.stringify(result)).not.toContain(operator.tag);
    expect(JSON.stringify(result)).not.toContain(operator.revision);
  });
  it.each([
    [null, 'row_not_object'],
    [{ ...row(), private: secret }, 'unknown_field'],
    [{ ...row(), type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST' }, 'allocation_unresolved'],
    [{ ...row(), revision: `projects/private/revisions/${secret}` }, 'revision_invalid'],
    [{ ...row(), percent: null }, 'percent_invalid'],
    [{ ...row(), percent: '0' }, 'percent_invalid'],
    [{ ...row(), tag: '' }, 'tag_invalid'],
    [{ ...row(), tag: secret }, 'tag_invalid'],
  ])(
    'keeps invalid identity coverage uncomparable without an inferred equality or absence: %s',
    (invalid, category) => {
      const result = describeWebTrafficDiscrepancy(snapshot([invalid], [row()]));
      expect(result.comparison).toBe('uncomparable');
      expect(result.desired?.invalidCategories).toContainEqual({ category, count: 1 });
      expect(result.desired?.canonicalTrafficSha256).toBeNull();
      expect(result.byTag).toBeNull();
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
  it('reports missing arrays, empty arrays and excessive bounds without a fake zero/equality', () => {
    expect(describeWebTrafficDiscrepancy({ name: WEB_SERVICE, traffic: [row()] })).toMatchObject({
      comparison: 'unavailable',
      reason: 'traffic_arrays_missing',
      desiredCount: 1,
      observedCount: null,
    });
    expect(describeWebTrafficDiscrepancy(snapshot([], []))).toMatchObject({
      comparison: 'unavailable',
      reason: 'traffic_row_bound',
    });
    expect(describeWebTrafficDiscrepancy(snapshot(Array(33).fill(row()), [row()]))).toMatchObject({
      comparison: 'unavailable',
      reason: 'traffic_row_bound',
      desiredCount: 33,
      observedCount: 1,
      rowBound: 32,
    });
  });
  it('does not expose wrong-service payloads or hostile getters', () => {
    expect(
      describeWebTrafficDiscrepancy({ ...snapshot([row()], [row()]), name: secret }),
    ).toMatchObject({ comparison: 'unavailable', reason: 'fixed_service_unverified' });
    const bad = Object.defineProperty({}, 'name', {
      get() {
        throw new Error(secret);
      },
    });
    const result = describeWebTrafficDiscrepancy(bad);
    expect(result).toMatchObject({ comparison: 'unavailable', reason: 'projection_unreadable' });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('bounds output bytes for many distinct identities without truncated equality claims', () => {
    const desired = Array.from({ length: 32 }, (_, i) => ({
      ...row(),
      tag: `operator-desired-${i}`,
      revision: `assistant-web-desired-${i}`,
    }));
    const observed = Array.from({ length: 32 }, (_, i) => ({
      ...row(),
      tag: `operator-observed-${i}`,
      revision: `assistant-web-observed-${i}`,
    }));
    const result = describeWebTrafficDiscrepancy(snapshot(desired, observed));
    expect(result).toMatchObject({
      comparison: 'unavailable',
      reason: 'diagnostic_byte_bound',
      desiredCount: 32,
      observedCount: 32,
      byteBound: 16384,
      mutationAuthority: false,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16384);
  });
});
