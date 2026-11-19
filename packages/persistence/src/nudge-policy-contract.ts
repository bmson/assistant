import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NudgePolicyRepository } from './nudge-policy.js';

export interface NudgePolicyFixture {
  agentId: string;
  repository: NudgePolicyRepository;
  /** Replace the owner's notification preferences; null removes the row. */
  setPrefs(
    prefs: {
      quietStartMin?: number | null;
      quietEndMin?: number | null;
      ambientDailyCap?: number | null;
    } | null,
  ): Promise<void>;
  /** This owner's ledger rows, in any order. */
  pings(): Promise<
    Array<{
      urgency: string;
      channel: string;
      delivered: boolean;
      reason: string | null;
      createdAt: Date;
    }>
  >;
  dispose(): Promise<void>;
}

/**
 * One behavioral suite for the nudge policy, run against both adapters. The
 * cases pin the owner's time zone per test, so quiet hours and the owner-local
 * day are judged by the same clock on PostgreSQL and Firestore.
 */
export function nudgePolicyContract(
  name: string,
  fixture: () => Promise<NudgePolicyFixture>,
  skip = false,
) {
  describe.skipIf(skip)(name, () => {
    let f: NudgePolicyFixture;
    // Reykjavik is UTC year-round, so a fixed UTC clock is also the owner's.
    const utcOwner = () => ({ id: f.agentId, timezone: 'Atlantic/Reykjavik' });
    const MIDDAY = new Date('2026-08-25T12:00:00Z');
    const LATE_NIGHT = new Date('2026-08-25T23:30:00Z');
    const minutesAfter = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.dispose();
    });

    it('delivers everything when no prefs row exists and records the evaluation', async () => {
      await f.setPrefs(null);
      expect(
        await f.repository.evaluate(utcOwner(), { urgency: 'ambient', now: LATE_NIGHT }),
      ).toEqual({ deliver: true });
      expect(await f.pings()).toEqual([
        {
          urgency: 'ambient',
          channel: 'out-of-band',
          delivered: true,
          reason: null,
          createdAt: LATE_NIGHT,
        },
      ]);
    });

    it('never gates an interrupt, even inside quiet hours', async () => {
      await f.setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60, ambientDailyCap: 1 });
      expect(
        await f.repository.evaluate(utcOwner(), {
          urgency: 'interrupt',
          channel: 'sms',
          now: LATE_NIGHT,
        }),
      ).toEqual({ deliver: true });
      expect(await f.pings()).toEqual([
        expect.objectContaining({ urgency: 'interrupt', channel: 'sms', delivered: true }),
      ]);
    });

    it('holds ambient pings inside an overnight quiet window, end exclusive', async () => {
      await f.setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60 });
      const evaluate = (now: Date) =>
        f.repository.evaluate(utcOwner(), { urgency: 'ambient', now });
      expect(await evaluate(LATE_NIGHT)).toEqual({ deliver: false, reason: 'quiet-hours' });
      expect(await evaluate(new Date('2026-08-25T22:00:00Z'))).toEqual({
        deliver: false,
        reason: 'quiet-hours',
      });
      expect(await evaluate(new Date('2026-08-26T06:59:00Z'))).toEqual({
        deliver: false,
        reason: 'quiet-hours',
      });
      expect(await evaluate(new Date('2026-08-26T07:00:00Z'))).toEqual({ deliver: true });
      expect(await evaluate(MIDDAY)).toEqual({ deliver: true });
    });

    it('applies a same-day window in the owner’s own zone', async () => {
      await f.setPrefs({ quietStartMin: 13 * 60, quietEndMin: 15 * 60 });
      const owner = { id: f.agentId, timezone: 'America/Los_Angeles' };
      // 20:30Z is 13:30 in Los Angeles (PDT), 22:00Z is 15:00.
      expect(
        await f.repository.evaluate(owner, {
          urgency: 'ambient',
          now: new Date('2026-08-25T20:30:00Z'),
        }),
      ).toEqual({ deliver: false, reason: 'quiet-hours' });
      expect(
        await f.repository.evaluate(owner, {
          urgency: 'ambient',
          now: new Date('2026-08-25T22:00:00Z'),
        }),
      ).toEqual({ deliver: true });
    });

    it('treats a zero-width or half-set window as off', async () => {
      await f.setPrefs({ quietStartMin: 12 * 60, quietEndMin: 12 * 60 });
      expect(
        (await f.repository.evaluate(utcOwner(), { urgency: 'ambient', now: MIDDAY })).deliver,
      ).toBe(true);
      await f.setPrefs({ quietStartMin: 22 * 60, quietEndMin: null });
      expect(
        (await f.repository.evaluate(utcOwner(), { urgency: 'ambient', now: LATE_NIGHT })).deliver,
      ).toBe(true);
    });

    it('reports quiet hours before the daily cap', async () => {
      await f.setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60, ambientDailyCap: 1 });
      const evaluate = (now: Date) =>
        f.repository.evaluate(utcOwner(), { urgency: 'ambient', now });
      expect(await evaluate(MIDDAY)).toEqual({ deliver: true });
      expect(await evaluate(LATE_NIGHT)).toEqual({ deliver: false, reason: 'quiet-hours' });
      expect(await evaluate(minutesAfter(MIDDAY, 1))).toEqual({
        deliver: false,
        reason: 'daily-cap',
      });
    });

    it('caps ambient pings per day; held pings and interrupts do not spend the budget', async () => {
      await f.setPrefs({ ambientDailyCap: 2 });
      const evaluate = (urgency: 'ambient' | 'interrupt', minutes: number) =>
        f.repository.evaluate(utcOwner(), { urgency, now: minutesAfter(MIDDAY, minutes) });
      expect((await evaluate('interrupt', 0)).deliver).toBe(true);
      expect((await evaluate('ambient', 1)).deliver).toBe(true);
      expect((await evaluate('ambient', 2)).deliver).toBe(true);
      expect(await evaluate('ambient', 3)).toEqual({ deliver: false, reason: 'daily-cap' });
      expect(await evaluate('ambient', 4)).toEqual({ deliver: false, reason: 'daily-cap' });
      expect((await evaluate('interrupt', 5)).deliver).toBe(true);

      const rows = await f.pings();
      expect(rows).toHaveLength(6);
      expect(rows.filter((row) => row.delivered)).toHaveLength(4);
      expect(rows.filter((row) => row.reason === 'daily-cap')).toHaveLength(2);
    });

    it('resets the cap at the owner’s local midnight, not UTC midnight', async () => {
      await f.setPrefs({ ambientDailyCap: 1 });
      const owner = { id: f.agentId, timezone: 'America/Los_Angeles' };
      const evaluate = (iso: string) =>
        f.repository.evaluate(owner, { urgency: 'ambient', now: new Date(iso) });
      // 06:30Z is 23:30 on the 24th in Los Angeles; 07:30Z is 00:30 on the 25th.
      expect((await evaluate('2026-08-25T06:30:00Z')).deliver).toBe(true);
      expect((await evaluate('2026-08-25T07:30:00Z')).deliver).toBe(true);
      expect(await evaluate('2026-08-25T23:59:00Z')).toEqual({
        deliver: false,
        reason: 'daily-cap',
      });
      // 08:00Z on the 26th is 01:00 on the 26th locally: a fresh day.
      expect((await evaluate('2026-08-26T08:00:00Z')).deliver).toBe(true);
    });

    it('reuses the answer-ready reservation and checks quiet hours again before retry', async () => {
      await f.setPrefs({ quietStartMin: 22 * 60, quietEndMin: 7 * 60, ambientDailyCap: 1 });
      const evaluate = (channel: string, now: Date) =>
        f.repository.evaluate(utcOwner(), { urgency: 'ambient', channel, now });
      expect(await evaluate('answer-ready:one', MIDDAY)).toEqual({ deliver: true });
      expect(await evaluate('answer-ready:one', minutesAfter(MIDDAY, 1))).toEqual({
        deliver: true,
      });
      expect(await evaluate('answer-ready:one', LATE_NIGHT)).toEqual({
        deliver: false,
        reason: 'quiet-hours',
      });
      expect(await evaluate('answer-ready:two', LATE_NIGHT)).toEqual({
        deliver: false,
        reason: 'quiet-hours',
      });
      expect(await evaluate('answer-ready:two', minutesAfter(LATE_NIGHT, 8 * 60))).toEqual({
        deliver: false,
        reason: 'quiet-hours',
      });
      expect(await f.pings()).toHaveLength(2);
    });

    it('reserves an ambient-cap slot atomically across concurrent producers', async () => {
      await f.setPrefs({ ambientDailyCap: 1 });
      const decisions = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.repository.evaluate(utcOwner(), { urgency: 'ambient', now: MIDDAY }),
        ),
      );
      expect(decisions.filter((decision) => decision.deliver)).toHaveLength(1);
      expect(decisions.filter((decision) => decision.reason === 'daily-cap')).toHaveLength(3);
      const rows = await f.pings();
      expect(rows).toHaveLength(4);
      expect(rows.filter((row) => row.delivered)).toHaveLength(1);
    });
  });
}
