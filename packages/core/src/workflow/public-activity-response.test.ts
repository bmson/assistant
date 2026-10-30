import { describe, expect, it } from 'vitest';
import { type PublicActivityScopeData, resolveActiveReadIntent } from './active-read-intent.js';
import { nextLiveLookup } from './live-lookup.js';
import { type OwnerIntent, ownerIntentForResolvedRead } from './owner-intent.js';
import { responseCardsForFinal } from './response-cards.js';
import {
  type ActionEvidence,
  enforceResponseContract,
  publicActivitySourceLeads,
} from './response-contract.js';

function scope(free = false): PublicActivityScopeData {
  const text = `Find public events in San Francisco this weekend${free ? ' free admission' : ''}`;
  const resolved = resolveActiveReadIntent({
    text,
    now: new Date('2026-10-24T06:30:00Z'),
    timeZone: 'America/Los_Angeles',
    provenance: {
      agentId: 'fixture-agent',
      conversationId: 'fixture-conversation',
      taskId: 'fixture-task',
      triggerMessageId: 'fixture-owner-turn',
      requestHash: 'fixture-authoritative-admission-hash',
    },
    ownerTurns: [
      {
        id: 'fixture-owner-turn',
        agentId: 'fixture-agent',
        conversationId: 'fixture-conversation',
        taskId: 'fixture-task',
        role: 'user',
        origin: 'owner',
        text,
        ownerAuthoredText: text,
      },
    ],
  });
  if (resolved.kind !== 'public_activity') throw new Error('Expected validated fixture scope');
  return resolved.public;
}
const url = 'https://example.test/art-walk';
const listing = 'Art Walk, San Francisco, October 24, 2026. Start 10:00 am. Admission $15.';
const reply = `San Francisco, October 24, 2026: Art Walk — 10:00 am, $15. ${url}`;
function fetchEvidence(text = listing, source = url): ActionEvidence {
  return {
    toolName: 'web.fetch',
    status: 'succeeded',
    args: { url: source },
    result: { status: 200, url: source, finalUrl: source, title: 'Art Walk', text },
    fromCurrentTask: true,
  };
}
function searchEvidence(results: unknown, status = 'succeeded'): ActionEvidence {
  return { toolName: 'web.search', status, result: { results } };
}
describe('public activity response source contract', () => {
  it('renders fetched source title and URL as unverified leads, ignoring all draft details', () => {
    const result = enforceResponseContract(
      'Invented Gala at Secret Hall, 11:30 pm, $99, sold out. https://invented.test/',
      [fetchEvidence()],
      { publicActivity: scope() },
    );
    expect(result.text).toContain('[Art Walk](https://example.test/art-walk)');
    expect(result.text).toContain('2026-10-24');
    expect(result.text).toMatch(
      /occurrences, times, venues, admission prices.*availability remain unverified/,
    );
    expect(result.text).not.toMatch(
      /Invented Gala|Secret Hall|11:30|\$99|sold out|invented.test|10:00|\$15/,
    );
    expect(result.groundingFallback).toContain('public_event_occurrence_unverified');
    expect(result.publicActivityEvidenceStatus).toBe('source_leads_found');
  });
  it('distinguishes a completed search with no relevant evidence from a web tool failure', () => {
    const empty = enforceResponseContract('No events exist.', [searchEvidence([])], {
      publicActivity: scope(),
    });
    expect(empty.publicActivityEvidenceStatus).toBe('no_relevant_evidence');
    expect(empty.text).toContain('searched public sources');
    expect(empty.text).toContain('does not establish that no public events exist');
    expect(empty.text).not.toMatch(/No events exist\./);

    const failed = enforceResponseContract('No events exist.', [searchEvidence(null, 'failed')], {
      publicActivity: scope(),
    });
    expect(failed.publicActivityEvidenceStatus).toBe('tool_failure');
    expect(failed.text).toContain('lookup failed');
    expect(failed.text).toContain('cannot tell whether matching events are listed');
    expect(failed.text).not.toMatch(/searched public sources|No events exist\./);

    const providerError = enforceResponseContract(
      'No events exist.',
      [{ ...searchEvidence([]), result: { ok: false, status: 503 } }],
      { publicActivity: scope() },
    );
    expect(providerError.publicActivityEvidenceStatus).toBe('tool_failure');

    const denied = enforceResponseContract('No events exist.', [searchEvidence([], 'denied')], {
      publicActivity: scope(),
    });
    expect(denied.publicActivityEvidenceStatus).toBe('lookup_not_completed');
    expect(denied.text).toContain('could not complete a public web lookup');
    expect(denied.text).not.toMatch(/searched public sources|No events exist\./);
  });
  it('marks partially fetched and malformed search results incomplete, never as an empty search', () => {
    const search = searchEvidence([{ title: 'Art Walk', url }]);
    const fetchFailed = enforceResponseContract(
      'No events exist.',
      [search, { ...fetchEvidence(), status: 'failed', result: null }],
      { publicActivity: scope() },
    );
    expect(fetchFailed.publicActivityEvidenceStatus).toBe('incomplete');
    expect(fetchFailed.text).toContain('lookup may be incomplete');
    expect(fetchFailed.text).toContain('does not establish that no matching events exist');

    const malformed = enforceResponseContract(
      'No events exist.',
      [searchEvidence({ error: 'bad' })],
      {
        publicActivity: scope(),
      },
    );
    expect(malformed.publicActivityEvidenceStatus).toBe('incomplete');
    expect(malformed.text).toContain('lookup may be incomplete');

    const malformedFetch = enforceResponseContract(
      'No events exist.',
      [search, { ...fetchEvidence(), result: { finalUrl: url } }],
      { publicActivity: scope() },
    );
    expect(malformedFetch.publicActivityEvidenceStatus).toBe('incomplete');
    expect(malformedFetch.text).toContain('lookup may be incomplete');

    const emptyFetch = enforceResponseContract(
      'No events exist.',
      [search, { ...fetchEvidence(), result: { status: 200, finalUrl: url, text: '  ' } }],
      { publicActivity: scope() },
    );
    expect(emptyFetch.publicActivityEvidenceStatus).toBe('incomplete');
  });
  it('marks missing public attempts separately and ignores private or prior-task evidence', () => {
    const none = enforceResponseContract('No events exist.', [], { publicActivity: scope() });
    expect(none.publicActivityEvidenceStatus).toBe('not_attempted');
    expect(none.text).toContain('have not completed a public web lookup');

    const privateAndStale = enforceResponseContract(
      'PRIVATE_CALENDAR_CANARY and PRIVATE_MAIL_CANARY',
      [
        {
          toolName: 'calendar.list_events',
          status: 'succeeded',
          result: { events: [{ summary: 'PRIVATE_CALENDAR_CANARY' }] },
        },
        { ...searchEvidence([]), fromCurrentTask: false },
      ],
      { publicActivity: scope() },
    );
    expect(privateAndStale.publicActivityEvidenceStatus).toBe('not_attempted');
    expect(privateAndStale.text).not.toMatch(/PRIVATE_|No events exist/);
  });
  it('calls fully inspected but out-of-scope pages no relevant evidence, not a tool failure', () => {
    const wrongYear = listing.replace('2026', '2025');
    const result = enforceResponseContract(
      reply,
      [searchEvidence([{ title: 'Art Walk', url }]), fetchEvidence(wrongYear)],
      { publicActivity: scope() },
    );
    expect(result.publicActivityEvidenceStatus).toBe('no_relevant_evidence');
    expect(result.text).toContain('searched public sources');
    expect(result.text).not.toContain('lookup failed');
    expect(result.text).not.toContain('Art Walk');
  });
  it.each([
    ['wrong year', listing.replace('2026', '2025')],
    ['outside window', listing.replace('October 24', 'October 30')],
    ['wrong city', listing.replace('San Francisco', 'Seattle')],
  ])('does not surface plainly irrelevant %s page', (_name, content) => {
    expect(publicActivitySourceLeads([fetchEvidence(content)], scope())).toBeUndefined();
  });
  it('does not use requested-date or city tokens inside a URL as source relevance', () => {
    const wrongYear = `${listing.replace('2026', '2025')} https://example.test/art-2026-10-24`;
    expect(publicActivitySourceLeads([fetchEvidence(wrongYear)], scope())).toBeUndefined();
    const result = enforceResponseContract(reply, [fetchEvidence(wrongYear)], {
      publicActivity: scope(),
    });
    expect(result.text).toContain('could not verify');
    expect(result.text).not.toContain('Art Walk');
    const wrongCity = `${listing.replace('San Francisco', 'Seattle')} https://example.test/San-Francisco`;
    expect(publicActivitySourceLeads([fetchEvidence(wrongCity)], scope())).toBeUndefined();
  });
  it('excludes stale, private-only, failed fetch and search-snippet-only evidence', () => {
    const search: ActionEvidence = {
      toolName: 'web.search',
      status: 'succeeded',
      result: { results: [{ title: 'Art Walk', url, snippet: listing }] },
    };
    for (const evidence of [
      [{ ...fetchEvidence(), fromCurrentTask: false }],
      [{ ...fetchEvidence(), toolName: 'gmail.read_thread' }],
      [{ ...fetchEvidence(), status: 'failed' }],
      [search],
    ]) {
      expect(publicActivitySourceLeads(evidence, scope())).toBeUndefined();
      const result = enforceResponseContract(reply, evidence, { publicActivity: scope() });
      expect(result.text).toContain('could not verify');
      expect(result.text).not.toContain('Art Walk');
    }
  });
  it('does not turn mixed old/new pages or cross-listing figures into occurrence facts', () => {
    const mixed = fetchEvidence(
      'Old Art Walk: Seattle 2025 $99 11:30 pm. San Francisco public listings updated October 24, 2026. Venue Secret Hall.',
    );
    const other = fetchEvidence(
      'San Francisco October 25, 2026. Another listing admission $200 at 8:00 pm.',
      'https://example.test/other',
    );
    const result = enforceResponseContract(
      'Art Walk at Secret Hall, $200, 8:00 pm, confirmed.',
      [mixed, other],
      { publicActivity: scope() },
    );
    expect(result.text).toContain(url);
    expect(result.text).toContain('remain unverified');
    expect(result.text).not.toMatch(/Secret Hall|\$200|8:00|confirmed|Seattle|2025|\$99|11:30/);
  });
  it.each(['Not free. Admission $15.', 'Free parking. Admission $15.', 'Tickets $25.'])(
    'excludes explicitly paid sources for a free request: %s',
    (price) => {
      expect(
        publicActivitySourceLeads(
          [fetchEvidence(`San Francisco October 24, 2026. ${price}`)],
          scope(true),
        ),
      ).toBeUndefined();
    },
  );
  it('allows a free-parking-only page solely as an admission-unverified lead', () => {
    const result = enforceResponseContract(
      'Free Art Walk confirmed.',
      [fetchEvidence('San Francisco October 24, 2026. Free parking.')],
      { publicActivity: scope(true) },
    );
    expect(result.text).toContain(url);
    expect(result.text).toContain('including free admission');
    expect(result.text).toContain('remain unverified');
    expect(result.text).not.toContain('Free Art Walk confirmed');
  });
  it('uses only actual fetched titles and safe URLs, with no invented draft URL', () => {
    const result = enforceResponseContract('https://invented.test/', [fetchEvidence()], {
      publicActivity: scope(),
    });
    expect(result.text).toContain(url);
    expect(result.text).not.toContain('invented.test');
    expect(
      publicActivitySourceLeads([fetchEvidence(listing, 'javascript:alert(1)')], scope()),
    ).toBeUndefined();
  });
  it('selects only public cards despite supplied private evidence, read request and ambient', () => {
    const publicScope = scope();
    const evidence: ActionEvidence[] = [
      {
        toolName: 'calendar.list_events',
        status: 'succeeded',
        result: {
          events: [
            {
              id: 'private-event',
              summary: 'PRIVATE_CALENDAR_CANARY',
              start: '2026-10-24T17:00:00Z',
              end: '2026-10-24T18:00:00Z',
            },
          ],
        },
      },
      {
        toolName: 'gmail.read_thread',
        status: 'succeeded',
        result: { messages: [{ subject: 'PRIVATE_MAIL_CANARY', text: 'PRIVATE_THREAD_CANARY' }] },
      },
      { ...fetchEvidence('PRIVATE_PRIOR_WEB_CANARY'), fromCurrentTask: false },
    ];
    const cards = responseCardsForFinal({
      resolvedReadIntent: { kind: 'public_activity', public: publicScope },
      evidence,
      readRequest: {
        kind: 'calendar',
        queryTerms: [],
        firstToolName: 'calendar.list_events',
        requiresThreadRead: false,
      },
      ambient: 'PRIVATE_AMBIENT_CANARY',
      requestText: 'Find public events in San Francisco this weekend',
    });
    expect(cards).toEqual([]);
    expect(JSON.stringify(cards)).not.toMatch(/PRIVATE_|agenda|calendar|thread|mail/);
  });
  it('keeps fallback free of private receipts even if supplied defensively', () => {
    const privateRow: ActionEvidence = {
      toolName: 'gmail.read_thread',
      status: 'succeeded',
      result: { text: `PRIVATE_CANARY ${listing}`, url },
    };
    const result = enforceResponseContract(reply, [privateRow], { publicActivity: scope() });
    expect(result.text).not.toContain('PRIVATE_CANARY');
    expect(result.text).toContain('could not verify');
    expect(result.groundingFallback?.length).toBeGreaterThan(0);
  });
});

