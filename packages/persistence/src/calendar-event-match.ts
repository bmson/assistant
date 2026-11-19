import type { CalendarOccurrenceIdentity } from './calendar-occurrence.js';

/** Similarity is read-only evidence, never provider identity or permission to change an event. */
export type CalendarMatchCandidate = CalendarOccurrenceIdentity & {
  summary?: unknown;
  description?: unknown;
  location?: unknown;
  organizer?: unknown;
  attendees?: unknown;
  attendeeDetails?: unknown;
  links?: unknown;
  allDay?: unknown;
  status?: unknown;
};

export interface CalendarEventMatchEvidence {
  kind: 'probable' | 'possible';
  signals: Array<
    'title' | 'activity' | 'venue' | 'meeting-link' | 'participants' | 'reference' | 'arrival-time'
  >;
  earlierStartMinutes: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const values = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const intersect = (a: Set<string>, b: Set<string>) => [...a].filter((value) => b.has(value));
const categories = new Set([
  'dentist',
  'medical',
  'therapy',
  'meeting',
  'lesson',
  'practice',
  'game',
  'breakfast',
  'lunch',
  'dinner',
  'birthday',
  'wedding',
  'fundraiser',
  'pickup',
  'dropoff',
  'flight',
  'train',
  'concert',
  'lodging',
]);
const filler = new Set([
  'a',
  'an',
  'the',
  'my',
  'your',
  'our',
  'with',
  'for',
  'at',
  'in',
  'on',
  'and',
  'from',
  'to',
  'of',
  'appointment',
  'appt',
  'reservation',
  'booking',
  'session',
  'weekly',
  'monthly',
  'doctor',
  'dr',
  'checkup',
  'project',
  'arrive',
  'arrival',
  'checkin',
  'boarding',
  'doors',
  'open',
  'start',
  'party',
]);

function titleProfile(value: unknown) {
  const title = normalize(
    text(value)
      .slice(0, 1000)
      .replace(/['’]s\b/g, '')
      .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi, '')
      .replace(/\b(?:1\s*[:/]\s*1|one[- ]on[- ]one)\b/gi, ' meeting '),
  )
    .replace(/\b(?:dental|dentistry)\b/g, 'dentist')
    .replace(/\b(?:check up|checkup|check-up)\b/g, 'checkup')
    .replace(/\b(?:physio|physiotherapy|physical therapy|counselling|counseling)\b/g, 'therapy')
    .replace(/\b(?:medical|physician|gp|consultation)\b/g, 'medical')
    .replace(/\b(?:sync|catch up|catchup|check in|checkin|standup|stand up)\b/g, 'meeting')
    .replace(/\b(?:class|tuition)\b/g, 'lesson')
    .replace(/\b(?:training)\b/g, 'practice')
    .replace(/\b(?:match|fixture)\b/g, 'game')
    .replace(/\b(?:bday|b day)\b/g, 'birthday')
    .replace(/\b(?:gala|fundraising)\b/g, 'fundraiser')
    .replace(/\b(?:hotel|accommodation)\b/g, 'lodging')
    .replace(/\b(?:rail|railway)\b/g, 'train')
    .replace(/\b(?:pick up|pick-up|collect)\b/g, 'pickup')
    .replace(/\b(?:drop off|drop-off)\b/g, 'dropoff')
    .replace(/\b([a-z]{2})\s+(\d{2,4})\b/g, '$1$2');
  const words = new Set(title.split(' ').filter(Boolean));
  const types = new Set([...words].filter((word) => categories.has(word)));
  if (!types.size && ['doctor', 'dr', 'checkup'].some((word) => words.has(word)))
    types.add('medical');
  const names = new Set([...words].filter((word) => !categories.has(word) && !filler.has(word)));
  const numbers = new Set([...names].filter((word) => /\d/.test(word)));
  return { title, names, types, numbers };
}

function place(value: string): string {
  return normalize(value)
    .replace(/\b(?:st|str)\b/g, 'street')
    .replace(/\bave\b/g, 'avenue')
    .replace(/\brd\b/g, 'road')
    .replace(/\bblvd\b/g, 'boulevard')
    .replace(/\bcentre\b/g, 'center')
    .replace(/\bste\b/g, 'suite');
}

function venueProfile(event: CalendarMatchCandidate) {
  const location = text(event.location).slice(0, 2000);
  const aliases =
    /^venue aliases:\s*(.+)$/im.exec(text(event.description).slice(0, 4000))?.[1]?.split('|') ?? [];
  const names = new Set(
    [location.split(/[,\n]/)[0] ?? '', ...aliases]
      .filter((name) => !/^https?:\/\//i.test(name.trim()))
      .map(place)
      .filter(
        (name) =>
          name.length >= 4 &&
          !/^(?:home|office|school|online|zoom|room|tbd|gym|google meet|microsoft teams|video call|virtual|zoom meeting|remote)$/.test(
            name,
          ),
      ),
  );
  for (const name of [...names]) {
    const shorter = name.replace(/\s+(?:clinic|center|school)$/, '');
    if (shorter.split(' ').length >= 2) names.add(shorter);
  }
  const street =
    /\b\d{1,6}\s+[^,\n]+?\b(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way)\b/i.exec(
      location,
    )?.[0];
  const room = /\b(?:room|suite|field|court)\s*#?\s*([\p{L}\p{N}-]+)\b/iu.exec(location)?.[0];
  return { names, street: street ? place(street) : '', room: room ? place(room) : '' };
}

function meetingLinks(event: CalendarMatchCandidate): Set<string> {
  const candidates = [
    text(event.location),
    ...values(event.links).map((link) => text(object(link)?.url)),
  ];
  const links = new Set<string>();
  for (const raw of candidates) {
    for (const match of raw.matchAll(/https?:\/\/[^\s<>"'()]+/gi)) {
      try {
        const url = new URL(match[0]);
        if (url.username || url.password) continue;
        let host = url.hostname.toLowerCase();
        if (host.endsWith('.zoom.us') && /^\/j\/\d+\/?$/.test(url.pathname)) host = 'zoom.us';
        const path = url.pathname.replace(/\/$/, '');
        if (
          (host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(path)) ||
          ((host === 'zoom.us' || host.endsWith('.zoom.us')) &&
            /^\/(?:j\/\d+|my\/[^/]+)$/.test(path)) ||
          (host === 'teams.microsoft.com' && path.startsWith('/l/meetup-join/'))
        )
          links.add(`${host}${path}`);
      } catch {
        /* A malformed provider link is not identity evidence. */
      }
    }
  }
  return links;
}

function participants(event: CalendarMatchCandidate): Set<string> {
  const raw = [
    text(event.organizer),
    ...values(event.attendees).map(text),
    ...values(event.attendeeDetails).map((attendee) => text(object(attendee)?.email)),
  ].join(' ');
  return new Set(raw.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);
}

function references(event: CalendarMatchCandidate): Set<string> {
  const raw = `${text(event.summary)}\n${text(event.description).slice(0, 4000)}`;
  const refs = [
    ...raw.matchAll(
      /\b(?:booking reference|confirmation (?:number|code)|reservation (?:number|code))\s*[:#-]?\s*([a-z0-9-]{5,20})\b/gi,
    ),
  ]
    .map((match) => match[1]?.toLowerCase() ?? '')
    .filter((ref) => /[a-z]/.test(ref) && /\d/.test(ref));
  return new Set(refs);
}

function absolute(value: unknown): number {
  const raw = text(value);
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? Date.parse(raw) : NaN;
}

/** Three-way advisory evidence from independent event facts; missing facts never become a match. */
export function calendarEventMatchEvidence(
  left: CalendarMatchCandidate,
  right: CalendarMatchCandidate,
): CalendarEventMatchEvidence | undefined {
  if (
    !text(left.calendarId) ||
    !text(right.calendarId) ||
    left.calendarId === right.calendarId ||
    left.allDay === true ||
    right.allDay === true ||
    left.status === 'cancelled' ||
    right.status === 'cancelled'
  )
    return;
  // Sparse, unrelated rows are common in dense pair scans. Do not parse timestamps or descriptions for them.
  if (
    left.summary !== right.summary &&
    !left.location &&
    !right.location &&
    !values(left.links).length &&
    !values(right.links).length &&
    !left.organizer &&
    !right.organizer &&
    !values(left.attendees).length &&
    !values(right.attendees).length &&
    !values(left.attendeeDetails).length &&
    !values(right.attendeeDetails).length &&
    !left.description &&
    !right.description
  )
    return;
  // Matchup abbreviations need the dedicated team/opponent matcher, not generic title similarity.
  if (/\s+v(?:s\.?)?\s+/i.test(`${text(left.summary)} ${text(right.summary)}`)) return;
  const a = titleProfile(left.summary);
  const b = titleProfile(right.summary);
  if (!a.title || !b.title) return;
  if (
    a.types.size &&
    b.types.size &&
    (intersect(a.types, b.types).length !== a.types.size || a.types.size !== b.types.size)
  )
    return;
  if (
    a.numbers.size &&
    b.numbers.size &&
    (intersect(a.numbers, b.numbers).length !== a.numbers.size || a.numbers.size !== b.numbers.size)
  )
    return;
  const incompleteNumbers = Boolean(a.numbers.size) !== Boolean(b.numbers.size);
  const commonNames = intersect(a.names, b.names);
  const sameNames =
    commonNames.length > 0 &&
    (commonNames.length === a.names.size || commonNames.length === b.names.size);
  const sameTitle = a.title === b.title && a.title.length >= 4;
  // Two distinct named people, teams, services or subjects must not disappear behind a shared venue/type.
  if (a.names.size && b.names.size && !sameNames) return;
  const matchingType = intersect(a.types, b.types).length > 0;
  const startA = absolute(left.start);
  const startB = absolute(right.start);
  const endA = absolute(left.end);
  const endB = absolute(right.end);
  if (
    ![startA, startB, endA, endB].every(Number.isFinite) ||
    endA <= startA ||
    endB <= startB ||
    Math.max(startA, startB) >= Math.min(endA, endB)
  )
    return;
  const startDifference = Math.abs(startA - startB) / 60_000;
  const endDifference = Math.abs(endA - endB) / 60_000;
  if (startDifference > 90 || endDifference > 90) return;
  const originalA = text(left.originalStartTime);
  const originalB = text(right.originalStartTime);
  if (
    originalA &&
    originalB &&
    (!Number.isFinite(Date.parse(originalA)) || Date.parse(originalA) !== Date.parse(originalB))
  )
    return;
  const venueA = venueProfile(left);
  const venueB = venueProfile(right);
  const venue =
    intersect(venueA.names, venueB.names).length > 0 ||
    Boolean(venueA.street && venueA.street === venueB.street);
  const conflictingPlace = Boolean(
    (venueA.street && venueB.street && venueA.street !== venueB.street) ||
      (venueA.room && venueB.room && venueA.room !== venueB.room),
  );
  const linksA = meetingLinks(left);
  const linksB = meetingLinks(right);
  const meetingLink = intersect(linksA, linksB).length > 0;
  const sharedParticipants = intersect(participants(left), participants(right)).length >= 2;
  const refsA = references(left);
  const refsB = references(right);
  const reference = intersect(refsA, refsB).length > 0;
  if (refsA.size && refsB.size && !reference) return;
  if (linksA.size && linksB.size && !meetingLink && !reference) return;
  const namedVenueConflict =
    !intersect(venueA.names, venueB.names).length &&
    [...venueA.names].some((name) => !/\d/.test(name)) &&
    [...venueB.names].some((name) => !/\d/.test(name));
  if ((conflictingPlace || namedVenueConflict) && !meetingLink && !reference) return;
  const title = sameTitle || (sameNames && (matchingType || commonNames.length >= 2));
  if (!title && !reference) return;
  const independentContext = venue || meetingLink || sharedParticipants || reference;
  if (!independentContext && !sameTitle) return;
  const signals: CalendarEventMatchEvidence['signals'] = [];
  if (title) signals.push('title');
  if (matchingType) signals.push('activity');
  if (venue) signals.push('venue');
  if (meetingLink) signals.push('meeting-link');
  if (sharedParticipants) signals.push('participants');
  if (reference) signals.push('reference');
  const earlier = startA < startB ? left : right;
  const later = earlier === left ? right : left;
  const startRole = (event: CalendarMatchCandidate) =>
    /\b(?:kick[- ]?off|event start|match start|start)\b/i.test(text(event.summary));
  const arrivalRole = (event: CalendarMatchCandidate) =>
    /\b(?:arrival|arrive|boarding|doors open)\b/i.test(text(event.summary));
  if (startDifference > 0 && startRole(earlier) && arrivalRole(later)) return;
  const separateTimeRoles = arrivalRole(earlier) && startRole(later);
  const arrival = /\b(?:arrival|arrive|boarding|doors open)\b/i.test(text(earlier.summary));
  const lead =
    /\b(?:arrival|arrive|check[- ]in)\s*:\s*(\d{1,2})\s+minutes?\s+(?:early|before|in advance)/i.exec(
      text(later.description),
    );
  const arrivalTime =
    endDifference === 0 &&
    startDifference > 0 &&
    (arrival || (lead !== null && Number(lead[1]) === startDifference));
  if (arrivalTime) signals.push('arrival-time');
  const tightTiming =
    startDifference <= 15 &&
    endDifference <= 30 &&
    Math.min(endA - startA, endB - startB) / Math.max(endA - startA, endB - startB) >= 0.7;
  const probable =
    (title || reference) &&
    independentContext &&
    !conflictingPlace &&
    !namedVenueConflict &&
    !separateTimeRoles &&
    (!incompleteNumbers || reference) &&
    Boolean(originalA) === Boolean(originalB) &&
    (tightTiming || (arrivalTime && venue));
  return {
    kind: probable ? 'probable' : 'possible',
    signals,
    earlierStartMinutes: startDifference,
  };
}
