import { describe, expect, it } from 'vitest';
import { verifyOwnerEditorHandle } from './owner-editor-scope';
import { buildOwnerEditorView, type OwnerEditorViewSnapshot } from './owner-editor-view';

const ownerId = '11111111-1111-4111-8111-111111111111';
const contactId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const revision = 'a'.repeat(64);
const now = Date.parse('2026-10-25T12:00:00Z');
const secret = 'offline-view-fixture-secret';
const formSessionScope = 'offline_view_form_session';
const context = {
  ownerId,
  epoch: '44444444-4444-4444-8444-444444444444',
  privacyGeneration: 'fixture-generation',
};
const displayedContact = {
  id: contactId,
  name: 'Sam',
  aliases: ['Samuel'],
  trust: 'unknown',
  relationship: 'sister',
  identityRevision: revision,
};
const identitySnapshot = {
  contactId,
  name: 'Sam',
  aliases: ['Samuel'],
  trust: 'unknown',
  relationship: 'sister',
  revision,
};
const snapshot: OwnerEditorViewSnapshot = {
  ownerId,
  identity: {
    contactId,
    name: 'Sam',
    aliases: ['Samuel'],
    trust: 'unknown',
    relationship: 'sister',
    revision,
  },
  people: [
    { contactId, name: 'Sam', revision },
    { contactId: otherId, name: 'Alex', revision },
  ],
  corrections: [
    {
      relationId: '55555555-5555-4555-8555-555555555555',
      revision: 'c'.repeat(64),
      original: {
        subjectContactId: contactId,
        objectContactId: otherId,
        expectedSubjectRevision: revision,
        expectedObjectRevision: revision,
        predicate: 'parent_of',
        timing: 'present',
        validity: { validFrom: null, validUntil: null },
        note: '',
        expectedCanonicalState: { kind: 'absent' },
      },
      sourceText: "Sam is Alex's parent.",
    },
  ],
};
const input = {
  enabled: true,
  removalEnabled: true,
  context,
  snapshot,
  formSessionScope,
  secret,
  displayedContact,
  now,
};
const personRemoval = {
  contactId,
  revision,
  facts: 2,
  occasions: 1,
  connections: 3,
  retainedSourceNotes: 4,
  entityLinks: 1,
  sourceLinks: 2,
};
it('issues person removal only from a canonical impact matching the displayed identity', () => {
  const suppliedImpact = { ...snapshot, personRemoval };
  const view = buildOwnerEditorView({ ...input, snapshot: suppliedImpact });
  expect(view).not.toBeNull();
  expect(view?.createGrant?.command).toBe('create_person');
  expect(view?.identity?.grant.command).toBe('update_person_identity');
  expect(view?.family?.grant.command).toBe('add_family_relationship');
  expect(view?.personRemoval).toMatchObject({
    grant: { command: 'remove_person', operationId: expect.any(String) },
    impact: personRemoval,
  });
  expect(view?.removals).toMatchObject([
    {
      grant: { command: 'remove_owner_family_relationship' },
      eligibility: snapshot.corrections?.[0],
    },
  ]);
  expect(view?.personRemovalUnavailableReason).toBeUndefined();
  const removePersonGrant = verifyOwnerEditorHandle({
    token: view?.personRemoval?.grant.issuedOperationHandle ?? '',
    session: { ownerId, formSessionScope },
    secret,
    now,
  });
  expect(removePersonGrant).toMatchObject({
    kind: 'verified',
    scope: { command: 'remove_person', targetId: contactId },
  });
  const removeRelationGrant = verifyOwnerEditorHandle({
    token: view?.removals?.[0]?.grant.issuedOperationHandle ?? '',
    session: { ownerId, formSessionScope },
    secret,
    now,
  });
  expect(removeRelationGrant).toMatchObject({
    kind: 'verified',
    scope: {
      command: 'remove_owner_family_relationship',
      targetId: snapshot.corrections?.[0]?.relationId,
    },
  });
});

it('keeps removal unavailable when canonical impact is absent or mismatched', () => {
  const view = buildOwnerEditorView(input);
  expect(view?.personRemoval).toBeUndefined();
  expect(view?.personRemovalUnavailableReason).toContain('current impact could not be verified');
  const mismatched = buildOwnerEditorView({
    ...input,
    snapshot: { ...snapshot, personRemoval: { ...personRemoval, contactId: otherId } },
  });
  expect(mismatched?.personRemoval).toBeUndefined();
  expect(mismatched?.personRemovalUnavailableReason).toContain(
    'current impact could not be verified',
  );
  const invalidRevision = buildOwnerEditorView({
    ...input,
    snapshot: { ...snapshot, personRemoval: { ...personRemoval, revision: 'receipt-revision' } },
  });
  expect(invalidRevision?.personRemoval).toBeUndefined();
});

