import { type ExecutorDeps, firestoreCodeJobUnavailable } from '@assistant/core';
import { googleModule } from '@assistant/modules';
import {
  type FinalChannelDeliveryResult,
  finalChannelDelivery,
  finalChannelDeliveryReport,
} from '@assistant/persistence';
import {
  gmailThreadHeadReader,
  listEventsInWindow,
  readCalendarEvent,
} from '@assistant/tools/modules/google';
import { type AgentDeps, agentServices } from './deps.js';

/**
 * The in-thread version of the parked-approval notice. It deliberately does NOT
 * invite a "YES A7" reply to the email: only the SMS channel parses approval
 * codes, so promising resolution here would be an instruction the system cannot
 * honour — the same class of untruth this notice exists to prevent.
 */
export function approvalNoticeEmail(
  approvals: Array<{ shortCode: string; summary: string }>,
): string {
  return [
    'These actions are waiting for your approval:',
    ...approvals.map((a) => `- [${a.shortCode}] ${a.summary}`),
    '',
    'Approve or deny it on the Approvals page of the dashboard, or reply to my text message with YES or NO and the code. I will continue with the listed actions after your decision.',
  ].join('\n');
}

/**
 * The executor wired with the installed modules' channels: final answers route
 * back through the channel the request came from (email thread reply, SMS),
 * plus approval pings. Every channel self-guards on its own conversation
 * shape, so fanning out to all of them is safe; composition order (google
 * before sms in assistant.config.ts) preserves the email-then-sms sequence
 * from the hardcoded era. This file names no provider.
 */
