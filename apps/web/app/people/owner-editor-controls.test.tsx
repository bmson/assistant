import type { OwnerEditorReply } from '@assistant/persistence/owner-editor';
import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { OwnerEditorOperationState } from '@/lib/owner-editor-operation';
import {
  OwnerEditorCloseGuidance,
  OwnerEditorConflictReview,
  OwnerEditorControls,
  type OwnerEditorControlsProps,
  OwnerEditorDraftCache,
  OwnerEditorOptionalDetails,
  OwnerEditorPeopleSelectors,
  OwnerEditorRelationshipField,
  OwnerEditorRemovalActions,
  OwnerEditorRemovalSummary,
  OwnerEditorTimingHelp,
  ownerEditorAliasesFromText,
  ownerEditorAliasesToText,
  ownerEditorConflictIntent,
  ownerEditorIdentityRequestFields,
  selectCreatedFamilyPerson,
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

const readyOperationState: OwnerEditorOperationState = {
  phase: 'ready',
  reviewRequired: false,
  reviewTargetId: null,
  marker: null,
  busy: false,
  reply: null,
  fieldErrors: {},
  message: '',
};

describe('owner editor close guidance follows the active operation marker', () => {
  it('uses unsent draft wording for a ready form', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorCloseGuidance state={readyOperationState} grant={createGrant} targetId={null} />,
    );
    expect(html).toContain('Closing does not save this draft. Reloading may lose it.');
    expect(html).not.toContain('The result of this save is not confirmed.');
  });

  it('keeps draft wording when validation leaves the form editable', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorCloseGuidance
        state={{ ...readyOperationState, fieldErrors: { name: 'Enter a name.' } }}
        grant={createGrant}
        targetId={null}
      />,
    );
    expect(html).toContain('Closing does not save this draft. Reloading may lose it.');
    expect(html).not.toContain('The result of this save is not confirmed.');
  });

  it('leaves a conflict review to its existing operation status', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorCloseGuidance
        state={{ ...readyOperationState, phase: 'resolved', reviewRequired: true }}
        grant={createGrant}
        targetId={null}
      />,
    );
    expect(html).toBe('');
  });

  it('uses uncertainty wording only for a pending marker scoped to this form', () => {
    const marker = {
      id: createGrant.issuedOperationHandle,
      command: 'create_person' as const,
      targetId: null,
    };
    const pendingState: OwnerEditorOperationState = {
      ...readyOperationState,
      phase: 'pending',
      marker,
      message: 'The result is unknown. Check the same save before trying again.',
    };
    const html = renderToStaticMarkup(
      <OwnerEditorCloseGuidance state={pendingState} grant={createGrant} targetId={null} />,
    );
    expect(pendingState.reply).toBeNull(); // A persisted marker alone does not prove dispatch.
    expect(html).toContain(
      'The result of this save is not confirmed. Reopen this page to check the same save before trying again.',
    );

    const matchingReply: OwnerEditorReply = {
      version: 1,
      authority: 'unresolved',
      command: 'create_person',
      operationId: createGrant.operationId,
      outcome: 'outcome_unknown',
      reason: 'receipt_unavailable',
    };
    const matchingReplyState = { ...pendingState, reply: matchingReply };
    const matchingReplyHtml = renderToStaticMarkup(
      <OwnerEditorCloseGuidance state={matchingReplyState} grant={createGrant} targetId={null} />,
    );
    expect(matchingReplyHtml).toContain('The result of this save is not confirmed.');

    const mismatchingReplyState = {
      ...pendingState,
      reply: { ...matchingReply, operationId: '99999999-9999-4999-8999-999999999999' },
    };
    const mismatchingReplyHtml = renderToStaticMarkup(
      <OwnerEditorCloseGuidance
        state={mismatchingReplyState}
        grant={createGrant}
        targetId={null}
      />,
    );
    expect(mismatchingReplyHtml).toContain(
      'Closing does not save this draft. Reloading may lose it.',
    );
    expect(mismatchingReplyHtml).not.toContain('The result of this save is not confirmed.');
    expect(mismatchingReplyState.message).toBe(pendingState.message);

    const otherFormMarkers = [
      { ...marker, id: 'another-issued-handle' },
      { ...marker, command: 'update_person_identity' as const },
      { ...marker, targetId: contact },
    ];
    for (const marker of otherFormMarkers) {
      const otherForm = renderToStaticMarkup(
        <OwnerEditorCloseGuidance
          state={{ ...pendingState, marker }}
          grant={createGrant}
          targetId={null}
        />,
      );
      expect(otherForm).toContain('Closing does not save this draft. Reloading may lose it.');
      expect(otherForm).not.toContain('The result of this save is not confirmed.');
    }

    const withoutGrant = renderToStaticMarkup(
      <OwnerEditorCloseGuidance state={pendingState} grant={null} targetId={null} />,
    );
    expect(withoutGrant).toContain('Closing does not save this draft. Reloading may lose it.');

    const withoutTarget = renderToStaticMarkup(
      <OwnerEditorCloseGuidance state={pendingState} grant={createGrant} targetId={undefined} />,
    );
    expect(withoutTarget).toContain('Closing does not save this draft. Reloading may lose it.');
  });

  it.each(['checking', 'resolved', 'blocked'] as const)(
    'leaves %s status wording to the operation status',
    (phase) => {
      const html = renderToStaticMarkup(
        <OwnerEditorCloseGuidance
          state={{ ...readyOperationState, phase }}
          grant={createGrant}
          targetId={null}
        />,
      );
      expect(html).toBe('');
    },
  );
});

