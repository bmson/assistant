import { extractOwnerIntent, ownerIntentPlannerSegments } from './owner-intent.js';
import type { ActionEvidence } from './response-contract.js';

type Operation = 'remove' | 'forget' | 'edit';
type Target =
  | 'reminder'
  | 'calendar'
  | 'watch'
  | 'document'
  | 'memory'
  | 'file'
  | 'conversation'
  | 'contact'
  | 'occasion'
  | 'message'
  | 'unknown';
type Mutation = {
  operation: Operation;
  target: Target;
  terms: string;
  identityCandidate: string;
  change?: string;
  replaceFrom?: string;
};
type Receipt = {
  operation: Operation;
  target: Target;
  identity: string;
  name: string;
  change?: string;
  replaceFrom?: string;
};

const COMMAND =
  'cancel|delete|remove|forget|erase|edit|update|rename|change|replace|reschedule|move';
const COMPLETED =
  'cancelled|canceled|deleted|removed|forgot|forgotten|erased|edited|updated|renamed|changed|replaced|rescheduled|moved';
const DIRECT = new RegExp(
  String.raw`^(?:please\s+|(?:can|could|would|will) you(?: please)?\s+|i (?:want|need) you to\s+)?(${COMMAND})\s+(.+)`,
  'i',
);
const ASSERTION = new RegExp(
  String.raw`^(?:(?:yes|sure|okay|ok|done|all set)[,.!:\s—-]+)*(?:(?:i|we)(?:(?:['’](ll|ve)|\s+(will|have|just|already|am|are))?\s+)(?:already\s+|just\s+|going to\s+|went ahead and\s+)?(${COMMAND}|${COMPLETED})|(\b(?:${COMPLETED})))(?:\b|:)[\s:—-]*(.*)`,
  'i',
);
const TERSE = /^(?:done|all set|handled|taken care of|successfully completed)[.! ]*$/i;
const PASSIVE = new RegExp(
  `^(.{1,220}?)\\s+(?:was|is|has (?:now )?been|have (?:now )?been|got)\\s+(?:successfully\\s+)?(${COMPLETED})[.! ]*$`,
  'i',
);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function operation(verb: string): Operation {
  if (/^(?:forget|forgot|erase)/i.test(verb)) return 'forget';
  if (/^(?:cancel|delete|remove)/i.test(verb)) return 'remove';
  return 'edit';
}

function target(text: string): Target {
  if (/\breminders?\b/i.test(text)) return 'reminder';
  if (/\b(?:watch|monitor|tracker)s?\b/i.test(text)) return 'watch';
  if (/\b(?:calendar|events?|appointments?|meetings?)\b/i.test(text)) return 'calendar';
  if (/\b(?:documents?|docs?)\b|docs\.google\.com/i.test(text)) return 'document';
  if (/\b(?:memory|memories|remembered|saved facts?)\b/i.test(text)) return 'memory';
  if (/\bfiles?\b/i.test(text)) return 'file';
  if (/\b(?:conversation|chat|thread)s?\b/i.test(text)) return 'conversation';
  if (/\bcontacts?\b/i.test(text)) return 'contact';
  if (/\boccasions?\b/i.test(text)) return 'occasion';
  if (/\b(?:messages?|emails?)\b/i.test(text)) return 'message';
  return 'unknown';
}

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function targetName(text: string, kind: Target): string {
  const name = text.replace(/\b(?:please|now|right away|for me)\s*[.!?]*$/i, '');
  const noun = {
    reminder: /^reminders?$/,
    watch: /^(?:watch|monitor|tracker)s?$/,
    calendar: /^(?:calendar|events?|appointments?|meetings?)$/,
    document: /^(?:google|documents?|docs?)$/,
    memory: /^(?:memory|memories)$/,
    file: /^files?$/,
    conversation: /^(?:conversation|chat|thread)s?$/,
    contact: /^contacts?$/,
    occasion: /^occasions?$/,
    message: /^(?:messages?|emails?)$/,
    unknown: /^$/,
  }[kind];
  return name
    .trim()
    .split(/\s+/)
    .filter((raw) => {
      const word = normalize(raw);
      return (
        !noun.test(word) &&
        !/^(?:the|my|your|that|this|for|from|to|named|called|it|them)$/i.test(word)
      );
    })
    .join(' ')
    .replace(/^[“"]|[.!?]*[”"]?$|[.!?]+$/g, '')
    .trim();
}

