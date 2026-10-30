import { describe, expect, it } from 'vitest';
import {
  buildPublicActivityQuery,
  type PublicActivityScopeData,
  parsePublicActivityScope,
  publicActivityFollowupDisposition,
  publicActivityScopeHash,
  resolveActiveReadIntent,
  type VerifiedOwnerReadTurn,
} from './active-read-intent.js';

const now = new Date('2026-10-24T06:30:00Z');
function turn(text: string, index: number): VerifiedOwnerReadTurn {
  return {
    id: `m${index}`,
    agentId: 'a',
    conversationId: 'c',
    taskId: `t${index}`,
    role: 'user',
    origin: 'owner',
    text,
    ownerAuthoredText: text,
    requestAt: now,
  };
}
function resolve(
  text: string,
  history: VerifiedOwnerReadTurn[] = [],
  previousPublic?: PublicActivityScopeData,
) {
  const current = turn(text, history.length + 1);
  if (!current.taskId) throw new Error('Missing fixture task');
  return resolveActiveReadIntent({
    text,
    now,
    timeZone: 'America/Los_Angeles',
    ownerTurns: [...history, current],
    previousPublic,
    provenance: {
      agentId: 'a',
      conversationId: 'c',
      taskId: current.taskId,
      triggerMessageId: current.id,
      requestHash: 'verified-admission-hash',
    },
  });
}
describe('active read source resolution', () => {
  it('keeps sanitized five-turn public intent and latest weekend across terse corrections', () => {
    const texts = [
      'Is there anything happening in San Francisco today?',
      'I mean city events I could attend; my weekend is empty.',
      // Sanitized owner-turn paraphrase, not an exact screenshot transcript.
      'Public events, not my calendar or inbox.',
      'Search for events for me.',
      'Find public events in San Francisco this weekend.',
    ];
    const history: VerifiedOwnerReadTurn[] = [];
    let previous: PublicActivityScopeData | undefined;
    for (const text of texts) {
      const result = resolve(text, history, previous);
      expect(result.kind).toBe('public_activity');
      if (result.kind !== 'public_activity') throw new Error('Expected public scope');
      previous = result.public;
      const query = buildPublicActivityQuery(result.public);
      expect(query.kind).toBe('query');
      if (query.kind === 'query') {
        expect(query.query).toContain('San Francisco');
        expect(query.query).toContain('2026-10-');
        expect(query.query).not.toMatch(/but look|newer_than|inbox|calendar/);
      }
      history.push(turn(text, history.length + 1));
    }
    expect(previous?.civilWindow).toMatchObject({
      startDate: '2026-10-24',
      endDateExclusive: '2026-10-26',
    });
  });

  it('requires verified public context before treating a bare events followup as public', () => {
    expect(resolve('Search for events for me.').kind).not.toBe('public_activity');
    const history = [
      turn('Find public events in San Francisco today', 1),
      ...Array.from({ length: 8 }, (_, i) => turn('Thanks', i + 2)),
    ];
    expect(resolve('Search for events for me.', history).kind).not.toBe('public_activity');
    expect(
      resolveActiveReadIntent({
        text: 'Search for events for me.',
        now,
        timeZone: 'America/Los_Angeles',
      }).kind,
    ).not.toBe('public_activity');
    expect(resolve('Search for events on my calendar today').kind).toBe('personal');
    expect(resolve('Try again').kind).not.toBe('clarify_public');
  });
  it('uses the same public recognizer for Seattle history and city changes', () => {
    const initial = 'Find events in Seattle this weekend';
    const first = resolve(initial);
    expect(first.kind).toBe('public_activity');
    if (first.kind !== 'public_activity') throw new Error('scope');
    const second = resolve('Search for events for me.', [turn(initial, 1)]);
    expect(second.kind === 'public_activity' && second.public.location.label).toBe('Seattle');
    const changed = resolve(
      'Find public events in Portland this weekend',
      [turn(initial, 1)],
      first.public,
    );
    expect(changed.kind === 'public_activity' && changed.public.location.label).toBe('Portland');
  });
  it('records an explicitly combined free-time purpose without leaking its clause to query', () => {
    const result = resolve(
      'Find public events in San Francisco today and check my calendar for free time',
    );
    expect(result.kind).toBe('combined');
    if (result.kind !== 'combined') throw new Error('combined');
    expect(result.combinationPurpose.kind).toBe('availability');
    const query = buildPublicActivityQuery(result.public);
    expect(query.kind === 'query' && query.query).not.toMatch(/calendar|free time/);
  });
  it('retains owner category and free filter through a new task without checkpoint', () => {
    const initial = 'Find public jazz concerts in Seattle today, free admission';
    const result = resolve('Search for events for me.', [turn(initial, 1)]);
    expect(result.kind).toBe('public_activity');
    if (result.kind !== 'public_activity') throw new Error('scope');
    const query = buildPublicActivityQuery(result.public);
    expect(query.kind === 'query' && query.query).toMatch(/jazz concerts/);
    expect(query.kind === 'query' && query.query).toMatch(/free admission/);
  });
  it('carries a narrowly supported free-outdoor preference only from verified public context', () => {
    const initialText = 'Find public events in San Francisco this weekend';
    const initial = resolve(initialText);
    expect(initial.kind).toBe('public_activity');
    if (initial.kind !== 'public_activity') throw new Error('public scope');

    const refined = resolve('Only free outdoor things.', [turn(initialText, 1)], initial.public);
    expect(refined.kind).toBe('public_activity');
    if (refined.kind !== 'public_activity') throw new Error('refined public scope');
    expect(refined.public).toMatchObject({
      location: { label: 'San Francisco' },
      civilWindow: initial.public.civilWindow,
      sourceExclusions: ['calendar', 'mail'],
      filters: [
        { kind: 'free', value: 'free admission', basisMessageId: 'm2' },
        { kind: 'category', value: 'outdoor activities', basisMessageId: 'm2' },
      ],
    });
    const query = buildPublicActivityQuery(refined.public);
    expect(query.kind).toBe('query');
    if (query.kind === 'query') {
      expect(query.query).toContain('San Francisco');
      expect(query.query).toContain('free admission');
      expect(query.query).toContain('outdoor activities');
    }
    expect(resolve('Only free outdoor things.').kind).not.toBe('public_activity');
  });
  it('accepts the same exact preference when included in a complete public request', () => {
    const result = resolve(
      'Find public events in San Francisco this weekend; only free outdoor things.',
    );
    expect(result.kind).toBe('public_activity');
    if (result.kind !== 'public_activity') throw new Error('public scope');
    expect(result.public.filters).toEqual([
      { kind: 'free', value: 'free admission', basisMessageId: 'm1' },
      { kind: 'category', value: 'outdoor activities', basisMessageId: 'm1' },
    ]);
  });
  it.each(['wheelchair accessible', 'under 18', 'food', 'vegan only'])(
    'does not silently discard unsupported owner constraint %s',
    (constraint) => {
      expect(resolve(`Find public events in Seattle today ${constraint}`)).toMatchObject({
        kind: 'clarify_public',
        reason: 'unsupported',
      });
    },
  );
  it.each([
    'Only free outdoor things for kids',
    'Only free outdoor things under $20',
    'Only free outdoor things near BART',
    'Find public events in San Francisco this weekend; only outdoor things near BART',
    'Find public events in San Francisco this weekend; only free outdoor things near BART',
    'Find public events in San Francisco this weekend; only free outdoor things at BART',
    'Only free outdoor things at BART',
  ])('keeps unsupported constraints visible after a supported public preference: %s', (text) => {
    const initialText = 'Find public events in San Francisco this weekend';
    const initial = resolve(initialText);
    if (initial.kind !== 'public_activity') throw new Error('public scope');
    expect(resolve(text, [turn(initialText, 1)], initial.public)).toMatchObject({
      kind: 'clarify_public',
      reason: 'unsupported',
      partial: { location: { label: 'San Francisco' } },
    });
  });

  it('resolves distinct-task terse and date-only followups from actual prior rows without checkpoint', () => {
    const priorText = 'Find public events in San Francisco today';
    const history = [turn(priorText, 1)];
    const initial = resolve(priorText);
    const terse = resolve('Search for events for me.', history);
    const tomorrow = resolve('Tomorrow instead', history);
    expect(terse.kind).toBe('public_activity');
    expect(tomorrow.kind).toBe('public_activity');
    if (
      initial.kind !== 'public_activity' ||
      terse.kind !== 'public_activity' ||
      tomorrow.kind !== 'public_activity'
    )
      throw new Error('public');
    expect(terse.public.provenance.taskId).not.toBe(initial.public.provenance.taskId);
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        terse,
        'Search for events for me.',
        initial,
      ),
    ).toBe('same_scope');
    expect(tomorrow.public.civilWindow.startDate).toBe('2026-10-24');
    expect(
      publicActivityFollowupDisposition(initial.public, tomorrow, 'Tomorrow instead', initial),
    ).toBe('superseded');
    expect(resolve('Tomorrow instead').kind).not.toBe('public_activity');
    const nextWeekend = resolve('Instead, next weekend', history);
    expect(nextWeekend.kind).toBe('public_activity');
    if (nextWeekend.kind !== 'public_activity') throw new Error('public');
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        nextWeekend,
        'Instead, next weekend',
        initial,
      ),
    ).toBe('superseded');
    expect(resolve('Instead, next weekend').kind).not.toBe('public_activity');
  });
  it('resolves owner-local today rather than UTC date', () => {
    const result = resolve('Find public events in San Francisco today');
    expect(result.kind === 'public_activity' && result.public.civilWindow.startDate).toBe(
      '2026-10-23',
    );
  });

  it('inherits the actual prior task clock without a public checkpoint', () => {
    const prior = turn('Find public events in San Francisco today', 1);
    const text = 'Search for events for me.';
    const current = turn(text, 2);
    const input = {
      text,
      now: new Date('2026-10-26T06:30:00Z'),
      timeZone: 'America/Los_Angeles',
      ownerTurns: [prior, current],
      provenance: {
        agentId: 'a',
        conversationId: 'c',
        taskId: 't2',
        triggerMessageId: 'm2',
        requestHash: 'h',
      },
    };
    const inherited = resolveActiveReadIntent(input);
    expect(inherited.kind === 'public_activity' && inherited.public.civilWindow.startDate).toBe(
      '2026-10-23',
    );
    expect(inherited.kind === 'public_activity' && inherited.public.clock.referenceAt).toBe(
      now.toISOString(),
    );
    expect(
      resolveActiveReadIntent({
        ...input,
        ownerTurns: [{ ...prior, requestAt: undefined }, current],
      }),
    ).toMatchObject({ kind: 'clarify_public', reason: 'missing_time' });
    const explicit = 'Find public events in San Francisco today';
    const reanchored = resolveActiveReadIntent({
      ...input,
      text: explicit,
      ownerTurns: [prior, { ...current, text: explicit, ownerAuthoredText: explicit }],
    });
    expect(reanchored.kind === 'public_activity' && reanchored.public.civilWindow.startDate).toBe(
      '2026-10-25',
    );
  });
  it('retains the reviewed interval on delayed terse continuation', () => {
    const first = resolve('Find public events in San Francisco today');
    if (first.kind !== 'public_activity') throw new Error('scope');
    const text = 'Search for events for me.';
    const current = turn(text, 2);
    const result = resolveActiveReadIntent({
      text,
      now: new Date('2027-01-01T12:00:00Z'),
      timeZone: 'America/Los_Angeles',
      previousPublic: first.public,
      ownerTurns: [turn('Find public events in San Francisco today', 1), current],
      provenance: {
        agentId: 'a',
        conversationId: 'c',
        taskId: 't2',
        triggerMessageId: 'm2',
        requestHash: 'hash',
      },
    });
    expect(result.kind === 'public_activity' && result.public.civilWindow).toEqual(
      first.public.civilWindow,
    );
  });
  it('does not infer public authority from event alone', () => {
    expect(resolve('What events are on my calendar today?').kind).toBe('personal');
    expect(resolve('What events are on my calendar in San Francisco today?').kind).toBe('personal');
  });
  it('preserves explicit personal inbox requests', () => {
    expect(resolve('Read my inbox today').kind).toBe('personal');
  });
  it('combines only an explicit additional personal purpose', () => {
    const result = resolve('Find public events in San Francisco today and check my calendar');
    expect(result.kind).toBe('combined');
    if (result.kind === 'combined')
      expect(result.combinationPurpose.kind).toBe('explicit_personal_read');
  });
  it('binds combined availability to the public weekend unless the personal clause names its own date', () => {
    const result = resolve(
      'Find public events in San Francisco this weekend and check my calendar for free time',
    );
    expect(result.kind).toBe('combined');
    if (result.kind !== 'combined') throw new Error('combined');
    expect(result.personal.timeWindow?.timeMin.slice(0, 10)).toBe('2026-10-24');
    expect(result.personal.timeWindow?.timeMax.slice(0, 10)).toBe('2026-10-26');
    const ownDate = resolve(
      'Find public events in San Francisco this weekend and check my calendar tomorrow',
    );
    expect(ownDate.kind).toBe('combined');
    if (ownDate.kind !== 'combined') throw new Error('combined');
    expect(ownDate.personal.timeWindow?.timeMin.slice(0, 10)).toBe('2026-10-24');
    expect(ownDate.personal.timeWindow?.timeMax.slice(0, 10)).toBe('2026-10-25');
  });
  it('does not treat an empty weekend as a personal read addition', () => {
    expect(
      resolve('Find city events I could attend in San Francisco; my weekend is empty').kind,
    ).toBe('public_activity');
  });
  it('keeps missing provenance public and never falls back to private reads', () => {
    expect(
      resolveActiveReadIntent({
        text: 'Find public events in San Francisco today, not my calendar',
        now,
        timeZone: 'America/Los_Angeles',
      }),
    ).toMatchObject({ kind: 'clarify_public', reason: 'missing_provenance' });
  });
  it('rejects mismatched owner text and foreign-conversation location authority', () => {
    const current = turn('Search for events for me.', 2);
    const result = resolveActiveReadIntent({
      text: current.text,
      now,
      timeZone: 'America/Los_Angeles',
      ownerTurns: [
        { ...turn('Find public events in San Francisco today', 1), conversationId: 'foreign' },
        { ...current, ownerAuthoredText: 'unrelated' },
      ],
      provenance: {
        agentId: 'a',
        conversationId: 'c',
        taskId: 't2',
        triggerMessageId: 'm2',
        requestHash: 'h',
      },
    });
    expect(result.kind).not.toBe('public_activity');
  });
  it('asks for missing place or date without a personal fallback', () => {
    expect(resolve('Find public events today')).toMatchObject({
      kind: 'clarify_public',
      reason: 'missing_location',
    });
    expect(resolve('Find public events in San Francisco')).toMatchObject({
      kind: 'clarify_public',
      reason: 'missing_time',
    });
  });
  it('does not carry old public intent into unrelated personal work', () => {
    const first = resolve('Find public events in San Francisco today');
    if (first.kind !== 'public_activity') throw new Error('scope');
    expect(resolve('Read my inbox', [], first.public).kind).toBe('personal');
  });
  it('validates persisted scope and rejects bounds instead of silently clamping', () => {
    const result = resolve('Find public events in San Francisco today');
    if (result.kind !== 'public_activity') throw new Error('scope');
    expect(parsePublicActivityScope(result.public)).toEqual(result.public);
    expect(
      parsePublicActivityScope({
        ...result.public,
        civilWindow: {
          startDate: '2026-10-01',
          endDateExclusive: '2026-12-01',
          label: 'two months',
        },
      }),
    ).toBeUndefined();
    expect(
      parsePublicActivityScope({
        ...result.public,
        filters: Array.from({ length: 9 }, () => ({
          kind: 'free',
          value: 'free',
          basisMessageId: 'm1',
        })),
      }),
    ).toBeUndefined();
    const overflow = {
      ...result.public,
      topic: 'x'.repeat(160),
      location: { label: 'y'.repeat(160), basisMessageId: 'm1' },
    };
    expect(buildPublicActivityQuery(overflow)).toEqual({ kind: 'unsupported' });
    expect(publicActivityScopeHash(result.public)).toBe(publicActivityScopeHash(result.public));
    expect(publicActivityScopeHash({ ...result.public, revision: 2 })).not.toBe(
      publicActivityScopeHash(result.public),
    );
  });
});

