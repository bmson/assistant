import type {
  OwnerEditorCorrectionEligibility,
  OwnerEditorScope,
} from '@assistant/persistence/owner-editor';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerEditorControlsProps } from '@/app/people/owner-editor-controls';
import { bindSelectedFamilyRemoval } from './owner-editor-removal-view';
import { issueOwnerEditorFormGrant } from './owner-editor-scope';

const now = Date.parse('2026-11-05T12:00:00Z');
const ownerId = '11111111-1111-4111-8111-111111111111';
const person = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const relation = '44444444-4444-4444-8444-444444444444';
const secondRelation = '55555555-5555-4555-8555-555555555555';
const secret = 'offline-exact-removal-view-secret';
const session = { ownerId, formSessionScope: 'offline_removal_view_session' };
function eligibility(relationId: string): OwnerEditorCorrectionEligibility {
  return {
    relationId,
    revision: 'a'.repeat(64),
    sourceText: 'Exact displayed source note',
    original: {
      subjectContactId: person,
      objectContactId: other,
      expectedSubjectRevision: 'b'.repeat(64),
      expectedObjectRevision: 'c'.repeat(64),
      predicate: 'parent_of',
      timing: 'present',
      validity: { validFrom: null, validUntil: null },
      note: '',
      expectedCanonicalState: { kind: 'absent' },
    },
  };
}
function fixture() {
  const editor: OwnerEditorControlsProps = {
    session,
    createGrant: null,
    removals: [relation, secondRelation].map((id) => ({
      eligibility: eligibility(id),
      grant: issueOwnerEditorFormGrant({
        context: { ownerId, epoch: other, privacyGeneration: null },
        session,
        command: 'remove_owner_family_relationship',
        targetId: id,
        secret,
        now,
      }),
    })),
  };
  const review = vi
    .fn<
      (
        scope: OwnerEditorScope,
        value: OwnerEditorCorrectionEligibility,
      ) => Promise<{ revision: string } | null>
    >()
    .mockResolvedValue({ revision: 'd'.repeat(64) });
  return { editor, review, secret, now, selectedRelationId: relation };
}
describe('selected family removal review binding', () => {
  it('does no closure scans without an exact eligible selection', async () => {
    const f = fixture();
    expect(await bindSelectedFamilyRemoval({ ...f, selectedRelationId: null })).toMatchObject({
      removals: [],
    });
    expect(await bindSelectedFamilyRemoval({ ...f, selectedRelationId: person })).toMatchObject({
      removals: [],
    });
    expect(f.review).not.toHaveBeenCalled();
  });
  it('binds only one verified operation to its stronger review while preserving the displayed source and original view', async () => {
    const f = fixture();
    const reviewed = await bindSelectedFamilyRemoval(f);
    expect(f.review).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: 'remove_owner_family_relationship',
        targetId: relation,
        operationId: f.editor.removals?.[0]?.grant.operationId,
      }),
      f.editor.removals?.[0]?.eligibility,
    );
    expect(reviewed?.removals).toHaveLength(1);
    expect(reviewed?.removals?.[0]?.eligibility).toEqual({
      ...eligibility(relation),
      revision: 'd'.repeat(64),
    });
    expect(reviewed?.removals?.[0]?.grant).toBe(f.editor.removals?.[0]?.grant);
    expect(f.editor.removals).toHaveLength(2);
    expect(f.editor.removals?.[0]?.eligibility.revision).toBe('a'.repeat(64));
  });
  it.each(['handle', 'operation', 'target', 'expired'] as const)(
    'does not review a changed %s binding',
    async (mode) => {
      const f = fixture();
      const first = f.editor.removals?.[0];
      if (!first) throw Error('Missing fixture');
      if (mode === 'handle') first.grant.issuedOperationHandle += 'tampered';
      if (mode === 'operation') first.grant.operationId = person;
      if (mode === 'target') first.eligibility.relationId = secondRelation;
      const reviewed = await bindSelectedFamilyRemoval({
        ...f,
        now: mode === 'expired' ? now + 600_001 : now,
      });
      expect(reviewed?.removals).toEqual([]);
      expect(f.review).not.toHaveBeenCalled();
    },
  );
  it.each(['missing', 'malformed', 'failure'] as const)(
    'withholds removal on %s live review and keeps other editors usable',
    async (mode) => {
      const f = fixture();
      if (mode === 'failure') f.review.mockRejectedValueOnce(Error('read failed'));
      else f.review.mockResolvedValueOnce(mode === 'missing' ? null : { revision: 'invalid' });
      const reviewed = await bindSelectedFamilyRemoval(f);
      expect(reviewed?.removals).toEqual([]);
      expect(reviewed?.session).toBe(f.editor.session);
    },
  );
});
