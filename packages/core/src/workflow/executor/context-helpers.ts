import type { TaskRow } from '@assistant/db';
import { nextDailyReset, nextMonthlyReset } from '../../cost.js';
import { isForwardedIngest } from '../../email-provenance.js';
import { activeAutonomyGrant } from '../autonomy.js';

/**
 * Trigger-payload marker for the D9 known-sender reply child: an assistant-trust
 * adhoc task whose sole job is to propose a pre-drafted reply back to a known
 * (authenticated non-owner) email sender, gated by gmail.send's owner approval.
 */
export const KNOWN_SENDER_REPLY_KIND = 'known_sender_reply';

export function isKnownSenderReplyTask(task: Pick<TaskRow, 'trigger'>): boolean {
  const trigger = task.trigger as { payload?: { kind?: unknown } } | null;
  return trigger?.payload?.kind === KNOWN_SENDER_REPLY_KIND;
}

/**
 * A mission work session, identified by the mission id its trigger carries
 * (missions.ts stamps it). Only such a session may see the mission.update tool;
 * keying off this — rather than "any adhoc child" — stops unrelated adhoc
 * children (e.g. the D9 known-sender-reply child) from being offered a tool they
 * can only ever call in error.
 */
export function missionSessionId(
  task: Pick<TaskRow, 'type' | 'parentTaskId' | 'trust' | 'trigger'>,
): string | null {
  if (
    task.type !== 'adhoc' ||
    (task.trust !== 'owner' && task.trust !== 'assistant') ||
    typeof task.parentTaskId !== 'string' ||
    task.parentTaskId.length === 0
  ) {
    return null;
  }
  const trigger = task.trigger as {
    source?: unknown;
    payload?: { missionId?: unknown };
  } | null;
  return trigger?.source === 'mission_wake' && trigger.payload?.missionId === task.parentTaskId
    ? task.parentTaskId
    : null;
}

export function missionSessionInstruction(
  task: Pick<TaskRow, 'type' | 'parentTaskId' | 'trust' | 'trigger'>,
): string | null {
  if (!missionSessionId(task)) return null;
  const trigger = task.trigger as { payload?: { instruction?: unknown } } | null;
  const instruction = trigger?.payload?.instruction;
  return typeof instruction === 'string' && instruction.trim() ? instruction : null;
}

export function isMissionSessionTask(
  task: Pick<TaskRow, 'type' | 'parentTaskId' | 'trust' | 'trigger'>,
): boolean {
  return missionSessionId(task) !== null;
}

/**
 * A goal's automatic work session runs with nobody watching it. A run that
 * ends without a single verified tool result therefore must not complete as
 * 'done': the owner sees a green task, the goal keeps its old progress line,
 * and the next session is re-seeded with the same stale state — the goal
 * silently spins. Chat turns are excluded on purpose; there the owner is
 * reading the same honesty message in real time.
 */
export function isUnattendedGoalSession(task: Pick<TaskRow, 'goalId' | 'type'>): boolean {
  return task.goalId !== null && task.type !== 'chat_turn' && task.type !== 'sms_turn';
}

/** Where budget-parked work resumes: the reset of whichever period is exhausted. */
export function budgetResumeAt(reason: string): Date {
  return reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset();
}

/**
 * Where this task's final answer lands — the model writes very different
 * replies for an email thread than for a chat bubble, and must know that
 * delivery back through the source channel is automatic.
 */