function targetTerms(text: string, kind: Target): string {
  return normalize(targetName(text, kind));
}

function describe(verb: string, object: string, fallback: Target = 'unknown'): Mutation {
  const effect = operation(verb);
  const kind = target(object);
  const resolved = kind === 'unknown' ? fallback : kind;
  // Require a concrete edit value. A tool that touched the same object is
  // insufficient evidence that it made the requested edit.
  const edit = effect === 'edit' ? /^(.+?)(?:\s+from\s+(.+?))?\s+to\s+(.+)$/i.exec(object) : null;
  const name = edit?.[1] ?? object;
  const literal = (value: string | undefined) =>
    value
      ?.trim()
      .replace(/[.!?]$/, '')
      .replace(/^[“"]|[”"]$/g, '');
  return {
    operation: effect,
    target: resolved,
    terms: targetTerms(name, resolved),
    identityCandidate:
      (resolved === 'document' &&
        /https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/.exec(name)?.[1]) ||
      targetName(name, resolved),
    change: literal(edit?.[3]),
    replaceFrom: literal(edit?.[2]),
  };
}

function requests(text: string): Mutation[] {
  // Keep balanced inline literals available as targets, but never treat a
  // quote or forwarded body as an instruction from the owner.
  const intent = extractOwnerIntent({ text, trust: 'owner' });
  if (intent.separation === 'unknown') return [];
  const parts = ownerIntentPlannerSegments(text, intent);
  const literals: string[] = [];
  const authored =
    parts
      ?.map((part) => {
        if (part.kind === 'owner_text') return part.text;
        literals.push(part.value);
        return `__literal${literals.length - 1}__`;
      })
      .join('') ?? intent.ownerAuthoredText;
  return authored
    .split(new RegExp(String.raw`\n+|[;!?]|\.\s+|\s+and\s+(?=(?:${COMMAND})\b)`, 'i'))
    .flatMap((sentence) => {
      const match = DIRECT.exec(sentence.trim().replace(/^[-*+]\s+/, ''));
      if (!match?.[1] || !match[2]) return [];
      const verb = match[1];
      const object = match[2].replace(
        /__literal(\d+)__/g,
        (_, index: string) => `"${literals[Number(index)] ?? ''}"`,
      );
      const kind = target(object);
      if (
        kind === 'unknown' &&
        operation(verb) === 'edit' &&
        /^(?:(?:this|that|the)\s+)?(?:sentence|paragraph|wording|tone|draft|reply)\b/i.test(object)
      )
        return [];
      if (
        /^(?:forget (?:about it|it|what i just said)|change (?:your mind|the subject)|move on)$/i.test(
          `${verb} ${object}`.replace(/[.!?]$/, ''),
        )
      )
        return [];
      return [describe(verb, object, kind)];
    });
}

/** A tool-less response to this request must be checked before streaming. */
export function requestsDurableMutation(text: string): boolean {
  return requests(text).length > 0;
}

function currentRows(evidence: readonly ActionEvidence[]): ActionEvidence[] {
  return evidence.filter((row) => row.fromCurrentTask !== false);
}

