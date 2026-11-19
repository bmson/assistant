import {
  type Db,
  deviceTokens,
  emailIngest,
  emailIngestReadableSql,
  proactiveMoments,
  proactivePings,
} from '@assistant/db';
import {
  type CostRepository,
  EMAIL_EXTRACTION_ALWAYS_ELIGIBLE,
  EMAIL_EXTRACTION_EXCLUDED,
  EMAIL_EXTRACTION_MIN_IMPORTANCE,
  type MailHealthCounts,
  type MailHealthWindow,
  mailExtractionWindowState,
  PENDING_MAIL_ADMISSION_STAGES,
  type ProactiveHealthCounts,
  type ProactiveHealthRepository,
} from '@assistant/persistence';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { classifyDailyBudgetHolds, type DailyBudgetHoldHealth } from '../cost.js';

export {
  assessProactiveCanaries,
  type ProactiveCanaries,
  proactiveCanaryProblems,
} from './canaries.js';

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

export interface ProactiveHealth extends ProactiveHealthCounts {
  ingestMode: string;
  /** Owner-facing problems, most important first. Empty means healthy. */
  warnings: string[];
}

export async function assessProactiveHealth(
  storage: Db | ProactiveHealthRepository,
  agentId: string,
  input: { ingestMode: string; googleEnabled: boolean; now?: Date },
): Promise<ProactiveHealth> {
  const now = input.now ?? new Date();
  const window = mailHealthWindow(now);
  const counts =
    'kind' in storage && storage.kind === 'proactive-health-repository'
      ? await (storage as ProactiveHealthRepository).counts(agentId, window)
      : await sqlProactiveCounts(storage as Db, agentId, window);
  const health: ProactiveHealth = { ingestMode: input.ingestMode, ...counts, warnings: [] };
  health.warnings = proactiveWarnings(health, input.googleEnabled);
  return health;
}

export function mailHealthWindow(now: Date): MailHealthWindow {
  return {
    since6h: new Date(now.getTime() - 6 * 3600_000),
    since24h: new Date(now.getTime() - RECENT_HOURS * 3600_000),
    since7d: new Date(now.getTime() - WEEK_HOURS * 3600_000),
    until: now,
  };
}

export async function sqlMailHealthCounts(
  db: Db,
  agentId: string,
  {
    since6h,
    since24h,
    since7d,
    until = new Date(since24h.getTime() + 24 * 3600_000),
  }: MailHealthWindow,
): Promise<MailHealthCounts> {
  const readable = emailIngestReadableSql();
  const unreadable = sql`${readable} is not true`;
  const stalled = and(unreadable, lt(emailIngest.createdAt, since6h));
  const eligible = and(
    readable,
    notInArray(emailIngest.category, EMAIL_EXTRACTION_EXCLUDED),
    or(
      gte(emailIngest.importance, EMAIL_EXTRACTION_MIN_IMPORTANCE),
      inArray(emailIngest.category, EMAIL_EXTRACTION_ALWAYS_ELIGIBLE),
    ),
  );
  const intake24h = and(
    eligible,
    gte(emailIngest.createdAt, since24h),
    lte(emailIngest.createdAt, until),
  );
  const [mail, latest, completed] = await Promise.all([
    db
      .select({
        mailReceived7d: count(),
        mailScored24h:
          sql<number>`count(*) filter (where ${and(readable, gte(emailIngest.createdAt, since24h))})`.mapWith(
            Number,
          ),
        mailEligibleIntake24h: sql<number>`count(*) filter (where ${intake24h})`.mapWith(Number),
        eligiblePastGrace:
          sql<number>`count(*) filter (where ${and(intake24h, lt(emailIngest.createdAt, since6h), isNull(emailIngest.extractedAt))})`.mapWith(
            Number,
          ),
        mailScored7d: sql<number>`count(*) filter (where ${readable})`.mapWith(Number),
        mailProcessed7d:
          sql<number>`count(*) filter (where ${and(readable, isNotNull(emailIngest.extractedAt))})`.mapWith(
            Number,
          ),
        mailAwaitingAdmissionOver6h7d:
          sql<number>`count(*) filter (where ${and(stalled, inArray(emailIngest.pipelineStage, PENDING_MAIL_ADMISSION_STAGES))})`.mapWith(
            Number,
          ),
        mailFreshIntake7d:
          sql<number>`count(*) filter (where ${and(unreadable, inArray(emailIngest.pipelineStage, PENDING_MAIL_ADMISSION_STAGES), gte(emailIngest.createdAt, since6h))})`.mapWith(
            Number,
          ),
        mailIntakeNeedsReview7d:
          sql<number>`count(*) filter (where ${and(unreadable, eq(emailIngest.pipelineStage, 'needs_attention'))})`.mapWith(
            Number,
          ),
        mailStalledAdmissionByStage: sql<
          MailHealthCounts['mailStalledAdmissionByStage']
        >`jsonb_build_object(
          ${sql.join(
            PENDING_MAIL_ADMISSION_STAGES.map(
              (stage) =>
                sql`${stage}::text, count(*) filter (where ${and(stalled, eq(emailIngest.pipelineStage, stage))})`,
            ),
            sql`, `,
          )}
        )`,
        mailPendingOver6h7d:
          sql<number>`count(*) filter (where ${and(eligible, isNull(emailIngest.extractedAt), lt(emailIngest.createdAt, since6h))})`.mapWith(
            Number,
          ),
      })
      .from(emailIngest)
      .where(and(eq(emailIngest.agentId, agentId), gte(emailIngest.createdAt, since7d))),
    db
      .select({ createdAt: emailIngest.createdAt })
      .from(emailIngest)
      .where(and(eq(emailIngest.agentId, agentId), emailIngestReadableSql()))
      .orderBy(desc(emailIngest.createdAt))
      .limit(1),
    db
      .select({ n: count() })
      .from(emailIngest)
      .where(
        and(
          eq(emailIngest.agentId, agentId),
          eligible,
          gte(emailIngest.extractedAt, since24h),
          lte(emailIngest.extractedAt, until),
        ),
      ),
  ]);
  const counts = mail[0];
  if (!counts) throw new Error('Mail health aggregation returned no result');
  const { eligiblePastGrace, ...tallied } = counts;
  const mailExtractionCompleted24h = completed[0]?.n ?? 0;
  return {
    ...tallied,
    mailExtractionCompleted24h,
    mailExtraction24hState: mailExtractionWindowState(
      tallied.mailEligibleIntake24h,
      mailExtractionCompleted24h,
      eligiblePastGrace,
    ),
    lastMailAt: latest[0]?.createdAt ?? null,
  };
}

