import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { memoryMapReturnTo, memoryPersonEditorHref } from '@/lib/memory-editor-context';
import {
  OwnerEditorContextTrigger,
  OwnerEditorContextualHost,
  type OwnerEditorControlsProps,
} from './owner-editor-controls';

import { RelationshipList } from './relationship-list';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const contact = '22222222-2222-4222-8222-222222222222';
const other = '44444444-4444-4444-8444-444444444444';
const relation = '55555555-5555-4555-8555-555555555555';
const grant = {
  operationId: '11111111-1111-4111-8111-111111111111',
  issuedOperationHandle: 'private-issued-handle',
};
const editor: OwnerEditorControlsProps = {
  session: {
    ownerId: '33333333-3333-4333-8333-333333333333',
    formSessionScope: 'owner-session-fixture',
  },
  createGrant: null,
  identity: {
    contactId: contact,
    name: 'Sam',
    aliases: ['Sam, Jr.'],
    revision: 'a'.repeat(64),
    grant: { ...grant, command: 'update_person_identity' },
  },
  family: {
    anchorContactId: contact,
    people: [
      { contactId: contact, name: 'Sam', revision: 'a'.repeat(64) },
      { contactId: other, name: 'Alex', revision: 'b'.repeat(64) },
    ],
    expectedCanonicalState: { kind: 'absent' },
    grant: { ...grant, command: 'add_family_relationship' },
  },
  corrections: [
    {
      grant: { ...grant, command: 'correct_owner_family_relationship' },
      eligibility: {
        relationId: relation,
        revision: 'c'.repeat(64),
        sourceText: 'Exact owner statement',
        original: {
          subjectContactId: contact,
          objectContactId: other,
          expectedSubjectRevision: 'a'.repeat(64),
          expectedObjectRevision: 'b'.repeat(64),
          predicate: 'parent_of',
          timing: 'past',
          validity: { validFrom: null, validUntil: null },
          note: '',
          expectedCanonicalState: { kind: 'revision', revision: 'd'.repeat(64) },
        },
      },
    },
  ],
};
describe('one reviewed controller contextual entry points (SSR, not mounted focus proof)', () => {
  it('keeps recorded past meaning free of a contradictory clock duration and explains unsupported editing', () => {
    const row = {
      id: relation,
      sentence: 'Sam was Alex’s parent.',
      label: 'Parent',
      otherLabel: 'Alex',
      otherContactId: other,
      otherEntityId: 'entity-other',
      validFrom: '2020-01-01',
      validUntil: null,
      reviewStatus: 'confirmed' as const,
      assertionTiming: 'past' as const,
      sourceMemoryId: relation,
    };
    const recorded = renderToStaticMarkup(
      <RelationshipList
        relations={[row]}
        now={new Date('2026-10-25T00:00:00Z')}
        readOnlyReasons={{ [relation]: { reason: 'shared_evidence', sourceMemoryId: relation } }}
      />,
    );
    expect(recorded).toContain('Sam was Alex');
    expect(recorded).not.toContain('6 years');
    expect(recorded).toContain('shared or multiple evidence');
    expect(recorded).toContain(`/profile/knowledge/notes/${relation}`);
    const { assertionTiming: _, ...legacy } = row;
    const fallback = renderToStaticMarkup(
      <RelationshipList relations={[legacy]} now={new Date('2026-10-25T00:00:00Z')} />,
    );
    expect(fallback).toContain('6 years');
  });
  it('shows only actual supplied identity/family/exact relation triggers and conservatively locks initial readiness', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorContextualHost editor={editor}>
        <h1>Sam</h1>
        <OwnerEditorContextTrigger entry="identity" />
        <RelationshipList
          now={new Date('2026-10-25T00:00:00Z')}
          relations={[
            {
              id: relation,
              sentence: 'Sam was Alex’s parent.',
              label: 'Parent',
              otherLabel: 'Alex',
              otherContactId: other,
              otherEntityId: 'entity-other',
              validFrom: null,
              validUntil: null,
              reviewStatus: 'confirmed',
            },
          ]}
          editControls={{
            [relation]: <OwnerEditorContextTrigger entry={{ correction: relation }} />,
          }}
        />
        <OwnerEditorContextTrigger entry={{ correction: 'different' }} />
        <OwnerEditorContextTrigger entry="family" />
        <OwnerEditorContextTrigger entry="remove-person" />
        <OwnerEditorContextTrigger entry={{ removal: relation }} />
      </OwnerEditorContextualHost>,
    );
    expect(html.match(/Edit details/g)).toHaveLength(1);
    expect(html.match(/Edit relationship/g)).toHaveLength(1);
    expect(html.match(/Add family relationship/g)).toHaveLength(1);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html.indexOf('Sam was Alex')).toBeLessThan(html.indexOf('Edit relationship'));
    expect(html).not.toContain('Exact owner statement');
    expect(html).not.toContain('private-issued-handle');
    expect(html).not.toContain('Correct this owner-authored');
  });
  it('keeps browse content and hides all mutation affordances when no server capability is issued', () => {
    const html = renderToStaticMarkup(
      <OwnerEditorContextualHost editor={null}>
        <p>Read saved facts</p>
        <OwnerEditorContextTrigger entry="create" />
        <OwnerEditorContextTrigger entry="identity" />
        <OwnerEditorContextTrigger entry="family" />
      </OwnerEditorContextualHost>,
    );
    expect(html).toContain('Read saved facts');
    expect(html).not.toContain('<button');
  });
  it('offers contextual creation only when its own server grant is present', () => {
    const child = <OwnerEditorContextTrigger entry="create" />;
    const without = renderToStaticMarkup(
      <OwnerEditorContextualHost editor={editor}>{child}</OwnerEditorContextualHost>,
    );
    expect(without).not.toContain('Add person');
    const withCreate = renderToStaticMarkup(
      <OwnerEditorContextualHost
        editor={{ ...editor, createGrant: { ...grant, command: 'create_person' } }}
      >
        {child}
      </OwnerEditorContextualHost>,
    );
    expect(withCreate).toMatch(/<button[^>]*disabled=""[^>]*>Add person<\/button>/);
    expect(withCreate).not.toContain('private-issued-handle');
  });
  it('keeps removal unavailable even when backlog removal capabilities are supplied', () => {
    const eligibility = editor.corrections?.[0]?.eligibility;
    if (!eligibility) throw Error('Missing eligible relationship fixture');
    const children = (
      <>
        <OwnerEditorContextTrigger entry="remove-person" />
        <OwnerEditorContextTrigger entry={{ removal: relation }} />
        <OwnerEditorContextTrigger entry={{ removal: 'different' }} />
      </>
    );
    expect(
      renderToStaticMarkup(
        <OwnerEditorContextualHost editor={editor}>{children}</OwnerEditorContextualHost>,
      ),
    ).not.toContain('<button');
    const html = renderToStaticMarkup(
      <OwnerEditorContextualHost
        editor={{
          ...editor,
          personRemoval: {
            grant: { ...grant, command: 'remove_person' },
            impact: {
              contactId: contact,
              revision: 'a'.repeat(64),
              facts: 2,
              occasions: 0,
              connections: 1,
              retainedSourceNotes: 1,
              entityLinks: 1,
              sourceLinks: 0,
            },
          },
          removals: [
            {
              grant: { ...grant, command: 'remove_owner_family_relationship' },
              eligibility,
            },
          ],
        }}
      >
        {children}
      </OwnerEditorContextualHost>,
    );
    expect(html).not.toContain('Delete person');
    expect(html).not.toContain('Remove connection');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('private-issued-handle');
  });
  it('preserves exact selected map context and filters via contact-bound People destination', () => {
    const context =
      '/profile/knowledge?view=map&entity=selected&memory=source&q=Alex&kind=person&domain=family&state=active&page=2#knowledge-item';
    const href = memoryPersonEditorHref(contact, context);
    expect(href).not.toBeNull();
    const parsed = new URL(href ?? '', 'https://internal.invalid');
    expect(parsed.pathname).toBe(`/people/${contact}`);
    expect(memoryMapReturnTo(parsed.searchParams.get('returnTo'))).toBe(context);
    for (const bad of [
      'https://evil.invalid/profile/knowledge?view=map',
      '//evil.invalid',
      '/settings?view=map',
      '/profile/knowledge?view=library',
    ])
      expect(memoryMapReturnTo(bad)).toBeNull();
    expect(memoryPersonEditorHref(null, context)).toBeNull();
    expect(memoryPersonEditorHref('graph-id-only', context)).toBeNull();
  });
});
