import { randomBytes, randomUUID } from 'node:crypto';
import {
  CALL_PENDING,
  CALL_RING_ALLOWANCE_MINUTES,
  type CallBrief,
  CallBriefSchema,
  type CallPendingResult,
  checkDialable,
} from '@assistant/core';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { isAmbiguousTwilioDeliveryError } from '../twilio/client.js';
import type { AssistantTool, ToolContext } from '../types.js';

export { AmbiguousTwilioDeliveryError, isAmbiguousTwilioDeliveryError } from '../twilio/client.js';
export * from '../twilio/voice.js';

export interface StartCallInput {
  callId: string;
  brief: CallBrief;
  callbackToken: string;
  ctx: ToolContext & { execution: NonNullable<ToolContext['execution']> };
}

export interface CallToolDeps {
  allowedCountryCodes: string;
  maxMinutes: number;
  /** Refuses (throws) when a cap, the budget, or configuration stops the call; otherwise dials. */
  startCall(input: StartCallInput): Promise<{ callSid: string }>;
}

const InputSchema = z.object({ brief: CallBriefSchema });

/** Minutes after the call's own ceiling before the task stops waiting for its result. */
const RESULT_GRACE_MINUTES = 2;

export function registerCallTools(registry: ToolRegistry, deps: CallToolDeps): ToolRegistry {
  const tool: AssistantTool<typeof InputSchema, CallPendingResult> = {
    name: 'phone.call',
    description:
      "Place a phone call from the assistant's own number and hold the conversation live, on the owner's behalf, to achieve one goal (book a table, ask opening hours, chase an order). Every call needs the owner's approval of the brief unless a saved rule permits the same brief within its time limit. The other party always hears that you are an AI assistant. Put in `context` only the facts you may share, in `mayAgreeTo` exactly what you may accept, and in `mustNot` the hard limits. During the call you can check with the owner. The result (outcome, summary, facts noted, transcript) arrives in the next turn — call ONCE and wait.",
    inputSchema: InputSchema,
    risk: 'approval',
    acceptsUntrustedInput: false,
    // Refuse before an approval card exists: the owner is never asked to
    // approve a call that could not be placed.
    prepare: async (args) => {
      const brief = { ...args.brief, maxMinutes: Math.min(args.brief.maxMinutes, deps.maxMinutes) };
      const check = checkDialable(brief.to, deps.allowedCountryCodes);
      if (!check.ok) throw new Error(`Cannot call ${brief.to}: ${check.reason}`);
      return { brief };
    },
    approvalSummary: (args) => {
      const b = args.brief;
      const who = b.contactName ? `${b.contactName} (${b.to})` : b.to;
      const parts = [`Call ${who} for up to ${b.maxMinutes} min: ${b.goal}`];
      if (b.mayAgreeTo) parts.push(`May agree to: ${b.mayAgreeTo}`);
      if (b.mustNot) parts.push(`Never: ${b.mustNot}`);
      if (b.context) parts.push(`May share: ${b.context}`);
      parts.push(
        b.onVoicemail === 'leave_message'
          ? 'Leaves a voicemail if no one answers'
          : 'Hangs up on voicemail',
      );
      return parts.join(' · ');
    },
    idempotencyKey: (args, ctx) =>
      `phone-call-${ctx.taskId}-${args.brief.to}-${args.brief.goal.slice(0, 60)}`,
    execute: async (args, ctx) => {
      if (
        !ctx.execution?.dbToolCallId ||
        !ctx.execution.modelToolCallId ||
        !ctx.stageBrowserJob ||
        !ctx.clearStagedBrowserJob
      ) {
        throw new Error('placing a call requires a durable dispatcher execution context');
      }
      const brief = args.brief;
      const callId = randomUUID();
      const callbackToken = randomBytes(24).toString('hex');
      const timeoutAt = new Date(
        ctx.now().getTime() +
          (brief.maxMinutes + CALL_RING_ALLOWANCE_MINUTES + RESULT_GRACE_MINUTES) * 60_000,
      ).toISOString();
      const pending: CallPendingResult = {
        pending: CALL_PENDING,
        callbackToken,
        timeoutAt,
        callId,
      };
      const staged = { ...ctx.execution, pending };

      // Checkpoint first: nothing rings before the task knows what it waits for.
      await ctx.stageBrowserJob(staged);
      try {
        const { callSid } = await deps.startCall({
          callId,
          brief,
          callbackToken,
          ctx: { ...ctx, execution: ctx.execution },
        });
        await ctx
          .log('call_placed', { callId, callSid, to: brief.to })
          .catch((error) => console.error('call placed log failed', error));
        return pending;
      } catch (error) {
        if (isAmbiguousTwilioDeliveryError(error)) {
          await ctx
            .log('call_place_unknown', { callId, to: brief.to, error: String(error) })
            .catch(() => {});
          // It may be ringing. Keep waiting for its status callback or the
          // timeout; never dial a second time.
          return pending;
        }
        await ctx.clearStagedBrowserJob(staged);
        throw error;
      }
    },
  };
  registry.register(tool as unknown as AssistantTool, {
    outwardFacing: true,
    blanketAllowIneligible: true,
    scopedAllowTemplates: ['phone.call.same_brief'],
    autonomyFloor: true,
    // The other party's words come back in the transcript.
    returnsUntrustedContent: true,
    networkEgress: true,
  });
  return registry;
}