export function mailIntakeStallDetails(
  mail: MailHealthCounts | undefined,
  wording: 'health' | 'extraction',
): string[] {
  return PENDING_MAIL_ADMISSION_STAGES.flatMap((stage) => {
    const count = mail?.mailStalledAdmissionByStage[stage] ?? 0;
    return count > 0
      ? [`${count} ${wording === 'extraction' ? 'stuck in' : 'in'} ${stage.replaceAll('_', ' ')}`]
      : [];
  });
}

async function sqlProactiveCounts(
  db: Db,
  agentId: string,
  window: MailHealthWindow,
): Promise<ProactiveHealthCounts> {
  const { since24h } = window;
  const [
    {
      mailStalledAdmissionByStage: _stageCounts,
      mailFreshIntake7d: _fresh,
      mailIntakeNeedsReview7d: _review,
      ...mail
    },
    moments,
    pings,
    devices,
  ] = await Promise.all([
    sqlMailHealthCounts(db, agentId, window),
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
    ...mail,
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
    | 'ingestMode'
    | 'mailScored7d'
    | 'mailPendingOver6h7d'
    | 'mailAwaitingAdmissionOver6h7d'
    | 'pushDevices'
    | 'pingsDelivered24h'
    | 'pingsHeld24h'
  >,
  googleEnabled: boolean,
): string[] {
  const warnings: string[] = [];
  if (googleEnabled && health.ingestMode !== 'forwarded' && health.mailScored7d === 0) {
    warnings.push(
      'EMAIL_INGEST_MODE is "direct", so mail forwarded from your own inbox is dropped as ' +
        'unauthenticated or automated. Set EMAIL_INGEST_MODE=forwarded if you forward ' +
        'your mail here.',
    );
  } else if (googleEnabled && health.mailScored7d === 0) {
    warnings.push(
      'No mail has been scored in the last week. Check that Gmail sync is on ' +
        '(GMAIL_SYNC_ENABLED) and that your forwarding rule is still delivering.',
    );
  }
  if (health.mailAwaitingAdmissionOver6h7d > 0) {
    const count = health.mailAwaitingAdmissionOver6h7d;
    warnings.push(
      `${count} recent ${count === 1 ? 'message is' : 'messages are'} still in intake after six hours.`,
    );
  }
  if (health.mailPendingOver6h7d > 0) {
    const count = health.mailPendingOver6h7d;
    warnings.push(
      `${count} recent ${count === 1 ? 'message has' : 'messages have'} waited over six hours for email processing.`,
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

export async function dailyBudgetHoldHealth(
  readTotals: CostRepository['totals'],
): Promise<DailyBudgetHoldHealth> {
  try {
    return classifyDailyBudgetHolds(await readTotals());
  } catch {
    return 'unavailable';
  }
}