export function channelContext(task: TaskRow): string {
  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  switch (task.type) {
    case 'email_triage': {
      const from = typeof payload.from === 'string' ? payload.from : 'the sender';
      const subject = typeof payload.subject === 'string' ? payload.subject : '';
      // Forwarded ingest: the owner routed their whole inbox here to be READ.
      // The task runs at owner trust, but the sender is a third party and the
      // owner is not in this thread — so there is nobody to reply to, and the
      // deliverable is what the owner learns and what gets filed, not prose.
      if (isForwardedIngest(task)) {
        const ingest = payload.ingest as { ownerAlerted?: boolean } | undefined;
        return [
          `\nThis is a message from the owner's forwarded mail: ${from}${subject ? ` (subject: "${subject}")` : ''}.`,
          'The owner forwards their inbox to you so you can keep track of it. They are NOT in this thread and the sender is not writing to you — nothing you write is sent to anyone.',
          "Do the useful work now, with tools: put dated commitments on the calendar (calendar.create_event, no attendees — it is the owner's own calendar), file details worth keeping (workspace.write, docs.append), and tell the owner what matters with owner.notify.",
          ingest?.ownerAlerted === true
            ? 'The owner has ALREADY been alerted to this message with a summary. Call owner.notify again only if your closer read turns up something the summary missed — a hidden date, a wrong charge, a conflict with their calendar — never to repeat it.'
            : 'Call owner.notify ONLY when the owner has to do something they would otherwise miss — something is due, something changed, a person is waiting on them, or something looks wrong. Routine mail needs no ping; it is already stored and searchable.',
          'Never notify about confirmations of something the owner just did (a payment received, a transfer submitted, an app or account connected, an order shipped), receipts, sign-in notices that say no action is needed, or reminders for events already on their calendar.',
          'When you do notify: one or two plain sentences, leading with what they need to do and by when. Do not restate the subject line, do not list what you filed, and do not ask a question you could answer from the email, their calendar or memory.',
          'Never reply to the sender, and never draft a reply unless the owner has asked for one.',
          'Your final text is a note to the owner, not an email: no greeting, no sign-off. If nothing needed doing, say so in one short line.',
        ].join('\n');
      }
      return [
        `\nThis task was triggered by an email from ${from}${subject ? ` (subject: "${subject}")` : ''}.`,
        task.trust === 'owner'
          ? 'When you finish with a text answer, it is AUTOMATICALLY emailed back to the sender on the same thread — write your final message as that email reply (a short greeting, the substance, and a brief sign-off as yourself), and complete any needed tool actions (calendar, lookups) BEFORE finishing. Email renders simple Markdown as rich text, so you may use **bold**, bullet lists, and [labelled links](https://…); do not paste bare URLs mid-sentence.'
          : // gmail.create_draft is privateWrite and gmail.send is outwardFacing,
            // so `toolsForTask` strips both from an external-sender registry —
            // naming them here pointed the model at tools it cannot see. The
            // reply path that actually exists is the deterministic D9 child
            // (maybeEnqueueKnownSenderReply), which proposes the answer for
            // owner approval after this task finishes.
            'The sender is not the owner: nothing you write is sent to anyone. Answer as if writing the reply the owner would send, and the runtime will offer it to them for approval.',
      ].join('\n');
    }
    case 'sms_turn':
      return '\nThis task came in by SMS; your final text goes back as an SMS — one or two plain sentences, no greeting or sign-off, no markdown.';
    case 'chat_turn':
      return "\nThis task came from the owner's dashboard chat; your final text appears there as your reply.";
    default:
      if (task.goalId) {
        const freeRange = activeAutonomyGrant(task, Date.now()) !== null;
        if (freeRange) {
          // Free-range goal session: the grant means a lookup no longer forfeits
          // the ability to act, so the model may ground itself first and then act.
          return [
            "\nThis is a goal's automatic work session, running free-range: the owner armed it to work autonomously, so you can consult your own state AND act without stopping for approval on each step.",
            'Do the work now with your tools — do not describe a plan, promise to report back, or ask a question you could answer yourself by looking.',
            'Ground yourself first if it helps (memory.recall, goals.list, contacts.lookup), then take the outward step that moves the goal (browser.plan → browser.execute, or web.fetch for a plain page).',
            'Not knowing a URL is not a blocker: go to the most likely site. A "verify you are human"/CAPTCHA page is a block, never content.',
            'The runtime records goal progress from successful tool results. Do not call goals.update_progress yourself.',
          ].join('\n');
        }
        // Nobody is reading this live, so a message describing what you intend
        // to do reaches no one and changes nothing. Only a tool result does.
        return [
          "\nThis is a goal's automatic work session. The owner is NOT present and will not answer during this run.",
          'Do the work now with your tools — do not describe a plan, promise to report back, or ask a question you could answer yourself by looking.',
          'Everything you know about this goal is already in this prompt. goals.list, conversations.search and workspace.* tell you nothing new here; memory.recall is fine if a remembered fact would genuinely change what you do.',
          // Not a style preference — the provenance rule below makes call order
          // decide whether this session can act at all.
          'ORDER MATTERS. Reading third-party content (a fetched page, a mail thread, a workspace file) marks this session as carrying untrusted content, and from that point on every outward call needs the owner to approve it by hand — which, with nobody present, means the session stops. memory.recall and calendar availability are your own vetted state and do not count. So spend your FIRST outward call on the step that moves the goal: browser.plan, then browser.execute (or web.fetch for a plain page).',
          'You get one autonomous outward action, so make it count. browser.plan is free — it only plans. Your ONE outward call comes after it, and it must do the entire job: a single read-only browser.execute plan that searches, opens the promising results, and extracts everything you need. Do not spend that one action on a preliminary web.fetch to see what is there; if you would need several pages, ask browser.plan for a headless plan covering all of them.',
          'Not knowing a URL is not a blocker: go straight to the most likely site (official pages, Wikipedia/Wikivoyage, a company careers page). Big search engines CAPTCHA datacenter traffic — treat a search results page as a last resort, and a "verify you are human" page as a block, never as content.',
          'The runtime records goal progress from successful tool results. Do not call goals.update_progress yourself.',
        ].join('\n');
      }
      return '';
  }
}
