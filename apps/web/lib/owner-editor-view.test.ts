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
const displayedContact = { id: contactId, name: 'Sam', aliases: ['Samuel'], trust: 'unknown' };
const identitySnapshot = {
  contactId,
  name: 'Sam',
  aliases: ['Samuel'],
  trust: 'unknown',
  revision,
};
const snapshot: OwnerEditorViewSnapshot = {
  ownerId,
  identity: { contactId, name: 'Sam', aliases: ['Samuel'], trust: 'unknown', revision },
  people: [
    { contactId, name: 'Sam', revision },
    { contactId: otherId, name: 'Alex', revision },
  ],
  corrections: [],
};
const input = { enabled: true, context, snapshot, formSessionScope, secret, displayedContact, now };
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
      revision,
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
    { ...displayedContact, id: otherId },
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
