import type { OccasionCorrectionDate, OccasionCorrectionInput } from '@assistant/persistence';
import { isOccasionCorrectionDate, sameOccasionContactName } from '@assistant/persistence';
import { explicitlyDisallowsTools } from './conversation-local-context.js';
import type { ActionEvidence } from './response-contract.js';

const command = String.raw`(?:(?:please\s+|(?:can|could|would)\s+you\s+)(?:please\s+)?)?(?:correct|change|move|edit|update|fix)\s+`;
const occasion = String.raw`\b(?:birthday|anniversary|occasion)\b`;
const ownerSubject = String.raw`(?!(?:the|my|our|a|an|this|that)\s)(?![^'’\n]{0,120}\bfor\s)[^;!?\n]{1,120}?`;
const correctionRequest = new RegExp(
  String.raw`^${command}${ownerSubject}['’]s (?:saved [^;!?\n]{0,120})?${occasion}`,
  'i',
);
const exactCorrection = new RegExp(
  `^${command}(${ownerSubject})['’]s (?:saved )?(.{1,120}?) from (.{1,40}?) to (.{1,40}?)[.!?]?$`,
  'i',
);
const deleteCommand = String.raw`(?:(?:please\s+|(?:can|could|would)\s+you\s+)(?:please\s+)?)?(?:delete|remove)\s+`;
const deleteRequest = new RegExp(
  String.raw`^${deleteCommand}${ownerSubject}['’]s (?:saved [^;!?\n]{0,120}${occasion}|${occasion}(?=\s+on\b|[.!?]?$))`,
  'i',
);
const exactDelete = new RegExp(
  `^${deleteCommand}(${ownerSubject})['’]s (?:saved )?(.{1,120}?) on (.{1,40}?)[.!?]?$`,
  'i',
);

export function occasionMutationTool(
  text: string,
): 'occasions.update' | 'occasions.delete' | undefined {
  if (isOccasionCorrectionRequest(text)) return 'occasions.update';
  const request = text.trim();
  if (
    !explicitlyDisallowsTools(request) &&
    !/\b(?:don['’]t|do not|never)\s+(?:delete|remove)\b/i.test(request) &&
    deleteRequest.test(request)
  )
    return 'occasions.delete';
  return undefined;
}

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Direct requests to change a saved occasion, including when a detail needs clarification. */
export function isOccasionCorrectionRequest(text: string): boolean {
  const request = text.trim();
  return (
    !explicitlyDisallowsTools(request) &&
    !/\b(?:don['’]t|do not|never)\s+(?:correct|change|move|edit|update|fix)\b/i.test(request) &&
    correctionRequest.test(request)
  );
}

function parseDate(value: string): OccasionCorrectionDate | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return { month: Number(iso[2]), day: Number(iso[3]), year: Number(iso[1]) };
  const spelled =
    /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4})|\s+(with no year|without a year))?$/i.exec(
      value,
    );
  if (!spelled?.[1]) return undefined;
  const name = spelled[1].toLowerCase();
  const month =
    months.findIndex((m) => m.toLowerCase() === name || m.slice(0, 3).toLowerCase() === name) + 1;
  if (!month) return undefined;
  return {
    month,
    day: Number(spelled[2]),
    ...(spelled[3] ? { year: Number(spelled[3]) } : spelled[4] ? { year: null } : {}),
  };
}

/** Parse only dates and identity supplied by the owner in this turn. */
export function parseOccasionCorrection(
  request: string,
): Omit<OccasionCorrectionInput, 'agentId'> | undefined {
  if (!isOccasionCorrectionRequest(request)) return undefined;
  const match = exactCorrection.exec(request.trim());
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  const label = match[2].trim();
  const kind = label.toLowerCase();
  const expectedDate = parseDate(match[3]);
  const date = parseDate(match[4]);
  if (!expectedDate || !date) return undefined;
  return {
    subject: match[1].trim(),
    ...(kind === 'birthday' || kind === 'anniversary' ? { kind } : { kind: 'custom', label }),
    expectedDate,
    date,
  };
}

type OccasionTarget = Omit<OccasionCorrectionInput, 'agentId' | 'date'>;

export function parseOccasionDeletion(request: string): OccasionTarget | undefined {
  if (occasionMutationTool(request) !== 'occasions.delete') return undefined;
  const match = exactDelete.exec(request.trim());
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const label = match[2].trim();
  const kind = label.toLowerCase();
  const expectedDate = parseDate(match[3]);
  if (!expectedDate) return undefined;
  return {
    subject: match[1].trim(),
    ...(kind === 'birthday' || kind === 'anniversary' ? { kind } : { kind: 'custom', label }),
    expectedDate,
  };
}

function sameDate(left: OccasionCorrectionDate, right: OccasionCorrectionDate): boolean {
  return left.month === right.month && left.day === right.day && left.year === right.year;
}

export function matchesOccasionTarget(owner: OccasionTarget, tool: OccasionTarget): boolean {
  return (
    sameOccasionContactName(owner.subject, tool.subject) &&
    owner.kind === tool.kind &&
    owner.label === tool.label &&
    sameDate(owner.expectedDate, tool.expectedDate)
  );
}

