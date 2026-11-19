import {
  assertPostgresInstallationOwner,
  calendarEventSnapshots,
  createPostgresPulseAdmissionRepository,
  type Db,
  emailBookingOccurrences,
  emailIngest,
  maintenanceCursors,
  proactiveMoments,
} from '@assistant/db';
import {
  decodeRecord,
  documentKey,
  FirestorePulseRepository,
  type InstallationStore,
} from '@assistant/firestore';
import {
  type CalendarRecoveryObservation,
  calendarRecoveryCursor,
  calendarRecoveryFact,
  calendarRecoveryHash,
  emailIngestReadable,
  type PulseRepository,
  parseCalendarRecovery,
  type Records,
  WATCHDOG_OUTAGE_TEXT,
} from '@assistant/persistence';
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

type CalendarDigestEvidence = {
  covered: boolean;
  changes: Array<CalendarRecoveryObservation & { title?: string; alreadyDelivered: boolean }>;
};
const unavailableCalendar: CalendarDigestEvidence = { covered: false, changes: [] };

function safeLabel(raw: string, codes: string[] = []): string | undefined {
  return publicCardText(raw.replace(/\s+/g, ' ').trim(), codes)
    ?.replace(/https?:\/\/[^\s<>]+/gi, '[link hidden]')
    .slice(0, 160);
}

function bookingFacts(booking: Booking): string[] {
  if (!Array.isArray(booking.dates)) return [];
  const kind = booking.lifecycle === 'cancelled' ? 'cancelled' : 'moved';
  return booking.dates.flatMap((date) => {
    if (
      !date ||
      typeof date.what !== 'string' ||
      typeof date.iso !== 'string' ||
      !['event_start', ...(kind === 'cancelled' ? ['previous_event_start'] : [])].includes(
        date.dateRole,
      )
    )
      return [];
    const fact = calendarRecoveryFact(kind, date.what, date.iso);
    return fact ? [fact] : [];
  });
}

export function composeSweepRecovery(
  recovery: SweepRecovery,
  mail: Mail[],
  bookings: Booking[],
  calendar: CalendarDigestEvidence = unavailableCalendar,
) {
  const changed = new Map(
    bookings
      .filter(
        (booking) =>
          booking.sourceAuthenticated === true &&
          inGap(booking.sourceReceivedAt, recovery) &&
          ['cancelled', 'rescheduled'].includes(booking.lifecycle),
      )
      .map((booking) => [booking.sourceChannelMessageId, booking]),
  );
  const calendarFactCounts = new Map<string, number>();
  for (const change of calendar.changes) {
    if (change.matchingFact)
      calendarFactCounts.set(
        change.matchingFact,
        (calendarFactCounts.get(change.matchingFact) ?? 0) + 1,
      );
  }
  const calendarLines = calendar.changes
    .filter((change) => !change.alreadyDelivered)
    .slice(0, DIGEST_LIMIT)
    .map(
      (change) =>
        `- ${change.kind === 'cancelled' ? 'Calendar cancellation' : 'Calendar move'} · ${safeLabel(change.title ?? '') || 'Calendar event'}`,
    );
  const items = eligibleMail(mail, recovery)
    .filter((row) => {
      const booking = changed.get(row.channelMessageId);
      const facts = booking ? [...new Set(bookingFacts(booking))] : [];
      if (facts.length === 1 && facts[0] && calendarFactCounts.get(facts[0]) === 1) return false;
      return Boolean(booking) || Number(row.importance) >= MIN_IMPORTANCE;
    })
    .sort(
      (a, b) =>
        Number(changed.has(b.channelMessageId)) - Number(changed.has(a.channelMessageId)) ||
        Number(b.importance) - Number(a.importance) ||
        a.channelMessageId.localeCompare(b.channelMessageId),
    );
  const seenThreads = new Set<string>();
  const lines: string[] = [];
  for (const row of items) {
    if (lines.length + calendarLines.length >= DIGEST_LIMIT) break;
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
    const subject = safeLabel(raw, subjectCodes);
    if (!subject) continue;
    const thread = row.providerThreadId ?? row.channelMessageId;
    if (seenThreads.has(thread)) continue;
    seenThreads.add(thread);
    const lifecycle = changed.get(row.channelMessageId)?.lifecycle;
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
    ...(calendarLines.length
      ? ['Confirmed changes in the Calendar observations for the gap:', ...calendarLines]
      : []),
    ...(!calendar.covered
      ? ['No complete Calendar read was recorded during this gap.']
      : calendarLines.length
        ? []
        : [
            'The Calendar observations I checked showed no additional confirmed changes to report.',
          ]),
    ...(lines.length || !calendarLines.length
      ? ['From the authenticated mail available for that period:']
      : []),
    ...(lines.length
      ? lines
      : calendarLines.length
        ? []
        : ['I found no additional booking changes or important mail in the records I checked.']),
  ].join('\n');
}

