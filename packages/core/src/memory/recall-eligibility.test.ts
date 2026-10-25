import type { OwnerCommitment, SituationDecisionContext } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import {
  type AutomaticRecallCandidate,
  eligibleAutomaticRecallCandidates,
  normalizeRecallTokens,
  ownerCommitmentRecallMeaning,
  situationDecisionRecallMeaning,
} from './recall-eligibility.js';

function candidate(
  id: string,
  meaning: string,
  sourceRevision = `revision-${id}`,
): AutomaticRecallCandidate {
  return { id, sourceRevision, meaning };
}

const decision = (overrides: Partial<SituationDecisionContext> = {}): SituationDecisionContext => ({
  decisionId: '40000000-0000-4000-8000-000000000001',
  option: 'wheelchair-accessible entrances',
  outcome: 'chosen',
  reason: 'step-free entry matters',
  scope: 'preference',
  packId: '30000000-0000-4000-8000-000000000001',
  packTitle: 'Appointment preferences',
  packVersion: 3,
  packUpdatedAt: '2026-10-01T00:00:00.000Z',
  relevance: 0.9,
  ...overrides,
});

const commitment = (overrides: Partial<OwnerCommitment> = {}): OwnerCommitment => ({
  id: '10000000-0000-4000-8000-000000000001',
  agentId: '00000000-0000-4000-8000-000000000001',
  title: 'Travel packing',
  status: 'open',
  nextAction: 'Pack the charging cable',
  conversationId: '00000000-0000-4000-8000-000000000002',
  sourceMessageId: '20000000-0000-4000-8000-000000000001',
  sourceTaskId: '00000000-0000-4000-8000-000000000003',
  sourceOccurrenceKey: 'occurrence-00000000-0000-4000-8000-000000000004',
  reopenedFromId: null,
  reopenOperationId: null,
  kind: 'waiting_on',
  details: 'Waiting for a separate travel reply',
  dueAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  resolution: null,
  confidence: '0.9',
  contentHash: 'd6c1c04465b100fa38e0a03a9db54af07fd23f770f44bdf143bad45c13cd5c9b',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

describe('automatic recall eligibility', () => {
  it('does not add unrelated history to a generic procedural request', () => {
    const row = commitment();
    const result = eligibleAutomaticRecallCandidates('Give me a preparation checklist.', [
      candidate(row.id, ownerCommitmentRecallMeaning(row)),
    ]);
    expect(result).toEqual({
      reason: 'no_request_subject',
      candidates: [],
      subjectPhrases: [],
    });
  });

  it('admits an exact multi-token subject from approved situation-decision fields only', () => {
    const matching = situationDecisionRecallMeaning(decision());
    const labelOnly = situationDecisionRecallMeaning(
      decision({
        option: 'nearby drop-off',
        reason: 'reduce walking',
        packTitle: 'wheelchair-accessible entrances',
      }),
    );
    const candidates = [
      candidate('decision-match', matching, 'rev-match'),
      candidate('decision-label-only', labelOnly, 'rev-label'),
    ];
    const result = eligibleAutomaticRecallCandidates(
      'Find an appointment at a clinic with wheelchair-accessible entrances.',
      candidates,
    );
    expect(result.reason).toBe('eligible');
    expect(result.candidates).toEqual([candidates[0]]);
    expect(result.candidates[0]).toMatchObject({
      id: 'decision-match',
      sourceRevision: 'rev-match',
    });
  });

  it('keeps all current request subjects eligible before any downstream history cap', () => {
    const request =
      'Search appointment options with wheelchair-accessible entrances, quiet waiting areas, and accessible parking.';
    const candidates = [
      candidate('entrances', situationDecisionRecallMeaning(decision())),
      candidate(
        'quiet-waiting',
        situationDecisionRecallMeaning(
          decision({ option: 'quiet waiting areas', reason: 'reduce sensory load' }),
        ),
      ),
      candidate(
        'parking',
        situationDecisionRecallMeaning(
          decision({ option: 'accessible parking', reason: 'nearby drop-off' }),
        ),
      ),
    ];
    const result = eligibleAutomaticRecallCandidates(request, candidates);
    expect(result.candidates).toEqual(candidates);
    expect(result.subjectPhrases).toContain('wheelchair accessible entrances');
    expect(result.subjectPhrases).toContain('quiet waiting areas');
    expect(result.subjectPhrases).toContain('accessible parking');
    // This pure eligibility gate does not cap history or rewrite the current
    // request; a later bounded context renderer applies its own source cap.
    expect(request).toContain('and accessible parking.');
  });

  it('uses approved commitment meaning fields and ignores identity, revision and metadata', () => {
    const row = commitment({
      title: 'Confirm the wheelchair-accessible entrances',
      details: 'Check the clinic route',
      nextAction: 'Call the venue',
    });
    const match = candidate(
      'commitment-id-wheelchair-accessible',
      ownerCommitmentRecallMeaning(row),
      'revision-wheelchair-accessible',
    );
    const metadataOnly = candidate(
      'wheelchair-accessible-entrances',
      'Travel packing',
      'revision-wheelchair-accessible-entrances',
    );
    const result = eligibleAutomaticRecallCandidates(
      'Find an appointment at a clinic with wheelchair-accessible entrances.',
      [match, metadataOnly],
    );
    expect(result.candidates).toEqual([match]);
  });

  it('does not match a single name or an unbound semantic paraphrase', () => {
    const nameOnly = eligibleAutomaticRecallCandidates('Find Cedar.', [
      candidate('cedar-choice', 'Cedar East rejected because clearance'),
    ]);
    const paraphrase = eligibleAutomaticRecallCandidates(
      'Find an appointment with step-free doors.',
      [candidate('access-choice', 'wheelchair-accessible entrances')],
    );
    expect(nameOnly.candidates).toEqual([]);
    expect(paraphrase.candidates).toEqual([]);
  });

  it('does not invent a subject for an unresolved continuation', () => {
    const result = eligibleAutomaticRecallCandidates('What about that plan?', [
      candidate('rehearsal-plan', 'rehearsal room plan with side entrance'),
    ]);
    expect(result.reason).toBe('no_request_subject');
    expect(result.candidates).toEqual([]);
  });

  it.each([
    'What is my current preference for wheelchair-accessible entrances?',
    'Which wheelchair-accessible entrances did I choose for the appointment?',
    'What did I choose for wheelchair-accessible entrances?',
    'What did I tell you about coastal rainbows by the sea?',
    'What is the current name of the morning block in my studio workflow?',
  ])('admits a concrete owner-information question: %s', (request) => {
    const meaning = request.includes('coastal rainbows')
      ? 'Earlier coastal rainbows observed by the sea'
      : request.includes('studio workflow')
        ? 'For my studio workflow, I named the morning block Quiet Start at Eight'
        : 'wheelchair-accessible entrances';
    const preference = candidate('owner-history', meaning);
    const result = eligibleAutomaticRecallCandidates(request, [preference]);
    expect(result.reason).toBe('eligible');
    expect(result.candidates).toEqual([preference]);
  });

  it('excludes a generic world question despite exact shared subject wording', () => {
    const history = candidate('owner-history', 'Earlier coastal rainbows observed by the sea');
    const result = eligibleAutomaticRecallCandidates('How do coastal rainbows form?', [history]);
    expect(result.reason).toBe('no_request_subject');
    expect(result.candidates).toEqual([]);
  });

  it('does not treat an unrelated personal setting as an owner-history question', () => {
    const history = candidate('owner-history', 'Earlier coastal rainbows observed by the sea');
    const result = eligibleAutomaticRecallCandidates(
      'How do coastal rainbows form for my current science class?',
      [history],
    );
    expect(result.reason).toBe('no_request_subject');
    expect(result.candidates).toEqual([]);

    const statusReport = eligibleAutomaticRecallCandidates(
      'How do coastal rainbows form for my class status report?',
      [history],
    );
    expect(statusReport.reason).toBe('no_request_subject');
    expect(statusReport.candidates).toEqual([]);
  });

  it('honors a direct owner opt-out without treating a negative-history question as an opt-out', () => {
    const memory = [candidate('cedar', 'Cedar East rejected because clearance')];
    const optOut = eligibleAutomaticRecallCandidates(
      "Don't use my earlier Cedar preference in this answer.",
      memory,
    );
    const recallQuestion = eligibleAutomaticRecallCandidates(
      "Didn't I say not to use Cedar?",
      memory,
    );
    expect(optOut.reason).toBe('owner_opt_out');
    expect(optOut.candidates).toEqual([]);
    // Explicit recall is routed outside this automatic-only helper; its
    // negative wording does not trigger the owner opt-out rule.
    expect(recallQuestion.reason).toBe('uncertain_polarity');
  });

  it.each(["Don't", 'Don’t'])(
    'recognizes straight and typographic apostrophe opt-outs: %s',
    (opening) => {
      const memory = candidate('access-preference', 'wheelchair-accessible entrances');
      const result = eligibleAutomaticRecallCandidates(
        `${opening} use my earlier wheelchair-accessible entrances preference. Find wheelchair-accessible entrances.`,
        [memory],
      );
      expect(result.reason).toBe('owner_opt_out');
      expect(result.candidates).toEqual([]);
    },
  );

  it.each([
    'Find a clinic without wheelchair-accessible entrances.',
    'Find an option excluding quiet waiting areas.',
  ])('abstains when the current request has negative preference polarity: %s', (request) => {
    const result = eligibleAutomaticRecallCandidates(request, [
      candidate('positive-access-preference', 'wheelchair-accessible entrances'),
      candidate('positive-quiet-preference', 'quiet waiting areas'),
    ]);
    expect(result.reason).toBe('uncertain_polarity');
    expect(result.candidates).toEqual([]);
  });

  it.each([
    [
      "Find clinics that don't have wheelchair-accessible entrances.",
      'Find clinics that don’t have wheelchair-accessible entrances.',
    ],
    [
      "Find a clinic that doesn't have wheelchair-accessible entrances.",
      'Find a clinic that doesn’t have wheelchair-accessible entrances.',
    ],
    [
      "Find a clinic where there isn't a wheelchair-accessible entrance.",
      'Find a clinic where there isn’t a wheelchair-accessible entrance.',
    ],
    [
      "Find clinics that can't provide wheelchair-accessible entrances.",
      'Find clinics that can’t provide wheelchair-accessible entrances.',
    ],
  ])('abstains on contracted negative constraints, straight and curly: %s', (...requests) => {
    const preference = candidate('positive-access-preference', 'wheelchair-accessible entrances');
    for (const request of requests) {
      const result = eligibleAutomaticRecallCandidates(request, [preference]);
      expect(result.reason).toBe('uncertain_polarity');
      expect(result.candidates).toEqual([]);
    }
  });

  it('retains a positive-polarity match when no negative contraction is present', () => {
    const preference = candidate('positive-access-preference', 'wheelchair-accessible entrances');
    const result = eligibleAutomaticRecallCandidates(
      'Find clinics that have wheelchair-accessible entrances.',
      [preference],
    );
    expect(result.reason).toBe('eligible');
    expect(result.candidates).toEqual([preference]);
  });

  it('normalizes hyphen/open forms but does not equate a closed compound', () => {
    expect(normalizeRecallTokens('warm-up')).toEqual(['warm', 'up']);
    expect(normalizeRecallTokens('cafe\u0301 — bike-route')).toEqual(['café', 'bike', 'route']);
    const candidates = [
      candidate('open', 'warm up routines'),
      candidate('closed', 'warmup routines'),
    ];
    const result = eligibleAutomaticRecallCandidates('Find warm-up routines.', candidates);
    expect(result.candidates).toEqual([candidates[0]]);
  });

  it.each([
    ['Give me a three-item checklist in the order I should do it.', 'three item ordered checklist'],
    ['Give me a 30-minute preparation checklist.', '30 minute preparation checklist'],
  ])(
    'does not treat quantity and output format as a retrieval subject: %s',
    (request, distractor) => {
      const result = eligibleAutomaticRecallCandidates(request, [
        candidate('format-distractor', distractor),
      ]);
      expect(result.candidates).toEqual([]);
    },
  );

  it('does not treat a format-only request as a retrieval subject', () => {
    const result = eligibleAutomaticRecallCandidates('Give me a concise bullet outline.', [
      candidate('distractor', 'concise bullet outline'),
    ]);
    expect(result.reason).toBe('no_request_subject');
    expect(result.candidates).toEqual([]);
  });

  it('preserves a meaningful numeric subject such as a three-room apartment', () => {
    const subject = candidate('apartment', 'three-room apartment near transit');
    const result = eligibleAutomaticRecallCandidates('Find a three-room apartment.', [subject]);
    expect(result.candidates).toEqual([subject]);
  });

  it('recognizes an opinion request with a concrete subject', () => {
    const decision = candidate(
      'daily-check-in',
      'Daily check-in rejected because it interrupted focus',
    );
    const result = eligibleAutomaticRecallCandidates(
      'Do you think a daily check-in makes sense for launch?',
      [decision],
    );
    expect(result.candidates).toEqual([decision]);
  });
});