export function executorDeps(deps: AgentDeps): ExecutorDeps {
  const services = agentServices(deps);
  const channels = deps.modules.channels;
  return {
    db: deps.db,
    persistence: deps.persistence,
    documentExtractionRepository: deps.documentExtractionRepository,
    importJobRepository: deps.importJobRepository,
    router: deps.router,
    dispatcher: deps.dispatcher,
    workspace: deps.workspace,
    documentProcessor: deps.documentProcessor,
    // The briefing's calendar input. The google module's absent value is a
    // client whose configured() is false, so an installation without Google
    // simply briefs without a calendar section.
    calendarReader: async ({ timeMin, timeMax }) => {
      const client = deps.modules.requireExports(googleModule);
      if (!client.configured()) return { events: [], complete: false };
      const res = await listEventsInWindow(client, { timeMin, timeMax, maxResults: 50 });
      return {
        // Carry the fields salience is judged from. `normalizeEvent` has
        // produced all of these all along; the port used to drop them, which is
        // why the briefing could only ever notice an overlap.
        events: res.events.map((event) => ({
          summary: event.summary,
          start: event.start,
          end: event.end,
          calendar: event.calendar,
          allDay: event.allDay,
          eventId: event.eventId,
          calendarId: event.calendarId,
          iCalUID: event.iCalUID,
          recurringEventId: event.recurringEventId,
          originalStartTime: event.originalStartTime,
          status: event.status,
          blocksTime: event.blocksTime,
          ownerResponse: event.ownerResponse,
          location: event.location,
          description: event.description,
          organizer: event.organizer,
          attendees: event.attendees,
        })),
        complete: res.complete,
      };
    },
    emailThreadReader: async (input) => {
      const client = deps.modules.requireExports(googleModule);
      return gmailThreadHeadReader(client)(input);
    },
    calendarEventReader: async (input) => {
      const client = deps.modules.requireExports(googleModule);
      if (!client.configured()) return null;
      return readCalendarEvent(client, input);
    },
    // Under Firestore, a job that still needs PostgreSQL completes benignly
    // (a task imported or queued before its port landed) rather than failing
    // into the SQL tripwire and dead-lettering.
    jobUnavailable: (job) =>
      deps.modules.jobUnavailable(job) ??
      (deps.config.PERSISTENCE_DRIVER === 'firestore' ? firestoreCodeJobUnavailable(job) : null),
    deliverFinal: async (task, text, attemptId, previous) => {
      let requiredChannel: string | null =
        task.trust === 'owner' && task.type === 'email_triage'
          ? 'email'
          : task.trust === 'owner' && task.type === 'sms_turn'
            ? 'sms'
            : null;
      // Follow-up tasks inherit their channel from the conversation binding.
      // The repositories return the conversation's channel even if the
      // provider binding was revoked, which makes a missing target a typed
      // rejection instead of a dashboard-only success.
      if (task.trust === 'owner' && task.conversationId && !requiredChannel) {
        try {
          const [email, sms] = await Promise.all([
            deps.persistence?.emailSync?.replyThread(task.conversationId),
            deps.persistence?.smsChannel?.finalDestination(task.conversationId),
          ]);
          if (email?.channel === 'email') requiredChannel = 'email';
          else if (sms?.channel === 'sms') requiredChannel = 'sms';
        } catch (error) {
          console.error('final delivery channel lookup failed', error);
          return finalChannelDeliveryReport([
            finalChannelDelivery('channel', 'rejected', attemptId, 'channel-lookup-failed'),
          ]);
        }
      }
      if (requiredChannel && task.trust === 'owner') {
        const unavailable = deps.modules.channelUnavailable(task.type);
        if (unavailable) {
          const legs = [...(previous?.legs ?? []).filter((leg) => leg.channel !== requiredChannel)];
          legs.push(
            finalChannelDelivery(
              requiredChannel,
              'rejected',
              attemptId,
              'channel-module-unavailable',
            ),
          );
          return finalChannelDeliveryReport(legs);
        }
      }

      const results: FinalChannelDeliveryResult[] = [...(previous?.legs ?? [])];
      for (const [index, channel] of channels.entries()) {
        const prior = previous?.legs.find((leg) => leg.channel === channel.name);
        if (prior && prior.status !== 'rejected') continue;
        try {
          const delivered = await channel.deliverFinal(services, task, text, attemptId);
          const existing = results.findIndex((result) => result.channel === delivered.channel);
          if (existing >= 0) results[existing] = delivered;
          else results.push(delivered);
        } catch (error) {
          // A thrown channel can fail after the provider accepted the send.
          // Preserve the attempt as ambiguous; never auto-retry it.
          console.error('final channel delivery threw; treating outcome as unknown', error);
          const channelName = channel.name ?? `channel-${index + 1}`;
          const unknown = finalChannelDelivery(
            channelName,
            'unknown',
            attemptId,
            'channel-outcome-unknown',
          );
          const existing = results.findIndex((result) => result.channel === channelName);
          if (existing >= 0) results[existing] = unknown;
          else results.push(unknown);
        }
      }
      const matchingRequired = requiredChannel
        ? results.some(
            (result) => result.channel === requiredChannel && result.status !== 'not_applicable',
          )
        : true;
      if (!matchingRequired && requiredChannel) {
        results.push(
          finalChannelDelivery(requiredChannel, 'rejected', attemptId, 'required-channel-skipped'),
        );
      }
      if (results.length === 0) {
        results.push(
          finalChannelDelivery('dashboard', 'not_applicable', attemptId, 'dashboard-only'),
        );
      }
      return finalChannelDeliveryReport(results);
    },
    // A parked approval has to reach the owner where they actually are. The
    // out-of-band ping (SMS today) goes first and is the only channel that can
    // RESOLVE an approval; the in-thread notice is what stops an
    // email-triggered request from going silent. Each notice deliverer guards
    // on its own channel, so this is a no-op for every non-email task.
    notifyApproval: async (task, approvals) => {
      await services.ownerNotifier.notifyApprovals(
        approvals.map((approval) => ({
          ...approval,
          conversationId: task.conversationId,
          purpose: task.title ?? undefined,
        })),
      );
      for (const channel of channels) {
        await channel.deliverApprovalNotice?.(services, task, approvalNoticeEmail(approvals));
      }
    },
    // `urgency` rides through to the nudge policy: absent it stays `interrupt`
    // (a dead-letter or budget stall the owner is waiting on, never held), and
    // proactive producers pass `ambient` so quiet hours and the daily cap
    // govern whether the phone actually buzzes.
    notifyOwner: ({ taskId, conversationId, text, urgency, applicationConfirmationNoticeFence }) =>
      services.ownerNotifier.notifyOwner({
        ...(taskId ? { taskId } : {}),
        conversationId,
        text,
        ...(urgency ? { urgency } : {}),
        ...(applicationConfirmationNoticeFence ? { applicationConfirmationNoticeFence } : {}),
      }),
  };
}
