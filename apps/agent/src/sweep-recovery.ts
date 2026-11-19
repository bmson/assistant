import {
  assertPostgresInstallationOwner,
  createPostgresPulseAdmissionRepository,
  type Db,
  emailBookingOccurrences,
  emailIngest,
} from '@assistant/db';
import {
  decodeRecord,
  documentKey,
  FirestorePulseRepository,
  type InstallationStore,
} from '@assistant/firestore';
import { emailIngestReadable, type Records } from '@assistant/persistence';
import { publicCardText } from '@assistant/persistence/card-privacy';
import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { SweepRecovery } from './sweep-heartbeat.js';
import type { WatchdogEpisode } from './watchdog-episode.js';

const SOURCE_LIMIT = 500;
const DIGEST_LIMIT = 6;
const MIN_IMPORTANCE = 4;

type Mail = Records['emailIngest'];
type Booking = Records['emailBookingOccurrences'];
type Admission = ReturnType<typeof createPostgresPulseAdmissionRepository>;

function inGap(at: Date | null, recovery: SweepRecovery) {
  return at instanceof Date && at.getTime() > recovery.fromMs && at.getTime() <= recovery.toMs;
}

function eligibleMail(mail: Mail[], recovery: SweepRecovery) {
  return mail.filter(
    (row) =>
      row.authenticated === true &&
      emailIngestReadable(row) &&
      inGap(row.providerReceivedAt, recovery),
  );
}

export function composeSweepRecovery(recovery: SweepRecovery, mail: Mail[], bookings: Booking[]) {
  const changed = new Map(
    bookings
      .filter(
        (booking) =>
          booking.sourceAuthenticated === true &&
          inGap(booking.sourceReceivedAt, recovery) &&
          ['cancelled', 'rescheduled'].includes(booking.lifecycle),
      )
      .map((booking) => [booking.sourceChannelMessageId, booking.lifecycle]),
  );
  const items = eligibleMail(mail, recovery)
    .filter((row) => changed.has(row.channelMessageId) || Number(row.importance) >= MIN_IMPORTANCE)
    .sort(
      (a, b) =>
        Number(changed.has(b.channelMessageId)) - Number(changed.has(a.channelMessageId)) ||
        Number(b.importance) - Number(a.importance) ||
        a.channelMessageId.localeCompare(b.channelMessageId),
    );
  const seenThreads = new Set<string>();
  const lines: string[] = [];
  for (const row of items) {
    const dates = (Array.isArray(row.dates) ? row.dates : []) as Array<{
      bookingIdentity?: unknown;
    } | null>;
    const codes = dates.flatMap((date) =>
      typeof date?.bookingIdentity === 'string' && date.bookingIdentity.length >= 3
        ? [date.bookingIdentity]
        : [],
    );
    const raw = row.subject.replace(/\s+/g, ' ').trim();
    // Use each exact subject spelling for known booking codes before the shared
    // card redactor runs. Provider casing can differ from the extracted value.
    const subjectCodes = codes.flatMap((code) => {
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return raw.match(new RegExp(escaped, 'gi')) ?? [];
    });
    const subject = publicCardText(raw, subjectCodes)
      ?.replace(/https?:\/\/[^\s<>]+/gi, '[link hidden]')
      .slice(0, 160);
    if (!subject) continue;
    const thread = row.providerThreadId ?? row.channelMessageId;
    if (seenThreads.has(thread)) continue;
    seenThreads.add(thread);
    const lifecycle = changed.get(row.channelMessageId);
    const label =
      lifecycle === 'cancelled'
        ? 'Booking cancellation'
        : lifecycle === 'rescheduled'
          ? 'Booking rescheduled'
          : 'Important mail';
    lines.push(`- ${label} · ${subject}`);
    if (lines.length === DIGEST_LIMIT) break;
  }
  return [
    'While I was away',
    `Scheduled checks resumed after a gap of ${Math.round((recovery.toMs - recovery.fromMs) / 60_000)} minutes.`,
    'From the authenticated mail available for that period:',
    ...(lines.length
      ? lines
      : ['I found no booking changes or important mail in the records I checked.']),
  ].join('\n');
}