function namesForCalendar(
  evidence: readonly ActionEvidence[],
  id: string,
  result: Record<string, unknown>,
): string {
  // A named event is resolved from an exact event ID, never from another
  // event's summary or the model's requested mutation arguments.
  const names = new Set<string>();
  const namesOfOtherEvents = new Set<string>();
  for (const row of evidence) {
    if (
      row.status !== 'succeeded' ||
      !/^calendar\.(?:list_events|search_events)$/.test(row.toolName)
    )
      continue;
    const events = record(row.result).events;
    if (!Array.isArray(events)) continue;
    for (const item of events) {
      const event = record(item);
      const eventId = string(event.eventId ?? event.id);
      const name = string(event.summary);
      if (!eventId || !name) continue;
      if (eventId === id) names.add(name);
      else namesOfOtherEvents.add(normalize(name));
    }
  }
  const name =
    names.size === 1 ? ([...names][0] ?? '') : names.size === 0 ? string(result.summary) : '';
  return namesOfOtherEvents.has(normalize(name)) ? '' : name;
}

function mutationReceipts(evidence: readonly ActionEvidence[]): Receipt[] {
  return evidence.flatMap((row): Receipt[] => {
    const result = record(row.result);
    const args = record(row.args);
    if (
      row.status !== 'succeeded' ||
      result.ok === false ||
      result.deliveryStatus === 'unknown' ||
      (typeof result.status === 'number' && result.status >= 400)
    )
      return [];
    if (row.toolName === 'reminder.cancel' && result.cancelled === true) {
      const identity = string(result.reminderId);
      if (identity && (!args.reminderId || args.reminderId === identity))
        return [{ operation: 'remove', target: 'reminder', identity, name: string(result.text) }];
    }
    if (row.toolName === 'watch.cancel' && result.cancelled === true) {
      const identity = string(result.watchId);
      if (identity && identity === args.watchId)
        return [{ operation: 'remove', target: 'watch', identity, name: '' }];
    }
    if (/^calendar\.cancel_(?:event|booking_event)$/.test(row.toolName)) {
      const identity = string(result.cancelled);
      if (identity && identity === args.eventId)
        return [
          {
            operation: 'remove',
            target: 'calendar',
            identity,
            name: namesForCalendar(evidence, identity, result),
          },
        ];
    }
    if (row.toolName === 'calendar.update_event' && result.updated === true) {
      const identity = string(result.eventId);
      if (identity && identity === args.eventId)
        return [
          {
            operation: 'edit',
            target: 'calendar',
            identity,
            name: namesForCalendar(evidence, identity, result),
            change:
              typeof result.summary === 'string' && result.summary === args.summary
                ? result.summary
                : undefined,
          },
        ];
    }
    if (row.toolName === 'docs.replace_text' && result.updated === true) {
      const identity = string(result.documentId);
      const replacements = result.replacements;
      if (
        identity &&
        identity === args.documentId &&
        Array.isArray(replacements) &&
        replacements.length === 1 &&
        Array.isArray(args.replacements) &&
        args.replacements.length === 1
      ) {
        const executed = record(replacements[0]);
        const requested = record(args.replacements[0]);
        if (
          typeof executed.occurrencesChanged === 'number' &&
          executed.occurrencesChanged > 0 &&
          typeof executed.oldText === 'string' &&
          typeof executed.newText === 'string' &&
          executed.oldText === requested.oldText &&
          executed.newText === requested.newText
        ) {
          return [
            {
              operation: 'edit',
              target: 'document',
              identity,
              name: '',
              change: executed.newText,
              replaceFrom: executed.oldText,
            },
          ];
        }
      }
    }
    return [];
  });
}

function matches(mutation: Mutation, receipt: Receipt): boolean {
  return (
    mutation.operation === receipt.operation &&
    (mutation.target === receipt.target || mutation.target === 'unknown') &&
    Boolean(mutation.terms) &&
    (mutation.operation !== 'edit' ||
      (mutation.change !== undefined &&
        mutation.change === receipt.change &&
        (receipt.target !== 'document' || mutation.replaceFrom === receipt.replaceFrom))) &&
    (mutation.identityCandidate === receipt.identity ||
      mutation.terms === normalize(receipt.name) ||
      mutation.terms === targetTerms(receipt.name, receipt.target))
  );
}