function actualSelectorNodes(node: ReactNode): ReactElement<ComponentProps<'select'>>[] {
  const selects: ReactElement<ComponentProps<'select'>>[] = [];
  const visit = (children: ReactNode) => {
    Children.forEach(children, (child) => {
      if (!isValidElement<{ children?: ReactNode }>(child)) return;
      if (child.type === 'select') selects.push(child as ReactElement<ComponentProps<'select'>>);
      else visit(child.props.children);
    });
  };
  visit(node);
  return selects;
}

function actualSelectorOptions(select: ReactElement<ComponentProps<'select'>>) {
  return Children.toArray(select.props.children)
    .filter(
      (child): child is ReactElement<ComponentProps<'option'>> =>
        isValidElement<ComponentProps<'option'>>(child) && child.type === 'option',
    )
    .map((option) => ({ value: option.props.value, label: option.props.children }));
}
describe('removal dialog actions distinguish close from cancellation', () => {
  const noop = () => {};
  it('offers Cancel and one destructive submit only before dispatch', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorRemovalActions
        phase="ready"
        busy={false}
        finished={false}
        hasGrant={true}
        person={false}
        onClose={noop}
        onSubmit={noop}
        onCheck={noop}
      />,
    );
    expect(html).toContain('>Cancel</button>');
    expect(html).toContain('>Remove connection</button>');
    expect(html).not.toContain('>Close</button>');
  });
  it.each(['pending', 'resolved', 'blocked', 'checking'] as const)(
    'uses Close without destructive repeat for %s',
    (phase) => {
      const html = renderToStaticMarkup(
        <OwnerEditorRemovalActions
          phase={phase}
          busy={false}
          finished={false}
          hasGrant={true}
          person={true}
          onClose={noop}
          onSubmit={noop}
          onCheck={noop}
        />,
      );
      expect(html).toContain('>Close</button>');
      expect(html).not.toContain('Cancel');
      expect(html).not.toContain('Delete person');
      expect(html).not.toContain('type="submit"');
      if (phase === 'pending') {
        expect(html).toContain('>Check result</button>');
        expect(html).toContain('bg-accent');
      } else expect(html).not.toContain('Check result');
    },
  );
  it('keeps Close after a completed removal even when fresh grants become ready', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorRemovalActions
        phase="ready"
        busy={false}
        finished={true}
        hasGrant={true}
        person={true}
        onClose={noop}
        onSubmit={noop}
        onCheck={noop}
      />,
    );
    expect(html).toContain('>Close</button>');
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('type="submit"');
  });
});
it('distinguishes the exact person deletion impact from removing one retained-source connection', () => {
  const impact = {
    contactId: contact,
    revision: 'a'.repeat(64),
    facts: 2,
    occasions: 3,
    connections: 4,
    retainedSourceNotes: 5,
    entityLinks: 1,
    sourceLinks: 1,
  };
  const person = renderToStaticMarkup(<OwnerEditorRemovalSummary name="Sam" impact={impact} />);
  expect(person).toContain('2 saved facts');
  expect(person).toContain('3 saved dates');
  expect(person).toContain('4 recorded connections are affected.');
  expect(person).toContain('supported only by deleted facts disappear');
  expect(person).toContain(
    'supported by retained notes stay saved with their profile links cleared',
  );
  expect(person).toContain('5 affected source notes stay saved');
  const connection = renderToStaticMarkup(
    <OwnerEditorRemovalSummary sentence="Sam is Alex’s parent." />,
  );
  expect(connection).toContain('Sam is Alex');
  expect(connection).toContain('This marks this recorded connection as rejected.');
  expect(connection).toContain('Both people and the saved source note stay saved');
  expect(connection).toContain('Other supported connections may remain.');
  expect(connection).toContain('This does not record that the relationship ended.');
  expect(connection).not.toContain('saved person details');
});
describe('actual owner editor controls server boundary (not mounted browser proof)', () => {
  it('exports create/identity/family controls only for supplied server snapshots and keeps initial saves locked', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorControls
        {...base}
        identity={{
          contactId: contact,
          name: 'Sam',
          aliases: [],
          relationship: 'sister',
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
    expect(html).toContain('Edit details');
    expect(html).toContain('Add connection');
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

describe('owner relationship label control', () => {
  it('renders the owner-facing relationship field as a bounded text value with validation feedback', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorRelationshipField
        fieldId="person-relationship"
        value="daughter"
        error="Use 80 characters or fewer."
        onChange={() => {}}
      />,
    );
    expect(html).toContain('for="person-relationship"');
    expect(html).toContain('Relationship to you');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('value="daughter"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('Use 80 characters or fewer.');
  });
  it('includes the relationship with the existing identity mutation fields', () => {
    expect(ownerEditorIdentityRequestFields('Sam Rivera', 'Sam, Jr.\nSamuel', 'daughter')).toEqual({
      name: 'Sam Rivera',
      aliases: ['Sam, Jr.', 'Samuel'],
      relationship: 'daughter',
    });
  });
});

describe('actual selector and memory-only draft lifecycle regressions', () => {
  const other = '44444444-4444-4444-8444-444444444444';
  it('returns a newly created person to the free endpoint without replacing the page anchor', () => {
    const created = '55555555-5555-4555-8555-555555555555';
    for (const swapped of [false, true]) {
      const draft = {
        subject: swapped ? '' : contact,
        object: swapped ? contact : '',
        predicate: 'parent_of',
        note: 'Keep my draft',
      };
      const selected = selectCreatedFamilyPerson(draft, contact, created);
      expect(selected.subject).toBe(swapped ? created : contact);
      expect(selected.object).toBe(swapped ? contact : created);
      expect(selected.predicate).toBe('parent_of');
      expect(selected.note).toBe('Keep my draft');
    }
  });
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
  it.each([false, true])(
    'keeps the renamed anchor selected and changes only the editable family endpoint (swapped=%s; real tree/handler, not mounted DOM)',
    (swapped) => {
      const people = [
        { contactId: contact, name: 'Alex Rivera Updated', revision: 'c'.repeat(64) },
        { contactId: other, name: 'Robin Rivera', revision: 'b'.repeat(64) },
      ];
      let draft = {
        subject: swapped ? '' : contact,
        object: swapped ? contact : '',
        predicate: 'sibling_of',
      };
      const changed = vi.fn((endpoint: 'subject' | 'object', contactId: string) => {
        draft = { ...draft, [endpoint]: contactId };
      });
      // Exercise the exported real control and its handler with controlled props.
      // There is no fake DOM, mounted dialog, browser actionability or hydration claim.
      const renderSelectors = () =>
        actualSelectorNodes(
          OwnerEditorPeopleSelectors({
            idPrefix: 'fresh-family',
            draft,
            people,
            anchorPosition: swapped ? 'object' : 'subject',
            onChange: changed,
          }),
        );
      const before = renderSelectors();
      const anchor = before[swapped ? 1 : 0];
      const editable = before[swapped ? 0 : 1];
      if (!anchor || !editable) throw Error('Expected the real pair of person selects');
      expect(anchor.props.id).toBe(`fresh-family-${swapped ? 'object' : 'subject'}`);
      expect(anchor.props.disabled).toBe(true);
      expect(anchor.props.value).toBe(contact);
      expect(actualSelectorOptions(anchor)).toContainEqual({
        value: contact,
        label: 'Alex Rivera Updated',
      });
      expect(editable.props.disabled).toBe(false);
      expect(editable.props.value).toBe('');
      expect(actualSelectorOptions(editable)).toEqual([
        { value: '', label: 'Choose an existing named person' },
        { value: other, label: 'Robin Rivera' },
      ]);

      // The disabled anchor is asserted, never driven through its handler.
      editable.props.onChange?.({
        target: { value: other },
      } as Parameters<NonNullable<ComponentProps<'select'>['onChange']>>[0]);

      expect(changed).toHaveBeenCalledExactlyOnceWith(swapped ? 'subject' : 'object', other);
      expect(draft).toEqual({
        subject: swapped ? other : contact,
        object: swapped ? contact : other,
        predicate: 'sibling_of',
      });
      expect(draft.subject).not.toBe(draft.object);
      const after = renderSelectors();
      expect(after[swapped ? 1 : 0]?.props).toMatchObject({ disabled: true, value: contact });
      expect(after[swapped ? 0 : 1]?.props).toMatchObject({ disabled: false, value: other });
    },
  );
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
        latestIdentity={{
          name: 'New saved name',
          aliases: ['Old name', 'Another alias'],
          relationship: 'sister',
        }}
        intendedIdentity={{ name: 'My intended name', aliases: 'My alias', relationship: 'friend' }}
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
      'Relationship to you: sister',
      'My intended name',
      'My alias',
      'Relationship to you: friend',
      'I reviewed the latest values — keep my draft for editing',
    ])
      expect(html).toContain(text);
    expect(html).toContain('aria-label="Review changed saved details"');
  });
  it('successful identity clears only completed draft; next open includes backend retained old-name alias', () => {
    const cache = new OwnerEditorDraftCache();
    cache.setIdentity({ name: 'Intended', aliases: 'Local', relationship: 'friend' });
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
    expect(
      cache.identity({
        name: 'Saved',
        aliases: 'Local, Previous saved name',
        relationship: 'sister',
      }),
    ).toEqual({
      name: 'Saved',
      aliases: 'Local, Previous saved name',
      relationship: 'sister',
    });
    expect(cache.family('family')).toEqual(family);
    expect(cache.family('correction:one')).toEqual(family);
    cache.setIdentity({ name: 'New intent', aliases: 'Preserved', relationship: 'friend' });
    cache.complete({ ...reply, outcome: 'conflict', reason: 'contact_changed' }, contact);
    expect(
      cache.identity({ name: 'Latest', aliases: 'Different', relationship: 'colleague' }).name,
    ).toBe('New intent');
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
    createDraft: { name: 'Private intended name', aliases: 'Sam, Jr.', relationship: '' },
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
  cache.setIdentity({
    name: 'Intended rename',
    aliases: ownerEditorAliasesToText(saved),
    relationship: 'friend',
  });
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
    relationship: 'sister',
  });
  expect(ownerEditorAliasesFromText(fresh.aliases)).toEqual([...saved, 'Previous, Name']);
});

