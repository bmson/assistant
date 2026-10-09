import {
  type Db,
  deviceTokens,
  emailIngest,
  proactiveMoments,
  proactivePings,
} from '@assistant/db';
import type { ProactiveHealthCounts, ProactiveHealthRepository } from '@assistant/persistence';
import { and, count, desc, eq, gte, isNull } from 'drizzle-orm';

/**
 * Is the proactive machinery actually alive?
 *
 * Every part of the anticipation layer is self-silencing by design: with
 * nothing to report the briefing delivers nothing, the pulse says nothing, and
 * curiosity asks nothing. That is the right behaviour and it has one bad
 * property — it looks exactly like a pipeline that is broken. An owner whose
 * mail never reaches the scorer sees the same thing as an owner having a quiet
 * week: silence.
 *
 * The specific failure this exists to name: `EMAIL_INGEST_MODE` defaults to
 * `direct`, which is for people writing *to* the assistant. An owner who sets
 * up a forwarding rule but leaves the mode alone gets their mail dropped as
 * unauthenticated (forwarding breaks SPF alignment) or as automated — the
 * flight confirmations and invoices, precisely the mail carrying the dates.
 * Nothing errors. `email_ingest` simply stays empty, and with it the importance
 * alerts, the briefing's highlights, and every date it would have proposed.
 *
 * So this reports what arrived rather than what is configured. Pure over
 * injected rows; the mode comes in as an argument so core stays free of the
 * module's config helpers.
 */

const RECENT_HOURS = 24;
const WEEK_HOURS = 24 * 7;

export interface ProactiveHealth {
  ingestMode: string;
  /** Messages scored in the last day and the last week. */
  mailScored24h: number;
  mailScored7d: number;
  lastMailAt: Date | null;
  /** Proactive moments the pulse delivered in the last day. */
  momentsDelivered24h: number;
  /** Phone pings attempted, and how many the policy held back. */
  pingsDelivered24h: number;
  pingsHeld24h: number;
  /** Registered, non-invalidated push devices. */
  pushDevices: number;
  /** Owner-facing problems, most important first. Empty means healthy. */
  warnings: string[];
}

export async function assessProactiveHealth(
  storage: Db | ProactiveHealthRepository,
  agentId: string,
  input: { ingestMode: string; googleEnabled: boolean; now?: Date },
): Promise<ProactiveHealth> {
  const now = input.now ?? new Date();
  const window = {
    since24h: new Date(now.getTime() - RECENT_HOURS * 3600_000),
    since7d: new Date(now.getTime() - WEEK_HOURS * 3600_000),
  };
  const counts =
    'kind' in storage && storage.kind === 'proactive-health-repository'
      ? await (storage as ProactiveHealthRepository).counts(agentId, window)
      : await sqlProactiveCounts(storage as Db, agentId, window);
  const health: ProactiveHealth = { ingestMode: input.ingestMode, ...counts, warnings: [] };
  health.warnings = proactiveWarnings(health, input.googleEnabled);
  return health;
}

async function sqlProactiveCounts(
  db: Db,
  agentId: string,
  { since24h, since7d }: { since24h: Date; since7d: Date },
): Promise<ProactiveHealthCounts> {
  const [scored24h, scored7d, latest, moments, pings, devices] = await Promise.all([
    db
      .select({ value: count() })
      .from(emailIngest)
      .where(
        and(
          eq(emailIngest.agentId, agentId),
          eq(emailIngest.pipelineStage, 'complete'),
          gte(emailIngest.createdAt, since24h),
        ),
      ),
    db
      .select({ value: count() })
      .from(emailIngest)
      .where(
        and(
          eq(emailIngest.agentId, agentId),
          eq(emailIngest.pipelineStage, 'complete'),
          gte(emailIngest.createdAt, since7d),
        ),
      ),
    db
      .select({ createdAt: emailIngest.createdAt })
      .from(emailIngest)
      .where(and(eq(emailIngest.agentId, agentId), eq(emailIngest.pipelineStage, 'complete')))
      .orderBy(desc(emailIngest.createdAt))
      .limit(1),
    db
      .select({ value: count() })
      .from(proactiveMoments)
      .where(
        and(eq(proactiveMoments.agentId, agentId), gte(proactiveMoments.deliveredAt, since24h)),
      ),
    db
      .select({ delivered: proactivePings.delivered })
      .from(proactivePings)
      .where(and(eq(proactivePings.agentId, agentId), gte(proactivePings.createdAt, since24h))),
    db
      .select({ value: count() })
      .from(deviceTokens)
      .where(and(eq(deviceTokens.agentId, agentId), isNull(deviceTokens.invalidatedAt))),
  ]);
  return {
    mailScored24h: Number(scored24h[0]?.value ?? 0),
    mailScored7d: Number(scored7d[0]?.value ?? 0),
    lastMailAt: latest[0]?.createdAt ?? null,
    momentsDelivered24h: Number(moments[0]?.value ?? 0),
    pingsDelivered24h: pings.filter((row) => row.delivered).length,
    pingsHeld24h: pings.filter((row) => !row.delivered).length,
    pushDevices: Number(devices[0]?.value ?? 0),
  };
}

/**
 * The warnings, as a pure function of the counts — so the rule that matters
 * ("mail is forwarded here but nothing is being scored") is testable without a
 * database and reads as one paragraph.
 */
export function proactiveWarnings(
  health: Pick<
    ProactiveHealth,
    'ingestMode' | 'mailScored7d' | 'pushDevices' | 'pingsDelivered24h' | 'pingsHeld24h'
  >,
  googleEnabled: boolean,
): string[] {
  const warnings: string[] = [];
  if (googleEnabled && health.ingestMode !== 'forwarded') {
    warnings.push(
      'EMAIL_INGEST_MODE is "direct", so mail forwarded from your own inbox is dropped as ' +
        'unauthenticated or automated and never scored. Nothing will appear in your briefing, ' +
        'and no important-mail alert can fire. Set EMAIL_INGEST_MODE=forwarded if you forward ' +
        'your mail here.',
    );
  } else if (googleEnabled && health.mailScored7d === 0) {
    warnings.push(
      'No mail has been scored in the last week. Check that Gmail sync is on ' +
        '(GMAIL_SYNC_ENABLED) and that your forwarding rule is still delivering.',
    );
  }
  if (health.pushDevices === 0) {
    warnings.push(
      'No push device is registered, so proactive notices only appear when you open the app. ' +
        'Sign in on the iOS app and allow notifications.',
    );
  }
  if (health.pingsHeld24h > 0 && health.pingsDelivered24h === 0) {
    warnings.push(
      `Every phone ping in the last day was held back (${health.pingsHeld24h}). Check quiet ` +
        'hours and the daily cap under Settings → Notifications.',
    );
  }
  return warnings;
}