it('does not issue any removal grants without explicit driver capability', () => {
  const view = buildOwnerEditorView({
    ...input,
    removalEnabled: false,
    snapshot: { ...snapshot, personRemoval },
  });
  expect(view?.personRemoval).toBeUndefined();
  expect(view?.removals).toEqual([]);
  expect(view?.personRemovalUnavailableReason).toBeDefined();
});

it('does not issue family-removal grants without an eligible relation snapshot', () => {
  const noEligibility = buildOwnerEditorView({
    ...input,
    snapshot: { ...snapshot, corrections: [] },
  });
  expect(noEligibility?.removals).toEqual([]);
  expect(noEligibility?.corrections).toEqual([]);
});

it('fails closed when the canonical removal impact cannot be read', () => {
  const unreadableImpact = {
    ...snapshot,
    get personRemoval(): typeof personRemoval {
      throw new Error('unsupported impact read');
    },
  };
  expect(buildOwnerEditorView({ ...input, snapshot: unreadableImpact })).toBeNull();
});

describe('server editor view builds real grants only for the same displayed native snapshot', () => {
  it('directory creates only actual create-person scope; never needs private contact fields', () => {
    const props = buildOwnerEditorView({
      ...input,
      snapshot: { ownerId },
      displayedContact: undefined,
    });
    expect(props?.identity).toBeUndefined();
    expect(props?.family).toBeUndefined();
    const result = verifyOwnerEditorHandle({
      token: props?.createGrant?.issuedOperationHandle ?? '',
      session: { ownerId, formSessionScope },
      secret,
      now,
    });
    expect(result).toMatchObject({
      kind: 'verified',
      scope: { command: 'create_person', targetId: null },
    });
  });
  it('same-read identity/options keep trust unknown and carry actual native CAS, not receipt revision', () => {
    const props = buildOwnerEditorView(input);
    expect(props?.identity).toMatchObject({
      contactId,
      name: 'Sam',
      aliases: ['Samuel'],
      relationship: 'sister',
      revision,
    });
    expect(props?.personNoteCreate).toMatchObject({
      snapshot: { contactId, name: 'Sam', trust: 'unknown', revision },
      grant: { command: 'create_owner_memory' },
    });
    expect(props?.family).toMatchObject({
      anchorContactId: contactId,
      people: snapshot.people,
      expectedCanonicalState: { kind: 'absent' },
    });
    const result = verifyOwnerEditorHandle({
      token: props?.identity?.grant.issuedOperationHandle ?? '',
      session: { ownerId, formSessionScope },
      secret,
      now,
    });
    expect(result).toMatchObject({
      kind: 'verified',
      scope: { command: 'update_person_identity', targetId: contactId },
    });
    const noteGrant = verifyOwnerEditorHandle({
      token: props?.personNoteCreate?.grant.issuedOperationHandle ?? '',
      session: { ownerId, formSessionScope },
      secret,
      now,
    });
    expect(noteGrant).toMatchObject({
      kind: 'verified',
      scope: { command: 'create_owner_memory', targetId: contactId },
    });
    expect(props?.identity).not.toHaveProperty('trust'); // No client trust mutation field.
  });
  it.each([
    { enabled: false },
    { context: null },
    { secret: '' },
    { formSessionScope: undefined },
    { formSessionScope: 'legacy' },
    { snapshot: { ...snapshot, ownerId: otherId } },
  ])(
    'unavailable issuance returns null rather than inventing or activating an epoch (%j)',
    (override) => {
      expect(buildOwnerEditorView({ ...input, ...override })).toBeNull();
    },
  );
  it.each([
    { ...displayedContact, name: 'Old saved name' },
    { ...displayedContact, aliases: [] },
    { ...displayedContact, trust: 'known' },
    { ...displayedContact, relationship: 'friend' },
    { ...displayedContact, id: otherId },
    { ...displayedContact, identityRevision: 'b'.repeat(64) },
    { ...displayedContact, identityRevision: undefined },
    { ...displayedContact, identityRevision: 'not-a-native-revision' },
  ])(
    'a displayed/native read mismatch disables editor without manufacturing matching CAS (%j)',
    (displayed) => {
      expect(buildOwnerEditorView({ ...input, displayedContact: displayed })).toBeNull();
    },
  );
  it('missing anchor/native revision and owner-as-contact snapshots do not expose an editor', () => {
    expect(buildOwnerEditorView({ ...input, snapshot: { ...snapshot, people: [] } })).toBeNull();
    expect(
      buildOwnerEditorView({
        ...input,
        snapshot: {
          ...snapshot,
          identity: { ...identitySnapshot, revision: 'receipt-identity-is-not-native-CAS' },
        },
      }),
    ).toBeNull();
    expect(
      buildOwnerEditorView({
        ...input,
        displayedContact: { ...displayedContact, trust: 'owner' },
        snapshot: { ...snapshot, identity: { ...identitySnapshot, trust: 'owner' } },
      }),
    ).toBeNull();
  });
});