describe('resolved read permission projection', () => {
  const original: OwnerIntent = {
    sourceActor: 'owner',
    requestKind: 'new_request',
    ownerAuthoredText: 'synthetic request',
    externalText: '',
    authorizedScopes: ['private_read'],
    separation: 'clear',
  };
  it('narrows mistaken private scope for public reads and keeps clarification tool-free', () => {
    expect(
      ownerIntentForResolvedRead(original, { kind: 'public_activity', public: scope() })
        .authorizedScopes,
    ).toEqual(['external_read']);
    expect(
      ownerIntentForResolvedRead(original, {
        kind: 'clarify_public',
        reason: 'missing_time',
        partial: {},
      }).authorizedScopes,
    ).toEqual([]);
  });
  it('retains explicit combined private scope without manufacturing it', () => {
    const text = 'Find public events in San Francisco this weekend and check my calendar';
    const resolved = resolveActiveReadIntent({
      text,
      now: new Date('2026-10-24T06:30:00Z'),
      timeZone: 'America/Los_Angeles',
      provenance: {
        agentId: 'a',
        conversationId: 'c',
        taskId: 't',
        triggerMessageId: 'm',
        requestHash: 'h',
      },
      ownerTurns: [
        {
          id: 'm',
          agentId: 'a',
          conversationId: 'c',
          taskId: 't',
          role: 'user',
          origin: 'owner',
          text,
          ownerAuthoredText: text,
        },
      ],
    });
    expect(resolved.kind).toBe('combined');
    expect(ownerIntentForResolvedRead(original, resolved).authorizedScopes).toEqual([
      'external_read',
      'private_read',
    ]);
    expect(
      ownerIntentForResolvedRead({ ...original, authorizedScopes: [] }, resolved).authorizedScopes,
    ).toEqual(['external_read']);
  });
});

describe('bounded public listing verification', () => {
  it('tries at most three distinct search-result pages, including after failure', () => {
    const publicScope = scope();
    const lookup = {
      kind: 'web' as const,
      request: 'fixed admitted public query',
      publicActivityScope: publicScope,
    };
    const search: ActionEvidence = {
      toolName: 'web.search',
      status: 'succeeded',
      result: { results: [1, 2, 3, 4].map((n) => ({ url: `https://example.test/${n}` })) },
    };
    const evidence = [search];
    for (let n = 1; n <= 3; n++) {
      expect(nextLiveLookup(lookup, evidence)).toEqual({
        toolName: 'web.fetch',
        input: { url: `https://example.test/${n}` },
      });
      evidence.push({
        toolName: 'web.fetch',
        status: n === 1 ? 'failed' : 'succeeded',
        args: { url: `https://example.test/${n}` },
        result: {},
      });
    }
    expect(nextLiveLookup(lookup, evidence)).toBeUndefined();
  });
});