it('describes rejecting a recorded claim without implying an end date or a visual-only hide', () => {
  // Source audit: bounded PG and Firestore removal adapters mark the selected
  // assertion+relation rejected; neither writes validity or removes source/people.
  // This actual component assertion checks that UI meaning, not adapter execution.
  const html = renderToStaticMarkup(<OwnerEditorRemovalSummary sentence="Sam is Alex’s parent." />);
  expect(html).not.toContain('from the connections view');
  expect(html).not.toMatch(
    /merely hidden|only hidden|ends this relationship|no longer true|end date/i,
  );
  expect(html).toContain('rejected');
  expect(html).toContain('does not record that the relationship ended');
});

it('keeps optional context collapsed but exposes invalid fields for correction', () => {
  const field = (
    <label>
      From
      <input type="date" defaultValue="2026-01-01" />
    </label>
  );
  const collapsed = renderToStaticMarkup(
    <OwnerEditorOptionalDetails summary="Dates and context (optional)">
      {field}
    </OwnerEditorOptionalDetails>,
  );
  expect(collapsed).not.toContain('open=""');
  expect(collapsed).toContain('<summary');
  expect(collapsed).toContain('2026-01-01');
  const invalid = renderToStaticMarkup(
    <OwnerEditorOptionalDetails summary="Dates and context (optional)" hasErrors>
      {field}
      <p role="alert">Check the date.</p>
    </OwnerEditorOptionalDetails>,
  );
  expect(invalid).toContain('open=""');
  expect(invalid).toContain('Check the date.');
});