function label(mutation: Mutation): string {
  return mutation.operation === 'forget'
    ? 'the requested removal from memory'
    : mutation.target === 'unknown'
      ? 'the requested change'
      : `the requested ${mutation.target} ${mutation.operation === 'edit' ? 'edit' : 'removal'}`;
}

function describesDraft(text: string): boolean {
  return /^(?:please\s+|(?:can|could|would) you\s+)?(?:write|draft|compose|translate|rewrite|rephrase|summari[sz]e|quote|explain|how (?:can|do|would|should) (?:i|we))\b/i.test(
    text.trim(),
  );
}

/** Guard terminal first-person claims and acknowledgements against this turn's durable receipts. */
export function guardMutationReply(
  text: string,
  admittedText: string,
  evidence: readonly ActionEvidence[],
  pendingApprovalToolCallIds: ReadonlySet<string> = new Set(),
): { text: string; blocked: boolean } | undefined {
  const intended = requests(admittedText);
  if (!intended.length && describesDraft(admittedText)) return;
  const rows = currentRows(evidence);
  const receipts = mutationReceipts(rows);
  const awaitingApproval = intended.some((item) =>
    rows.some((row) => {
      if (!row.id || !pendingApprovalToolCallIds.has(row.id) || row.status !== 'awaiting_approval')
        return false;
      const args = record(row.args);
      if (
        item.operation === 'remove' &&
        item.target === 'reminder' &&
        row.toolName === 'reminder.cancel'
      )
        return item.terms === targetTerms(string(args.query ?? args.reminderId), item.target);
      if (
        item.operation === 'remove' &&
        item.target === 'calendar' &&
        /^calendar.cancel_/.test(row.toolName)
      ) {
        const identity = string(args.eventId);
        return (
          identity &&
          matches(item, {
            operation: 'remove',
            target: 'calendar',
            identity,
            name: namesForCalendar(rows, identity, {}),
          })
        );
      }
      if (
        item.operation === 'edit' &&
        item.target === 'document' &&
        row.toolName === 'docs.replace_text'
      ) {
        const replacement =
          Array.isArray(args.replacements) && args.replacements.length === 1
            ? record(args.replacements[0])
            : {};
        return matches(item, {
          operation: 'edit',
          target: 'document',
          identity: string(args.documentId),
          name: '',
          change: string(replacement.newText),
          replaceFrom: string(replacement.oldText),
        });
      }
      return false;
    }),
  );
  const unverified = intended.filter((item) => !receipts.some((receipt) => matches(item, receipt)));
  const stripped = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  const clauses = stripped.split(/\n+|(?<=[.!?;])\s+/);
  const claims = clauses.flatMap<{ future: boolean; mutation?: Mutation }>((line) => {
    const compact = line
      .trim()
      .replace(/^[-*+]\s+/, '')
      .replace(/\*\*/g, '');
    if (!compact || /^[>“"`]/.test(compact)) return [];
    if (TERSE.test(compact) && intended.length) return [{ future: false }];
    if (
      intended.length &&
      /^(?:i|we)(?:['’]ll| will) (?:take care of|handle) (?:it|that|this)[.! ]*$/i.test(compact)
    )
      return [{ future: true }];
    const passive = PASSIVE.exec(compact);
    if (intended.length && passive?.[1] && passive[2])
      return [{ future: false, mutation: describe(passive[2], passive[1]) }];
    const match = ASSERTION.exec(compact);
    const verb = match?.[3] ?? match?.[4];
    if (!match || !verb) return [];
    const object = match[5] ?? '';
    if (!intended.length && match[4] && /\b(?:are|can|may|would|will)\b/i.test(object)) return [];
    if (
      /^(?:forget|forgot) (?:about it|it)|^change(?:d)? (?:my|our) mind|^move(?:d)? on/i.test(
        `${verb} ${object}`,
      ) &&
      intended.length === 0
    )
      return [];
    const future = Boolean(
      match[1] === 'll' ||
        /^(?:will|am|are)$/i.test(match[2] ?? '') ||
        (!match[4] && new RegExp(`^(?:${COMMAND})$`, 'i').test(verb)),
    );
    // "I'll change that sentence" is ordinary writing advice when no stored
    // target or actual mutation was requested.
    if (!intended.length && /\b(?:sentence|wording|tone|paragraph|draft)\b/i.test(object))
      return [];
    return [{ future, mutation: describe(verb, object) }];
  });
  const claimsApproval =
    /\b(?:awaiting|waiting (?:on|for)|pending|sent for|requested) (?:your )?approval\b|\bapprove (?:it |this )?(?:in|on) (?:the )?approvals\b/i.test(
      stripped,
    );
  if (!claims.length && !(claimsApproval && intended.length)) return;
  if (awaitingApproval && (claimsApproval || claims.some(({ future }) => future))) {
    return {
      text: 'The requested change is awaiting your approval. No change has been confirmed. Review it in Approvals.',
      blocked: true,
    };
  }
  const unsafe =
    claimsApproval ||
    claims.some(({ mutation }) => {
      if (!mutation) return unverified.length > 0;
      const matching = intended.filter(
        (item) =>
          item.operation === mutation.operation &&
          (mutation.target === 'unknown' || item.target === mutation.target),
      );
      return (
        matching.length !== 1 ||
        !receipts.some(
          (receipt) =>
            matching[0] !== undefined &&
            matches(matching[0], receipt) &&
            (!mutation.terms || matches(mutation, receipt)),
        )
      );
    });
  if (!unsafe && !claims.some(({ future, mutation }) => future || mutation?.operation === 'edit'))
    return;
  if (!unsafe && intended.length > 0) {
    return {
      text: intended.map((item) => `I confirmed ${label(item)}.`).join(' '),
      blocked: false,
    };
  }
  // Prefer a truthful, usable choice-list for ambiguous reminder matches.
  // This existing path is narrowly bound to the same requested reminder.
  const ambiguous =
    intended.length === 1 &&
    intended[0]?.target === 'reminder' &&
    rows.some(
      (row) =>
        row.toolName === 'reminder.cancel' &&
        row.status === 'succeeded' &&
        record(row.result).cancelled === false &&
        record(row.result).reason === 'ambiguous' &&
        targetTerms(string(record(row.args).query), 'reminder') === intended[0]?.terms,
    );
  if (ambiguous) {
    const row = rows.find(
      (candidate) =>
        candidate.toolName === 'reminder.cancel' &&
        record(candidate.result).reason === 'ambiguous' &&
        targetTerms(string(record(candidate.args).query), 'reminder') === intended[0]?.terms,
    );
    const options = record(row?.result).matches;
    const names = Array.isArray(options)
      ? options
          .flatMap((option) => {
            const name = string(record(option).text).replace(/\s+/g, ' ').slice(0, 160);
            return name ? [name] : [];
          })
          .slice(0, 5)
      : [];
    return {
      text: `More than one reminder matches. No removal was confirmed.${names.length ? `\n${names.map((name) => `- ${name}`).join('\n')}` : ''}\nWhich reminder should I remove?`,
      blocked: true,
    };
  }
  const confirmed = intended.filter((item) => !unverified.includes(item));
  const unresolved = unverified;
  return {
    text: [
      ...confirmed.map((item) => `I confirmed ${label(item)}.`),
      ...unresolved.map(
        (item) => `I couldn’t confirm ${label(item)}. Check Activity for the outcome.`,
      ),
      ...(unresolved.length === 0
        ? ['I couldn’t confirm the change described. Check Activity for the outcome.']
        : []),
    ].join(' '),
    blocked: true,
  };
}
