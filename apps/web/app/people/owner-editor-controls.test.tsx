import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  OwnerEditorConflictReview,
  OwnerEditorControls,
  type OwnerEditorControlsProps,
  OwnerEditorDraftCache,
  OwnerEditorPeopleSelectors,
  OwnerEditorTimingHelp,
  ownerEditorAliasesFromText,
  ownerEditorAliasesToText,
  ownerEditorConflictIntent,
} from './owner-editor-controls';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const contact = '22222222-2222-4222-8222-222222222222';
const operation = '11111111-1111-4111-8111-111111111111';
const createGrant = {
  command: 'create_person' as const,
  operationId: operation,
  issuedOperationHandle: 'issued-test-handle',
};
const base: OwnerEditorControlsProps = {
  session: {
    ownerId: '33333333-3333-4333-8333-333333333333',
    formSessionScope: 'owner-session-fixture',
  },
  createGrant,
};
describe('actual owner editor controls server boundary (not mounted browser proof)', () => {
  it('exports create/identity/family controls only for supplied server snapshots and keeps initial saves locked', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorControls
        {...base}
        identity={{
          contactId: contact,
          name: 'Sam',
          aliases: [],
          revision: 'a'.repeat(64),
          grant: { ...createGrant, command: 'update_person_identity' },
        }}
        family={{
          anchorContactId: contact,
          people: [{ contactId: contact, name: 'Sam', revision: 'a'.repeat(64) }],
          expectedCanonicalState: { kind: 'absent' },
          grant: { ...createGrant, command: 'add_family_relationship' },
        }}
      />,
    );
    expect(html).toContain('Add person');
    expect(html).toContain('Edit name and aliases');
    expect(html).toContain('Add family relationship');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(3);
    expect(html).not.toContain('issued-test-handle'); // Not a hidden writable action/form ID.
    expect(html).not.toContain('updateContactRelationship');
  });
  it('does not invent a grant, implicit entity endpoint, or correction when server supplied none', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorControls session={base.session} createGrant={null} />,
    );
    expect(html).not.toContain('Add person');
    expect(html).not.toContain('Correct');
    expect(html).not.toContain('<form');
  });
});

describe('actual selector and memory-only draft lifecycle regressions', () => {
  const other = '44444444-4444-4444-8444-444444444444';
  it('locks only the explicit anchor and excludes the opposite endpoint after direction swap', () => {
    const people = [
      { contactId: contact, name: 'Sam', revision: 'a'.repeat(64) },
      { contactId: other, name: 'Alex', revision: 'b'.repeat(64) },
    ];
    for (const swapped of [false, true]) {
      const html = renderToStaticMarkup(
        <OwnerEditorPeopleSelectors
          idPrefix="pair"
          draft={{ subject: swapped ? other : contact, object: swapped ? contact : other }}
          people={people}
          anchorPosition={swapped ? 'object' : 'subject'}
          onChange={() => {}}
        />,
      );
      const selects = html.match(/<select[\s\S]*?<\/select>/g) ?? [];
      expect(selects.filter((s) => s.includes('disabled=""'))).toHaveLength(1);
      expect(selects[swapped ? 0 : 1]).not.toContain(`value="${contact}"`);
      expect(selects[swapped ? 0 : 1]).toContain('Choose an existing named person');
      expect(selects[swapped ? 0 : 1]).not.toContain('Sam · 22222222');
    }
  });
  it('uses names by default and only adds an ID prefix to disambiguate duplicate names', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorPeopleSelectors
        idPrefix="pair"
        draft={{ subject: '', object: '' }}
        people={[
          { contactId: contact, name: 'Sam', revision: 'a'.repeat(64) },
          { contactId: other, name: 'Sam', revision: 'b'.repeat(64) },
          {
            contactId: '55555555-5555-4555-8555-555555555555',
            name: 'Alex',
            revision: 'c'.repeat(64),
          },
        ]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('Sam · 22222222');
    expect(html).toContain('Sam · 44444444');
    expect(html).toContain('>Alex</option>');
    expect(html).not.toContain('Alex · 55555555');
  });
  it('shows latest ALL aliases separately from intended aliases before explicit review', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorConflictReview
        latestIdentity={{ name: 'New saved name', aliases: ['Old name', 'Another alias'] }}
        intendedIdentity={{ name: 'My intended name', aliases: 'My alias' }}
        relationships={[]}
        missing={false}
        canReview={true}
        onReview={() => {}}
      />,
    );
    for (const text of [
      'Latest',
      'Your draft',
      'New saved name',
      'Old name, Another alias',
      'My intended name',
      'My alias',
      'I reviewed the latest values — keep my draft for editing',
    ])
      expect(html).toContain(text);
    expect(html).toContain('aria-label="Review changed saved details"');
  });
  it('successful identity clears only completed draft; next open includes backend retained old-name alias', () => {
    const cache = new OwnerEditorDraftCache();
    cache.setIdentity({ name: 'Intended', aliases: 'Local' });
    const family = {
      subject: contact,
      object: other,
      predicate: 'parent_of',
      timing: 'past' as const,
      from: '',
      until: '',
      note: 'private intent',
    };
    cache.setFamily('family', family);
    cache.setFamily('correction:one', family);
    const reply = {
      version: 1 as const,
      authority: 'operation_receipt' as const,
      command: 'update_person_identity' as const,
      operationId: operation,
      requestHash: 'a'.repeat(64),
      statusVersion: 2,
      outcome: 'saved' as const,
      ids: { contactId: contact },
      revision: 'b'.repeat(64),
    };
    expect(cache.complete(reply, null)).toBe('update_person_identity');
    expect(cache.identity({ name: 'Saved', aliases: 'Local, Previous saved name' })).toEqual({
      name: 'Saved',
      aliases: 'Local, Previous saved name',
    });
    expect(cache.family('family')).toEqual(family);
    expect(cache.family('correction:one')).toEqual(family);
    cache.setIdentity({ name: 'New intent', aliases: 'Preserved' });
    cache.complete({ ...reply, outcome: 'conflict', reason: 'contact_changed' }, contact);
    expect(cache.identity({ name: 'Latest', aliases: 'Different' }).name).toBe('New intent');
    cache.complete({ ...reply, command: 'correct_owner_family_relationship' }, 'one');
    expect(cache.family('correction:one')).toBeUndefined();
    expect(cache.family('family')).toEqual(family);
  });
});

