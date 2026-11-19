import type { PersonConnection, PersonRelation } from '@assistant/application/people';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionList, RelationshipList } from '@/app/people/relationship-list';

vi.mock('@/app/profile/knowledge/actions', () => ({ removeKnowledgeConnection: vi.fn() }));

const NOW = new Date('2026-09-02T12:00:00.000Z');

function relation(overrides: Partial<PersonRelation> = {}): PersonRelation {
  return {
    id: 'rel-1',
    sentence: 'Élise Aubert and Marc Vidal are partners.',
    label: 'Partner',
    otherLabel: 'Marc Vidal',
    otherContactId: '22222222-2222-4222-8222-222222222222',
    otherEntityId: 'entity-marc',
    validFrom: '2016-03',
    validUntil: null,
    reviewStatus: 'confirmed',
    ...overrides,
  };
}

describe('RelationshipList', () => {
  it('preserves each parallel claim and safe map return when opening the other profile', () => {
    const ids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
    const returnTo = '/profile/knowledge?view=map&entity=alex#knowledge-item';
    const html = renderToStaticMarkup(
      <RelationshipList
        relations={ids.map((id) => relation({ id }))}
        now={NOW}
        peopleQuery="Marc & Élise"
        returnTo={returnTo}
        selectedRelationId={ids[0]}
      />,
    );
    for (const id of ids) {
      expect(html).toContain(`connectionId=${id}#person-connection-${id}`);
    }
    expect(html).toContain(`returnTo=${encodeURIComponent(returnTo)}`);
    expect(html).toContain('q=Marc%20%26%20%C3%89lise');
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
  });

  it('drops an untrusted return URL while preserving the exact claim', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const html = renderToStaticMarkup(
      <RelationshipList relations={[relation({ id })]} now={NOW} returnTo="//evil.invalid/" />,
    );
    expect(html).toContain(`connectionId=${id}#person-connection-${id}`);
    expect(html).not.toContain('returnTo=');
    expect(html).not.toContain('evil.invalid');
  });

  it('renders the composed sentence rather than rebuilding one', () => {
    // The presenter owns the grammar — symmetric predicates read "A and B are
    // partners", not "A is B's partner".
    const html = renderToStaticMarkup(<RelationshipList relations={[relation()]} now={NOW} />);
    expect(html).toContain('Élise Aubert and Marc Vidal are partners.');
  });

  it('shows a duration when the source fixes the start to a month or better', () => {
    const html = renderToStaticMarkup(<RelationshipList relations={[relation()]} now={NOW} />);
    expect(html).toContain('10 years');
  });

  it('shows a bare year as "Since", never as a computed duration', () => {
    const html = renderToStaticMarkup(
      <RelationshipList
        relations={[
          relation({ id: 'rel-2', sentence: "Élise is Léa's parent.", validFrom: '2019' }),
        ]}
        now={NOW}
      />,
    );
    expect(html).toContain('Since 2019');
    expect(html).not.toContain('7 years');
  });

  it('renders no span at all when the source states none', () => {
    const html = renderToStaticMarkup(
      <RelationshipList relations={[relation({ validFrom: null })]} now={NOW} />,
    );
    expect(html).toContain('are partners');
    expect(html).not.toContain('years');
  });

  it('links a relationship whose other end is a contact', () => {
    const html = renderToStaticMarkup(<RelationshipList relations={[relation()]} now={NOW} />);
    expect(html).toContain('href="/people/22222222-2222-4222-8222-222222222222"');
  });

  it('does not link a person who exists only inside a fact', () => {
    const html = renderToStaticMarkup(
      <RelationshipList relations={[relation({ otherContactId: null })]} now={NOW} />,
    );
    expect(html).not.toContain('href="/people/');
    expect(html).toContain('are partners');
  });

  it('marks an edge the owner has not confirmed', () => {
    const html = renderToStaticMarkup(
      <RelationshipList relations={[relation({ reviewStatus: 'unreviewed' })]} now={NOW} />,
    );
    expect(html).toContain('Unreviewed');
  });

  it('does not mark a confirmed edge', () => {
    const html = renderToStaticMarkup(<RelationshipList relations={[relation()]} now={NOW} />);
    expect(html).not.toContain('Unreviewed');
  });

  it('highlights only the selected loaded relationship, keeping parallel claims separate', () => {
    const html = renderToStaticMarkup(
      <RelationshipList
        relations={[
          relation({ id: 'rel-1' }),
          relation({ id: 'rel-2', sentence: 'A second source also says they are partners.' }),
        ]}
        selectedRelationId="rel-2"
        now={NOW}
      />,
    );
    expect(html).toContain('id="person-connection-rel-1"');
    expect(html).toContain('id="person-connection-rel-2"');
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="location" class="scroll-mt-24 rounded-xl');
  });

  it('renders nothing but an empty list when there are no relations', () => {
    const html = renderToStaticMarkup(<RelationshipList relations={[]} now={NOW} />);
    expect(html).toBe('<ul class="mt-3 flex flex-col gap-2"></ul>');
  });
});

describe('ConnectionList', () => {
  function connection(overrides: Partial<PersonConnection> = {}): PersonConnection {
    return {
      id: 'con-1',
      sentence: 'Tomás Ferreira worked at Praça Studio.',
      label: 'Worked at',
      otherLabel: 'Praça Studio',
      otherKind: 'organization',
      validFrom: '2015',
      validUntil: '2022',
      ...overrides,
    };
  }

  it('shows a closed span for something that has ended', () => {
    const html = renderToStaticMarkup(<ConnectionList connections={[connection()]} now={NOW} />);
    expect(html).toContain('2015–2022');
  });

  it('carries no avatar, since the other end is not a person', () => {
    const html = renderToStaticMarkup(<ConnectionList connections={[connection()]} now={NOW} />);
    expect(html).toContain('worked at Praça Studio');
    expect(html).not.toContain('rounded-full');
  });

  it('selects a non-person connection with a stable anchor, exact statement, read-only reason, and source link', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const sourceMemoryId = '88888888-8888-4888-8888-888888888888';
    const html = renderToStaticMarkup(
      <ConnectionList
        connections={[connection({ id, sourceMemoryId })]}
        selectedConnectionId={id}
        now={NOW}
      />,
    );
    expect(html).toContain(`id="person-connection-${id}"`);
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('Tomás Ferreira worked at Praça Studio.');
    expect(html).toContain('not a relationship between people');
    expect(html).toContain('cannot be edited or removed as a family relationship');
    expect(html).toContain(`/profile/knowledge/notes/${sourceMemoryId}`);
    expect(html).not.toContain('Edit family');
    expect(html).not.toContain('Remove connection');
  });

  it('states when no exact source note link is available for the selected connection', () => {
    const html = renderToStaticMarkup(
      <ConnectionList connections={[connection()]} selectedConnectionId="con-1" now={NOW} />,
    );
    expect(html).toContain('A source note link is not available for this connection.');
    expect(html).not.toContain('/profile/knowledge/notes/');
  });
});