async function readCalendarRecovery(
  agentId: string,
  recovery: SweepRecovery,
  fence: string | null,
  pulse: Pick<PulseRepository, 'calendarSnapshot' | 'momentKeys'>,
  raw: () => Promise<unknown>,
): Promise<CalendarDigestEvidence> {
  try {
    const history = parseCalendarRecovery(await raw(), fence);
    if (!history) return unavailableCalendar;
    const during = (stamp: number) => stamp > recovery.fromMs && stamp <= recovery.toMs;
    const covered = history.reads.some(during);
    const observed = history.observations.filter((item) => during(item.observedAt));
    if (!observed.length) return { covered, changes: [] };
    const [snapshots, cancelled, moved] = await Promise.all([
      pulse.calendarSnapshot(agentId),
      pulse.momentKeys(agentId, 'calendar-cancelled'),
      pulse.momentKeys(agentId, 'calendar-moved'),
    ]);
    const alreadyDelivered = new Set(
      [...cancelled, ...moved].map((key) => calendarRecoveryHash(key)),
    );
    const titles = new Map(
      snapshots.map((row) => [calendarRecoveryHash(row.calendarId, row.eventId), row.summary]),
    );
    return {
      covered,
      changes: observed.map((item) => ({
        ...item,
        title: titles.get(item.event),
        alreadyDelivered: alreadyDelivered.has(item.moment),
      })),
    };
  } catch {
    console.error('sweep recovery: stored Calendar coverage unavailable');
    return unavailableCalendar;
  }
}

async function publishRecovery(
  admission: Admission,
  agentId: string,
  recovery: SweepRecovery,
  now: Date,
  load: (
    fence: string | null,
  ) => Promise<{ mail: Mail[]; bookings: Booking[]; calendar: CalendarDigestEvidence }>,
) {
  const observationFence = await admission.observationFence(agentId);
  const { mail, bookings, calendar } = await load(observationFence);
  const key = `sweep-recovery:${recovery.fromMs}`;
  const result = await admission.admitNotice({
    agentId,
    now,
    observationFence,
    pacing: { gapSince: now, windowSince: now, dailyCap: 0 },
    moment: { kind: 'sweep-recovery', key, summary: 'Scheduled checks resumed' },
    notice: { text: composeSweepRecovery(recovery, mail, bookings, calendar), extraParts: [] },
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
    async (fence) => {
      const calendarRead = readCalendarRecovery(
        agentId,
        recovery,
        fence,
        {
          calendarSnapshot: (ownerId) =>
            db
              .select()
              .from(calendarEventSnapshots)
              .where(eq(calendarEventSnapshots.agentId, ownerId)),
          momentKeys: async (ownerId, kind) =>
            (
              await db
                .select({ key: proactiveMoments.momentKey })
                .from(proactiveMoments)
                .where(and(eq(proactiveMoments.agentId, ownerId), eq(proactiveMoments.kind, kind)))
            ).map((row) => row.key),
        },
        async () => {
          const [row] = await db
            .select()
            .from(maintenanceCursors)
            .where(eq(maintenanceCursors.name, calendarRecoveryCursor(agentId)));
          return row?.cursor;
        },
      );
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
        .orderBy(desc(emailIngest.providerReceivedAt))
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
      return { mail, bookings, calendar: await calendarRead };
    },
  );
}

export function publishFirestoreSweepRecovery(
  store: InstallationStore,
  agentId: string,
  recovery: SweepRecovery,
  now: Date,
) {
  const pulse = new FirestorePulseRepository(store);
  return publishRecovery(pulse, agentId, recovery, now, async (fence) => {
    const calendarRead = readCalendarRecovery(agentId, recovery, fence, pulse, async () =>
      (await store.doc('maintenanceCursors', calendarRecoveryCursor(agentId)).get()).get('cursor'),
    );
    const snapshot = await store
      .collection('emailIngest')
      .where('agentId', '==', agentId)
      .where('providerReceivedAt', '>', new Date(recovery.fromMs))
      .where('providerReceivedAt', '<=', new Date(recovery.toMs))
      .orderBy('providerReceivedAt', 'desc')
      .limit(SOURCE_LIMIT)
      .get();
    const mail = snapshot.docs.flatMap((doc) => {
      const row = decodeRecord<Mail>(doc.data());
      return row.agentId === agentId && typeof row.id === 'string' && documentKey(row.id) === doc.id
        ? [row]
        : [];
    });
    const candidates = eligibleMail(mail, recovery);
    const sourceIds = [...new Set(candidates.map((row) => row.channelMessageId))];
    const bookings: Booking[] = [];
    // Firestore accepts up to 30 values per 'in' query.
    for (let offset = 0; offset < sourceIds.length; offset += 30) {
      const rows = await store
        .collection('emailBookingOccurrences')
        .where('agentId', '==', agentId)
        .where('sourceChannelMessageId', 'in', sourceIds.slice(offset, offset + 30))
        .get();
      for (const doc of rows.docs) {
        const row = decodeRecord<Booking>(doc.data());
        if (row.agentId === agentId && typeof row.id === 'string' && documentKey(row.id) === doc.id)
          bookings.push(row);
      }
    }
    return { mail, bookings, calendar: await calendarRead };
  });
}

export async function publishSweepOutage(
  admission: Admission,
  agentId: string,
  episode: WatchdogEpisode,
  notify: (input: {
    text: string;
    conversationId: null;
    urgency: 'interrupt';
    purpose: 'watchdog-outage';
    deliveryKey: string;
  }) => Promise<unknown>,
  now = new Date(),
) {
  const { key, reason } = episode;
  const text = WATCHDOG_OUTAGE_TEXT[reason];
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
    await notify({
      text,
      conversationId: null,
      urgency: 'interrupt',
      purpose: 'watchdog-outage',
      deliveryKey: key,
    });
  }
  return result.status;
}