export function matchesOccasionCorrection(
  owner: Omit<OccasionCorrectionInput, 'agentId'>,
  tool: Omit<OccasionCorrectionInput, 'agentId'>,
): boolean {
  return matchesOccasionTarget(owner, tool) && sameDate(owner.date, tool.date);
}

const correctionMessages = {
  ambiguous_contact:
    'I found more than one person with that saved name. Which person did you mean? No date was changed.',
  ambiguous_occasion:
    'More than one saved occasion matches that old date. Please check the entries in People. No date was changed.',
  contact_not_found:
    'I couldn’t find that full saved name in People. What name is the person saved under?',
  date_conflict:
    'That date conflicts with an existing occasion record in People. No date was changed.',
  invalid_date: 'That date isn’t valid. What date should I use?',
  stale_target:
    'The saved occasion changed before I could apply your request. Please check its current details in People.',
  occasion_not_found:
    'I couldn’t find a saved occasion matching that old date. What date is currently saved in People?',
  owner_details_required:
    'Tell me the full saved name and occasion, the old date, and the corrected date. For example, “Change Ada’s birthday from May 7 to May 9.”',
  owner_action_mismatch:
    'The requested change could not be matched to the proposed update. No date was changed.',
  owner_request_required: 'I couldn’t confirm an owner request for that change.',
};
const unconfirmed =
  'I couldn’t confirm that the saved occasion was updated. Check the date in People.';

export function occasionCorrectionReply(
  request: string,
  evidence: ActionEvidence[],
): { text: string; confirmed: boolean } | undefined {
  const tool = occasionMutationTool(request);
  if (!tool) return undefined;
  const deleting = tool === 'occasions.delete';
  const calls = evidence.filter((row) => row.fromCurrentTask !== false && row.toolName === tool);
  for (const row of calls) {
    if (row.status !== 'succeeded') continue;
    const result = row.result as {
      ok?: boolean;
      outcome?: string;
      operationId?: string;
      occasion?: unknown;
    } | null;
    if (!result?.ok || !result.operationId || !result.occasion) continue;
    const saved = result.occasion as {
      id?: string;
      contactId?: string;
      person?: string;
      kind?: string;
      label?: string;
      month?: number;
      day?: number;
      year?: number | null;
    };
    if (
      !saved.id ||
      !saved.contactId ||
      typeof saved.person !== 'string' ||
      typeof saved.month !== 'number' ||
      typeof saved.day !== 'number' ||
      (saved.year !== null && typeof saved.year !== 'number') ||
      !isOccasionCorrectionDate({ month: saved.month, day: saved.day, year: saved.year })
    )
      continue;
    const name = saved.person.replace(/\s+/g, ' ').trim();
    const label =
      (saved.kind === 'custom' ? saved.label : saved.kind)?.replace(/\s+/g, ' ').trim() ||
      'occasion';
    const date = `${months[saved.month - 1]} ${saved.day}${saved.year === null ? '' : `, ${saved.year}`}`;
    if (deleting && result.outcome === 'deleted')
      return { text: `Deleted ${name}’s ${label} on ${date} from People.`, confirmed: true };
    if (!deleting && result.outcome === 'updated')
      return { text: `Updated ${name}’s ${label} in People to ${date}.`, confirmed: true };
    if (!deleting && result.outcome === 'unchanged')
      return { text: `${name}’s ${label} is already saved in People as ${date}.`, confirmed: true };
  }
  const last = calls.at(-1);
  const result = last?.status === 'succeeded' ? (last.result as { outcome?: string } | null) : null;
  const outcome = result?.outcome;
  const knownOutcome =
    outcome && Object.hasOwn(correctionMessages, outcome)
      ? (outcome as keyof typeof correctionMessages)
      : undefined;
  if (deleting) {
    const owner = parseOccasionDeletion(request);
    const text =
      outcome === 'ambiguous_contact'
        ? 'I found more than one person with that saved name. Which person did you mean?'
        : outcome === 'ambiguous_occasion'
          ? 'More than one saved occasion matches that date. Which occasion did you mean?'
          : outcome === 'occasion_not_found'
            ? 'I couldn’t find a saved occasion matching that date. What date is saved in People?'
            : outcome === 'contact_not_found' || outcome === 'stale_target'
              ? correctionMessages[outcome]
              : !owner
                ? 'Tell me the full saved name, occasion, and its saved date.'
                : !isOccasionCorrectionDate(owner.expectedDate)
                  ? 'What valid date is saved for that occasion?'
                  : 'I couldn’t confirm that the saved occasion was deleted. Check the occasion in People.';
    return { text, confirmed: false };
  }
  const owner = parseOccasionCorrection(request);
  const text = knownOutcome
    ? correctionMessages[knownOutcome]
    : !owner
      ? correctionMessages.owner_details_required
      : !isOccasionCorrectionDate(owner.expectedDate) || !isOccasionCorrectionDate(owner.date)
        ? correctionMessages.invalid_date
        : unconfirmed;
  return { text, confirmed: false };
}
