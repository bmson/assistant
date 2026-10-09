import type { ModelRouter } from '@assistant/core';
import { describe, expect, it, vi } from 'vitest';
import {
  bulkByHeaders,
  calibrateImportance,
  type EmailImportance,
  fallbackImportance,
  scoreEmailImportance,
  scoreEmailImportanceOutcome,
  validateBookingLifecycleEvidence,
  validateSecurityEvidence,
} from './email-importance.js';

const payload = (headers: Record<string, string>) => ({
  headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
});

/** A router whose `object` call resolves however the test says. */
function routerReturning(outcome: unknown): ModelRouter {
  return { object: vi.fn().mockResolvedValue(outcome) } as unknown as ModelRouter;
}

describe('bulkByHeaders', () => {
  it('recognises the standard bulk-mail headers', () => {
    expect(bulkByHeaders(payload({ Precedence: 'bulk' }))).toBe(true);
    expect(bulkByHeaders(payload({ Precedence: 'LIST' }))).toBe(true);
    expect(bulkByHeaders(payload({ 'List-Id': '<news.example.com>' }))).toBe(true);
    expect(bulkByHeaders(payload({ 'X-Campaign-Id': 'c-1' }))).toBe(true);
    expect(
      bulkByHeaders(
        payload({ 'List-Id': '<news.example.com>', 'List-Unsubscribe': '<mailto:x@y.com>' }),
      ),
    ).toBe(true);
  });

  it('does not treat ordinary mail as bulk', () => {
    expect(bulkByHeaders(payload({ From: 'anna@example.com', Subject: 'Lunch?' }))).toBe(false);
    expect(bulkByHeaders(undefined)).toBe(false);
  });

  it('does not settle a lone List-Unsubscribe, which transactional senders also set', () => {
    expect(bulkByHeaders(payload({ 'List-Unsubscribe': '<mailto:x@y.com>' }))).toBe(false);
  });
});

describe('scoreEmailImportance', () => {
  it('settles bulk mail from headers without spending a model call', async () => {
    const router = routerReturning({ ok: true, object: { importance: 5 } });
    const score = await scoreEmailImportance(router, {
      from: 'news@example.com',
      subject: 'ONE DAY ONLY',
      body: 'buy things',
      payload: payload({
        'List-Id': '<promos.example.com>',
        'List-Unsubscribe': '<mailto:u@example.com>',
      }),
      contentTrust: 'unknown',
      authenticated: true,
    });

    expect(score.importance).toBe(1);
    expect(score.category).toBe('bulk');
    expect(router.object).not.toHaveBeenCalled();
  });

  // The reported miss: a TripIt itinerary for a hotel booking carries
  // List-Unsubscribe and nothing else, and the header short-circuit scored it
  // bulk/1 with no dates before any classifier read the body — so it never
  // reached triage, the briefing, or memory extraction.
  it('scores a travel confirmation whose only bulk signal is List-Unsubscribe', async () => {
    const router = routerReturning({
      ok: true,
      object: {
        category: 'travel',
        importance: 4,
        actionable: false,
        cardCandidate: true,
        dates: [{ iso: '2026-09-05', what: 'hotel check-in' }],
        reason: 'hotel booking confirmation',
      },
    });
    const score = await scoreEmailImportance(router, {
      from: 'no-reply@tripit.com',
      subject: 'Your TripIt itinerary for Fwd: Hotels.com travel confirmation - Sat, Sep 5',
      body: 'Your itinerary is ready.',
      payload: payload({ 'List-Unsubscribe': '<mailto:u@tripit.com>' }),
      contentTrust: 'unknown',
      authenticated: true,
    });

    expect(router.object).toHaveBeenCalled();
    expect(score.category).toBe('travel');
    // Read and kept, with its dates — but a confirmation asks nothing of the
    // owner, so it lands below the interrupt tier.
    expect(score.importance).toBe(3);
    expect(score.dates).toHaveLength(1);
  });

  it('returns the model score for ordinary mail', async () => {
    const router = routerReturning({
      ok: true,
      object: {
        category: 'travel',
        importance: 4,
        actionable: true,
        dates: [{ iso: '2026-09-01T08:00:00Z', what: 'flight departs' }],
        reason: 'flight confirmation with a departure time',
      },
    });
    const score = await scoreEmailImportance(router, {
      from: 'bookings@airline.example',
      subject: 'Your itinerary',
      body: 'You depart 1 September at 08:00.',
      contentTrust: 'unknown',
      authenticated: true,
    });

    expect(score.importance).toBe(4);
    expect(score.category).toBe('travel');
    expect(score.dates).toHaveLength(1);
  });

  it('falls back without throwing when the model call fails', async () => {
    const router = { object: vi.fn().mockRejectedValue(new Error('provider down')) };
    const score = await scoreEmailImportance(router as unknown as ModelRouter, {
      from: 'anna@example.com',
      subject: 'Lunch?',
      body: 'Are you free Thursday?',
      contentTrust: 'known',
      authenticated: true,
    });
    // A scoring failure must never propagate: it would stall the Gmail history
    // cursor and make Pub/Sub redeliver the burst that broke it.
    expect(score.importance).toBe(3);
    expect(score.reason).toContain('could not be scored');
  });

  it('keeps deterministic fallback distinct from a fallback after a possibly paid call', async () => {
    const deterministic = await scoreEmailImportanceOutcome(
      routerReturning({ ok: false, decision: { mode: 'block', reason: 'budget' } }),
      {
        from: 'stranger@example.com',
        subject: 'hi',
        body: 'hello',
        contentTrust: 'unknown',
        authenticated: true,
      },
    );
    expect(deterministic).toEqual({ kind: 'budget_blocked' });

    const paidUnknown = await scoreEmailImportanceOutcome(
      {
        object: vi.fn().mockRejectedValue(new Error('synthetic provider failure')),
      } as unknown as ModelRouter,
      {
        from: 'anna@example.com',
        subject: 'Lunch?',
        body: 'Are you free Thursday?',
        contentTrust: 'known',
        authenticated: true,
      },
    );
    expect(paidUnknown).toMatchObject({ kind: 'fallback_unknown', score: { importance: 3 } });

    const afterPrimaryAttempt = await scoreEmailImportanceOutcome(
      routerReturning({
        ok: false,
        decision: { mode: 'block', reason: 'fallback budget' },
        attempts: [
          {
            method: 'object',
            role: 'classify',
            selection: 'primary',
            modelId: 'fixture-primary',
            elapsedMs: 1,
            outcome: 'failed',
            failureKind: 'transient_provider',
            fallbackAttempted: false,
          },
        ],
      }),
      {
        from: 'anna@example.com',
        subject: 'Lunch?',
        body: 'Are you free Thursday?',
        contentTrust: 'known',
        authenticated: true,
      },
    );
    expect(afterPrimaryAttempt).toMatchObject({
      kind: 'fallback_unknown',
      score: { importance: 3 },
    });
  });

  it('falls back when the router reports a failed outcome', async () => {
    const score = await scoreEmailImportance(routerReturning({ ok: false, reason: 'budget' }), {
      from: 'stranger@example.com',
      subject: 'hi',
      body: 'hello',
      contentTrust: 'unknown',
      authenticated: false,
    });
    expect(score.importance).toBe(2);
  });
});

