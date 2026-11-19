import { mailExtractionWindowState } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { proactiveWarnings } from './pipeline-health.js';

const healthy = {
  ingestMode: 'forwarded',
  mailScored7d: 120,
  mailAwaitingAdmissionOver6h7d: 0,
  mailPendingOver6h7d: 0,
  pushDevices: 1,
  pingsDelivered24h: 2,
  pingsHeld24h: 0,
};

describe('proactiveWarnings', () => {
  it('says nothing when mail is arriving and the phone is reachable', () => {
    expect(proactiveWarnings(healthy, true)).toEqual([]);
  });

  it('names the direct-mode trap in words, not jargon', () => {
    // The whole point: forwarding set up, mode left at its default, and the
    // symptom is silence rather than an error anywhere.
    const [warning] = proactiveWarnings(
      { ...healthy, ingestMode: 'direct', mailScored7d: 0 },
      true,
    );
    expect(warning).toContain('EMAIL_INGEST_MODE');
    expect(warning).toContain('forwarded');
    expect(warning).toMatch(/dropped/i);
  });

  it('reports a silent mailbox separately from a misconfigured one', () => {
    const warnings = proactiveWarnings({ ...healthy, mailScored7d: 0 }, true);
    expect(warnings.join(' ')).toContain('GMAIL_SYNC_ENABLED');
    // Not both: a direct-mode install already has its explanation.
    expect(
      proactiveWarnings({ ...healthy, ingestMode: 'direct', mailScored7d: 0 }, true),
    ).toHaveLength(1);
  });

  it('stays quiet about mail when Google is not installed at all', () => {
    expect(proactiveWarnings({ ...healthy, ingestMode: 'direct', mailScored7d: 0 }, false)).toEqual(
      [],
    );
  });

  it('reports a stuck intake even when other messages made it through', () => {
    expect(proactiveWarnings({ ...healthy, mailAwaitingAdmissionOver6h7d: 2 }, true)).toEqual([
      '2 recent messages are still in intake after six hours.',
    ]);
  });

  it('shows delayed extraction even when direct mail was successfully admitted', () => {
    expect(
      proactiveWarnings({ ...healthy, ingestMode: 'direct', mailPendingOver6h7d: 1 }, true),
    ).toEqual(['1 recent message has waited over six hours for email processing.']);
    expect(proactiveWarnings({ ...healthy, ingestMode: 'direct' }, true)).toEqual([]);
  });

  it('flags a missing push device, because then proactive means nothing', () => {
    const warnings = proactiveWarnings({ ...healthy, pushDevices: 0 }, true);
    expect(warnings.join(' ')).toMatch(/push device/i);
  });

  it('flags a day in which every ping was held back', () => {
    const warnings = proactiveWarnings({ ...healthy, pingsDelivered24h: 0, pingsHeld24h: 4 }, true);
    expect(warnings.join(' ')).toContain('quiet');
    // One delivered ping is proof the channel works — no warning then.
    expect(proactiveWarnings({ ...healthy, pingsDelivered24h: 1, pingsHeld24h: 4 }, true)).toEqual(
      [],
    );
  });
});

describe('24-hour mail extraction evidence', () => {
  it.each([
    [0, 0, 0, 'no_eligible_mail'],
    [0, 1, 0, 'processed'],
    [1, 0, 0, 'within_grace'],
    [1, 0, 1, 'stalled'],
    [1, null, 1, 'unavailable'],
  ] as const)(
    'classifies intake %s, completions %s and older backlog %s',
    (intake, completed, pastGrace, state) => {
      expect(mailExtractionWindowState(intake, completed, pastGrace)).toBe(state);
    },
  );
});