it('missing correction has no draft comparison and offers no review adoption', () => {
  const html = renderToStaticMarkup(
    <OwnerEditorConflictReview
      relationships={[]}
      missing={true}
      canReview={false}
      onReview={() => {
        throw Error('No target may be adopted');
      }}
    />,
  );
  expect(html).toContain('No draft is available to compare.');
  expect(html).toContain('This relationship is no longer editable here.');
  expect(html).toContain('No different relationship will be substituted.');
  expect(html).not.toContain('Your intended edit stays');
  expect(html).not.toContain('I reviewed the latest saved values');
  expect(html).not.toContain('<button');
});

it('actual caller intent helper distinguishes missing family draft from placeholder and live create intent', () => {
  const input = {
    command: 'add_family_relationship' as const,
    identityDraft: null,
    createDraft: null,
    familyDraft: null,
    familyPreview: 'Choose two named people and a relationship to preview the statement.',
  };
  const absent = ownerEditorConflictIntent(input);
  expect(absent.intendedFamily).toBeUndefined();
  const html = renderToStaticMarkup(
    <OwnerEditorConflictReview
      {...absent}
      relationships={[]}
      missing={false}
      canReview={true}
      onReview={() => {}}
    />,
  );
  expect(html).toContain('No draft is available to compare.');
  expect(html).toContain('start a new edit');
  expect(html).not.toContain('keep my draft');
  expect(html).not.toContain(input.familyPreview);
  const live = ownerEditorConflictIntent({
    ...input,
    command: 'create_person',
    createDraft: { name: 'Private intended name', aliases: 'Sam, Jr.' },
  });
  const liveHTML = renderToStaticMarkup(
    <OwnerEditorConflictReview
      {...live}
      relationships={[]}
      missing={false}
      canReview={true}
      onReview={() => {}}
    />,
  );
  expect(liveHTML).toContain('Private intended name');
  expect(liveHTML).toContain('Sam, Jr.');
  expect(liveHTML).toContain('keep my draft');
  expect(liveHTML).not.toContain('No draft is available');
});

it('renders timing help that matches the stored timing and separate date contract', () => {
  const html = renderToStaticMarkup(<OwnerEditorTimingHelp />);
  expect(html).toContain(
    'Choose how this relationship is described. This choice is separate from the dates below.',
  );
});
it('actual alias codec preserves commas on name-only edit and freshly reopened backend aliases', () => {
  const saved = ['Sam, Jr.', 'Another alias'];
  expect(ownerEditorAliasesFromText(ownerEditorAliasesToText(saved))).toEqual(saved);
  expect(ownerEditorAliasesFromText('Sam, Jr.\r\n Another alias \r\n')).toEqual(saved);
  const cache = new OwnerEditorDraftCache();
  cache.setIdentity({ name: 'Intended rename', aliases: ownerEditorAliasesToText(saved) });
  cache.complete(
    {
      version: 1,
      authority: 'operation_receipt',
      command: 'update_person_identity',
      operationId: operation,
      requestHash: 'a'.repeat(64),
      statusVersion: 2,
      outcome: 'saved',
      ids: { contactId: contact },
      revision: 'b'.repeat(64),
    },
    contact,
  );
  const fresh = cache.identity({
    name: 'Saved rename',
    aliases: ownerEditorAliasesToText([...saved, 'Previous, Name']),
  });
  expect(ownerEditorAliasesFromText(fresh.aliases)).toEqual([...saved, 'Previous, Name']);
});