describe('calibrateImportance', () => {
  const scored = (overrides: Partial<EmailImportance> = {}): EmailImportance => ({
    category: 'security',
    importance: 5,
    actionable: true,
    nextStep: 'Check the new sign-in',
    dates: [],
    reason: 'internal',
    ...overrides,
  });

  // The reported pattern: linking one app produced a burst of "you connected",
  // "you asked us to share" and "new app linked" notices from several senders,
  // each scored as a security alert and each buzzing the phone.
  it('holds a notice that says no action is needed below the interrupt tier', () => {
    const score = calibrateImportance(
      scored(),
      "ChatGPT connected to your account. If this was you, you're all set and no further action is required.",
    );
    expect(score.importance).toBe(3);
    expect(score.actionable).toBe(false);
    expect(score.nextStep).toBeUndefined();
  });

  it('holds non-actionable mail at 3 however the model scored it', () => {
    expect(
      calibrateImportance(scored({ actionable: false, importance: 5 }), 'Payment received.')
        .importance,
    ).toBe(3);
  });

  it('leaves actionable mail and lower scores alone', () => {
    const body = 'Could you send over your availability for next week?';
    expect(calibrateImportance(scored({ category: 'personal' }), body)).toMatchObject({
      importance: 5,
      actionable: true,
      nextStep: 'Check the new sign-in',
    });
    expect(calibrateImportance(scored({ actionable: false, importance: 2 }), body).importance).toBe(
      2,
    );
  });

  it('keeps the owner-facing next step short and on one line', () => {
    const score = calibrateImportance(
      scored({ nextStep: `Reply\nwith ${'several words '.repeat(12)}.` }),
      'Please reply.',
    );
    expect(score.nextStep?.length).toBeLessThanOrEqual(80);
    expect(score.nextStep).not.toContain('\n');
    expect(calibrateImportance(scored({ nextStep: '  ' }), 'Please reply.').nextStep).toBe(
      undefined,
    );
  });
});

describe('fallbackImportance', () => {
  it('surfaces verified known senders and stays quiet about everyone else', () => {
    // Erring toward "triage everything" would turn a model outage into a budget
    // incident; erring toward silence would swallow the owner's mail. So the
    // fallback leans on what is knowable without a model.
    expect(fallbackImportance({ contentTrust: 'known', authenticated: true }).importance).toBe(3);
    expect(fallbackImportance({ contentTrust: 'owner', authenticated: true }).importance).toBe(3);
    expect(fallbackImportance({ contentTrust: 'known', authenticated: false }).importance).toBe(2);
    expect(fallbackImportance({ contentTrust: 'unknown', authenticated: true }).importance).toBe(2);
  });
});