async function publishRecovery(
  admission: Admission,
  agentId: string,
  recovery: SweepRecovery,
  now: Date,
  load: () => Promise<{ mail: Mail[]; bookings: Booking[] }>,
) {
  const observationFence = await admission.observationFence(agentId);
  const { mail, bookings } = await load();
  const key = `sweep-recovery:${recovery.fromMs}`;
  const result = await admission.admitNotice({
    agentId,
    now,
    observationFence,
    pacing: { gapSince: now, windowSince: now, dailyCap: 0 },
    moment: { kind: 'sweep-recovery', key, summary: 'Scheduled checks resumed' },
    notice: { text: composeSweepRecovery(recovery, mail, bookings), extraParts: [] },
  });
  if (result.status !== 'persisted' && result.status !== 'already-said')
    throw new Error('Unexpected recovery notice admission result');
  return result;
}

export async function publishPostgresSweepRecovery(db: Db, recovery: SweepRecovery, now: Date) {
  const agentId = await assertPostgresInstallationOwner(db);
  return publishRecovery(
    createPostgresPulseAdmissionRepository(db),
    agentId,
    recovery,
    now,
    async () => {
      const mail = await db
        .select()
        .from(emailIngest)
        .where(
          and(
            eq(emailIngest.agentId, agentId),
            gt(emailIngest.providerReceivedAt, new Date(recovery.fromMs)),
            lte(emailIngest.providerReceivedAt, new Date(recovery.toMs)),
          ),
        )
        .orderBy(desc(emailIngest.createdAt))
        .limit(SOURCE_LIMIT);
      const sourceIds = eligibleMail(mail, recovery).map((row) => row.channelMessageId);
      const bookings = sourceIds.length
        ? await db
            .select()
            .from(emailBookingOccurrences)
            .where(
              and(
                eq(emailBookingOccurrences.agentId, agentId),
                inArray(emailBookingOccurrences.sourceChannelMessageId, sourceIds),
              ),
            )
        : [];
      return { mail, bookings };
    },
  );
}

export function publishFirestoreSweepRecovery(
  store: InstallationStore,
  agentId: string,
  recovery: SweepRecovery,
  now: Date,
) {
  return publishRecovery(new FirestorePulseRepository(store), agentId, recovery, now, async () => {
    const snapshot = await store
      .collection('emailIngest')
      .where('agentId', '==', agentId)
      .where('createdAt', '>=', new Date(recovery.fromMs))
      .orderBy('createdAt', 'desc')
      .limit(SOURCE_LIMIT)
      .get();
    const mail = snapshot.docs.flatMap((doc) => {
      const row = decodeRecord<Mail>(doc.data());
      return row.agentId === agentId && typeof row.id === 'string' && documentKey(row.id) === doc.id
        ? [row]
        : [];
    });
    const candidates = eligibleMail(mail, recovery);
    if (!candidates.length) return { mail, bookings: [] };
    const sourceIds = new Set(candidates.map((row) => row.channelMessageId));
    const rows = await store
      .collection('emailBookingOccurrences')
      .where('agentId', '==', agentId)
      .limit(2000)
      .get();
    const bookings = rows.docs.flatMap((doc) => {
      const row = decodeRecord<Booking>(doc.data());
      return row.agentId === agentId &&
        typeof row.id === 'string' &&
        documentKey(row.id) === doc.id &&
        sourceIds.has(row.sourceChannelMessageId)
        ? [row]
        : [];
    });
    return { mail, bookings };
  });
}

const OUTAGE_TEXT = {
  sweep: 'Scheduled checks have been unavailable for at least 30 minutes.',
  briefing: 'The daily briefing is overdue. No scheduled briefing has completed within 26 hours.',
};

export async function publishSweepOutage(
  admission: Admission,
  agentId: string,
  episode: WatchdogEpisode,
  notify: (input: {
    text: string;
    conversationId: null;
    urgency: 'interrupt';
    deliveryKey: string;
  }) => Promise<unknown>,
  now = new Date(),
) {
  const { key, reason } = episode;
  const text = OUTAGE_TEXT[reason];
  const observationFence = await admission.observationFence(agentId);
  const result = await admission.admitNotice({
    agentId,
    now,
    observationFence,
    pacing: { gapSince: now, windowSince: now, dailyCap: 0 },
    moment: { kind: 'watchdog-outage', key, summary: text },
    notice: { text, extraParts: [] },
  });
  if (result.status === 'persisted' || result.status === 'already-said') {
    // Persisted notices can outlive a crash before the first push attempt.
    // The per-device outbox claims this stable key and handles safe retries.
    await notify({ text, conversationId: null, urgency: 'interrupt', deliveryKey: key });
  }
  return result.status;
}