describe('pending public search follow-up disposition', () => {
  it('compares effective scope only for explicitly linked owner follow-ups', () => {
    const initial = resolve('Find public events in San Francisco today');
    if (initial.kind !== 'public_activity') throw new Error('scope');
    const same = {
      kind: 'public_activity' as const,
      public: { ...initial.public, revision: 9, requestMessageId: 'changed-provenance' },
    };
    const changed = {
      kind: 'public_activity' as const,
      public: { ...initial.public, location: { ...initial.public.location, label: 'Seattle' } },
    };
    expect(publicActivityFollowupDisposition(initial.public, same, 'Try again')).toBe('same_scope');
    expect(
      publicActivityFollowupDisposition(initial.public, changed, 'Instead look in Seattle'),
    ).toBe('superseded');
    expect(publicActivityFollowupDisposition(initial.public, changed, 'Seattle')).toBe(
      'superseded',
    );
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        changed,
        'Find public events in Seattle today',
      ),
    ).toBe('unrelated');
    expect(
      publicActivityFollowupDisposition(initial.public, { kind: 'none' }, 'Read my inbox'),
    ).toBe('unrelated');
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        { kind: 'clarify_public', reason: 'unsupported', partial: {} },
        'Anything free?',
      ),
    ).toBe('superseded');
    expect(publicActivityFollowupDisposition(initial.public, { kind: 'none' }, 'Stop')).toBe(
      'superseded',
    );
    expect(
      publicActivityFollowupDisposition(initial.public, { kind: 'none' }, 'Cancel the search'),
    ).toBe('superseded');
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        { kind: 'none' },
        'Cancel my dentist appointment',
      ),
    ).toBe('unrelated');
    const combined = resolve(
      'Find public events in San Francisco today and check my calendar for free time',
    );
    if (combined.kind !== 'combined') throw new Error('combined');
    expect(publicActivityFollowupDisposition(initial.public, combined, 'Try again', initial)).toBe(
      'superseded',
    );
    expect(
      publicActivityFollowupDisposition(
        combined.public,
        initial,
        'Search for events for me.',
        combined,
      ),
    ).toBe('superseded');
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        initial,
        'Search for events for me.',
        initial,
      ),
    ).toBe('same_scope');
    expect(
      publicActivityFollowupDisposition(
        initial.public,
        { kind: 'none' },
        'Use my inbox instead',
        initial,
      ),
    ).toBe('superseded');
    expect(
      publicActivityFollowupDisposition(initial.public, initial, 'Not my calendar', initial),
    ).toBe('superseded');
  });
  it('retains SF and original clock across standalone exclusion and fresh-task But look continuation', () => {
    const first = turn('Find public events in San Francisco this weekend', 1);
    const exclusion = turn('Not my calendar', 2);
    const result = resolve('But look for events', [first, exclusion]);
    expect(result.kind).toBe('public_activity');
    if (result.kind !== 'public_activity') throw new Error('scope');
    expect(result.public.location.label).toBe('San Francisco');
    expect(result.public.civilWindow).toMatchObject({
      startDate: '2026-10-24',
      endDateExclusive: '2026-10-26',
    });
    expect(result.public.sourceExclusions).toEqual(['calendar', 'mail']);
    expect(result.public.basisMessageIds).toEqual(['m1', 'm2', 'm3']);
    const query = buildPublicActivityQuery(result.public);
    expect(query.kind === 'query' && query.query).toContain('San Francisco');
    expect(query.kind === 'query' && query.query).not.toMatch(
      /but look|calendar|inbox|newer_than/i,
    );
  });
  it.each([
    'Find my hotel confirmation email in Berlin and find my flight confirmation email to Paris on 2026-12-21 and find my museum reservation in Rome',
    'Find my museum reservation in Rome',
    'Find my hotel confirmation email in Berlin',
    'Find my museum booking in Rome',
  ])('preserves owner-private reservation or confirmation lookup: %s', (text) => {
    expect(resolve(text).kind).toBe('personal');
  });
  it('retains genuine public museum discovery and explicit public-not-private scope', () => {
    expect(resolve('Find museums in Rome today').kind).toBe('public_activity');
    const corrected = resolve('Find public events in Rome today, not my museum reservation');
    expect(corrected.kind).toBe('public_activity');
  });
});