describe('source-backed booking lifecycle extraction', () => {
  const source =
    'Reservation R-314 is confirmed for October 12 in Europe/Berlin. Free cancellation until October 10.';
  const candidate = (overrides: Partial<EmailImportance['dates'][number]> = {}) =>
    validateBookingLifecycleEvidence(
      {
        category: 'travel',
        importance: 3,
        actionable: false,
        dates: [
          {
            iso: '2026-10-12',
            what: 'spa booking',
            dateRole: 'event_start',
            precision: 'date',
            civilDate: '2026-10-12',
            sourceTimeZone: 'Europe/Berlin',
            lifecycle: 'confirmed',
            bookingIdentity: 'R-314',
            dateEvidence: 'Reservation R-314 is confirmed for October 12 in Europe/Berlin',
            statusEvidence: 'Reservation R-314 is confirmed',
            ...overrides,
          },
        ],
        reason: 'source-backed booking',
      },
      source,
      true,
    ).dates[0];

  it('retains explicit booking identity, lifecycle evidence, date precision, and source timezone', () => {
    expect(candidate()).toMatchObject({
      dateRole: 'event_start',
      precision: 'date',
      civilDate: '2026-10-12',
      sourceTimeZone: 'Europe/Berlin',
      lifecycle: 'confirmed',
      bookingIdentity: 'R-314',
    });
  });

  it('drops unquoted timezone and date roles when source evidence does not support them', () => {
    expect(
      candidate({
        sourceTimeZone: 'Europe/Berlin',
        dateEvidence: 'Reservation R-314 is confirmed for October 12',
      }),
    ).toMatchObject({ dateRole: 'event_start', precision: 'date', sourceTimeZone: undefined });
    expect(candidate({ dateEvidence: undefined, sourceTimeZone: undefined })).toMatchObject({
      dateRole: 'unknown',
      precision: 'unknown',
      civilDate: undefined,
    });
  });

  it('does not treat conditional free cancellation as an already-cancelled booking', () => {
    expect(
      candidate({
        iso: '2026-10-10',
        what: 'free cancellation deadline',
        dateRole: 'cancellation_deadline',
        lifecycle: 'cancelled',
        dateEvidence: 'Free cancellation until October 10',
        statusEvidence: 'Free cancellation until October 10',
      }),
    ).toMatchObject({ lifecycle: 'unknown', bookingIdentity: undefined });
  });

  it('keeps a lifecycle unknown when its identity is absent or the source is unauthenticated', () => {
    const score = {
      category: 'travel' as const,
      importance: 3,
      actionable: false,
      dates: [
        {
          iso: '2026-10-12',
          what: 'spa booking',
          dateRole: 'event_start' as const,
          precision: 'date' as const,
          lifecycle: 'confirmed' as const,
          bookingIdentity: 'R-314',
          dateEvidence: 'Reservation R-314 is confirmed for October 12 in Europe/Berlin',
          statusEvidence: 'Reservation R-314 is confirmed',
        },
      ],
      reason: 'test',
    };
    expect(validateBookingLifecycleEvidence(score, source, false).dates[0]?.lifecycle).toBe(
      'unknown',
    );
    const originalDate = score.dates.at(0);
    if (!originalDate) throw new Error('booking date fixture is missing');
    expect(
      validateBookingLifecycleEvidence(
        { ...score, dates: [{ ...originalDate, bookingIdentity: 'R-999' }] },
        source,
        true,
      ).dates[0]?.lifecycle,
    ).toBe('unknown');
  });

  it('preserves only explicitly quoted security incident fields from authenticated source mail', async () => {
    const body =
      'Security alert A-77: A sign-in to alex@example.com from Pixel 9 in Berlin at 09:40 CEST. Recovery copy of A-70.';
    const score = {
      category: 'security' as const,
      importance: 5,
      actionable: true,
      dates: [],
      reason: 'security alert',
      securityEvidence: {
        providerIncidentRef: 'A-77',
        eventType: 'sign_in' as const,
        affectedAccount: 'alex@example.com',
        eventAt: '09:40 CEST',
        device: 'Pixel 9',
        location: 'Berlin',
        recoveryCopyOf: 'A-70',
        evidenceQuote: body,
      },
    };
    expect(validateSecurityEvidence(score, body, true, 'security').securityEvidence).toMatchObject({
      providerIncidentRef: 'A-77',
      eventType: 'sign_in',
      affectedAccount: 'alex@example.com',
      eventAt: '09:40 CEST',
      device: 'Pixel 9',
      location: 'Berlin',
      recoveryCopyOf: 'A-70',
    });
    expect(validateSecurityEvidence(score, body, false, 'security').securityEvidence).toBeNull();
    expect(
      validateSecurityEvidence(
        { ...score, securityEvidence: { ...score.securityEvidence, location: 'Paris' } },
        body,
        true,
        'security',
      ).securityEvidence,
    ).not.toMatchObject({ location: 'Paris' });
  });
});
