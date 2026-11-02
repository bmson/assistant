import type { OwnerEditorApply } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { ownerEditorCanonicalApply } from './owner-editor-canonical.js';
import { ownerEditorRequestHash } from './owner-editor-hash.js';

// Captured using the unchanged canonicalizer at main95895c1, before the reader extension.
const vectors = [
  {
    request: {
      version: 1,
      intent: 'apply',
      operationId: '11111111-1111-4111-8111-111111111111',
      command: 'create_person',
      name: 'Alex',
      aliases: [],
    },
    canonical:
      'owner-editor-apply-v1\n{"aliases":[],"command":"create_person","intent":"apply","name":"Alex","operationId":"11111111-1111-4111-8111-111111111111","version":1}',
    hash: '09ac0e9d8b47ea5103c49c857ab5bb435bd4d355c30941979307da23654d8889',
  },
  {
    request: {
      version: 1,
      intent: 'apply',
      operationId: '11111111-1111-4111-8111-111111111111',
      command: 'update_person_identity',
      contactId: '22222222-2222-4222-8222-222222222222',
      expectedContactRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'Sam',
      aliases: ['S'],
    },
    canonical:
      'owner-editor-apply-v1\n{"aliases":["S"],"command":"update_person_identity","contactId":"22222222-2222-4222-8222-222222222222","expectedContactRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","intent":"apply","name":"Sam","operationId":"11111111-1111-4111-8111-111111111111","version":1}',
    hash: '197b52793d28728a57b8e33d3181c29248072e826a7a48af9773920455e56600',
  },
  {
    request: {
      version: 1,
      intent: 'apply',
      operationId: '11111111-1111-4111-8111-111111111111',
      command: 'add_family_relationship',
      subjectContactId: '22222222-2222-4222-8222-222222222222',
      objectContactId: '33333333-3333-4333-8333-333333333333',
      expectedSubjectRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expectedObjectRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      predicate: 'parent_of',
      timing: 'unspecified',
      validity: {
        validFrom: null,
        validUntil: null,
      },
      note: '',
      expectedCanonicalState: {
        kind: 'absent',
      },
    },
    canonical:
      'owner-editor-apply-v1\n{"command":"add_family_relationship","expectedCanonicalState":{"kind":"absent"},"expectedObjectRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","expectedSubjectRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","intent":"apply","note":"","objectContactId":"33333333-3333-4333-8333-333333333333","operationId":"11111111-1111-4111-8111-111111111111","predicate":"parent_of","subjectContactId":"22222222-2222-4222-8222-222222222222","timing":"unspecified","validity":{"validFrom":null,"validUntil":null},"version":1}',
    hash: 'd1dc53d866f3f16b76b7b2889b84126fa32df13f962e9c09617bc9be78a6b67a',
  },
  {
    request: {
      version: 1,
      intent: 'apply',
      operationId: '11111111-1111-4111-8111-111111111111',
      command: 'correct_owner_family_relationship',
      targetRelationId: '11111111-1111-4111-8111-111111111111',
      expectedTargetRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replacement: {
        subjectContactId: '22222222-2222-4222-8222-222222222222',
        objectContactId: '33333333-3333-4333-8333-333333333333',
        expectedSubjectRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expectedObjectRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        predicate: 'parent_of',
        timing: 'unspecified',
        validity: {
          validFrom: null,
          validUntil: null,
        },
        note: '',
        expectedCanonicalState: {
          kind: 'absent',
        },
      },
    },
    canonical:
      'owner-editor-apply-v1\n{"command":"correct_owner_family_relationship","expectedTargetRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","intent":"apply","operationId":"11111111-1111-4111-8111-111111111111","replacement":{"expectedCanonicalState":{"kind":"absent"},"expectedObjectRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","expectedSubjectRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","note":"","objectContactId":"33333333-3333-4333-8333-333333333333","predicate":"parent_of","subjectContactId":"22222222-2222-4222-8222-222222222222","timing":"unspecified","validity":{"validFrom":null,"validUntil":null}},"targetRelationId":"11111111-1111-4111-8111-111111111111","version":1}',
    hash: 'caa206e1c0d87d7895d1b073c0ac47a57da78fa342a09aeea94d4f75394cb6c9',
  },
  {
    request: {
      version: 1,
      intent: 'apply',
      operationId: '11111111-1111-4111-8111-111111111111',
      command: 'correct_owner_memory',
      memoryId: '22222222-2222-4222-8222-222222222222',
      expectedContentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expectedMemoryRevision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      content: 'A durable saved note',
    },
    canonical:
      'owner-editor-apply-v1\n{"command":"correct_owner_memory","content":"A durable saved note","expectedContentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedMemoryRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","intent":"apply","memoryId":"22222222-2222-4222-8222-222222222222","operationId":"11111111-1111-4111-8111-111111111111","version":1}',
    hash: '5ed7bdcf1ba90bdda71856704ae267436de22f92d7e5da162cd0aa10db500228',
  },
];

describe('existing five owner-editor request hash compatibility', () => {
  it.each(vectors)(
    'preserves $request.command canonical bytes and hash',
    ({ request, canonical, hash }) => {
      expect(ownerEditorCanonicalApply(request as OwnerEditorApply)).toBe(canonical);
      expect(ownerEditorRequestHash(request as OwnerEditorApply)).toBe(hash);
    },
  );
});
