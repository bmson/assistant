import { createHash } from 'node:crypto';
import { makeCommunicationReceipt } from '@assistant/core';
import { estimateSmsSegments, smsUsageReconciliationState } from '@assistant/persistence';
import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import type { SmsSender } from './client.js';
import { submitSms } from './sms-accounting.js';

export interface SmsToolDeps {
  sender: SmsSender;
  ownerPhone: string;
  /** Voice pipeline hook for outbound SMS text. */
  prepareOutbound?: (text: string) => Promise<{ text: string; flagged?: string }>;
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

export function registerSmsTools(registry: ToolRegistry, deps: SmsToolDeps): ToolRegistry {
  const schema = z.object({
    to: z.string().regex(/^\+\d{7,15}$/, 'E.164 phone number'),
    body: z.string().min(1).max(1500),
    /** Set by the voice pipeline when the fact check failed. */
    voiceFlag: z.string().optional(),
  });

  register(
    registry,
    {
      name: 'sms.send',
      description:
        "Send an SMS from the assistant's own number. Replying to the owner in the owner's conversation is autonomous (policy); anyone else requires owner approval.",
      inputSchema: schema,
      // The seeded 'sms.reply_to_owner' policy turns owner-conversation replies
      // autonomous; the base tier stays approval for everything else.
      risk: (args, ctx) =>
        (args as z.infer<typeof schema>).to === deps.ownerPhone && ctx.trust === 'owner'
          ? 'autonomous'
          : 'approval',
      acceptsUntrustedInput: false,
      prepare: async (args) => {
        const sourceBody = (args as z.infer<typeof schema>).body;
        if (!deps.prepareOutbound) return { ...args, sourceBody };
        const result = await deps.prepareOutbound(sourceBody);
        // Preserve the pre-rewrite body so the idempotency key stays stable
        // across a crash-retry (which re-runs the nondeterministic rewrite).
        return { ...args, body: result.text, voiceFlag: result.flagged, sourceBody };
      },
      approvalSummary: (args) => {
        const a = args as z.infer<typeof schema>;
        return `Send SMS to ${a.to}: "${a.body.slice(0, 80)}${a.body.length > 80 ? '…' : ''}"`;
      },
      idempotencyKey: (args, ctx) => {
        // Key on the ORIGINAL (pre-voice-rewrite) message body, not the rewritten
        // one. The rewrite is a nondeterministic model call, so keying on its
        // output would produce a different key on a crash-retry and let the guard
        // miss — sending the SMS twice. The full body (not a prefix) still keeps
        // two genuinely different owner updates in the same task from colliding
        // ("Update on ...", "Confirmed: ..."), which would silently suppress the
        // second send and report a false success.
        const a = args as z.infer<typeof schema> & { sourceBody?: string };
        const digest = createHash('sha256')
          .update(`${a.to}\n${a.sourceBody ?? a.body}`)
          .digest('hex');
        return `sms-send-${ctx.taskId}-${digest}`;
      },
      estimateCost: (args) => {
        const sms = estimateSmsSegments(args.body);
        return {
          source: 'twilio_sms',
          rateKey: 'twilio_sms',
          unit: 'segment',
          quantity: sms.estimatedSegments,
          description: `outbound SMS (${sms.estimatedSegments} estimated segment(s))`,
          evidence: { basis: 'preflight_estimate', provider: 'twilio', sms },
        };
      },
      reconcileCost: (_args, result) => {
        const sms = (
          result as { smsAccounting?: import('@assistant/persistence').SmsDeliveryAccounting }
        )?.smsAccounting;
        if (!sms) return {};
        return {
          ...(sms.billedSegments ? { quantity: sms.billedSegments } : {}),
          unit: 'segment',
          ...(sms.providerPriceUsd !== undefined ? { usd: sms.providerPriceUsd } : {}),
          evidence: {
            basis: sms.providerPriceUsd !== undefined ? 'provider_reported' : 'preflight_estimate',
            provider: 'twilio',
            requestId: sms.providerMessageId,
            sms,
            smsUsageReconciliation: smsUsageReconciliationState(sms),
          },
        };
      },
      execute: async (args) => {
        const result = await submitSms(deps.sender, args.to, args.body);
        return {
          sid: result.sid,
          to: args.to,
          deliveryStatus: 'accepted',
          smsAccounting: result.accounting,
          communicationReceipt: makeCommunicationReceipt({
            channel: 'sms',
            provider: 'twilio',
            providerMessageId: result.sid,
            args,
          }),
        };
      },
    },
    { outwardFacing: true },
  );

  return registry;
}
