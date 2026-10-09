import { getAgent } from '@assistant/core';
import { VoiceModelUnavailableError } from '@assistant/core/realtime-voice';
import { ACTIVE_CALL_STATUSES, type CallSessionRepository } from '@assistant/persistence';
import { registerCallTools, TwilioVoiceClient } from '@assistant/tools/calls';
import { defineModule, type ModuleServices } from '../platform.js';
import { handleMediaStream, type MediaSocket } from './bridge.js';
import { CallRefusedError, staleCallCutoff, startCall } from './dial.js';
import { deliverCallFinish, finishCall } from './finish.js';
import { callsMeta } from './meta.js';
import { handleCallStatus, handleInboundCall } from './status.js';
import { resolveSessionVoiceRoute, selectVoiceRoute } from './voice-route.js';

/** What the agent's HTTP server hands a Twilio media-stream WebSocket to. */
export interface CallBridge {
  attach(socket: MediaSocket, services: ModuleServices): void;
}

function repository<T extends object>(value: T | undefined, name: string): T {
  if (value) return value;
  return new Proxy({} as T, {
    get(_target, property) {
      if (property === 'then') return undefined;
      throw new Error(`calls: persistence has no ${name} repository (${String(property)})`);
    },
  });
}

export const callsModule = defineModule<CallBridge>({
  meta: callsMeta,
  create: ({ config, db, registry, persistence }) => {
    const dialer = new TwilioVoiceClient(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      config.TWILIO_VOICE_FROM_NUMBER || config.TWILIO_FROM_NUMBER,
    );
    const calls = repository<CallSessionRepository>(persistence.callSessions, 'call session');
    const ownerId = async () => {
      if (config.PERSISTENCE_DRIVER === 'firestore') return config.FIRESTORE_AGENT_ID;
      return (await getAgent(db)).id;
    };
    const finishDeps = {
      calls,
      costs: persistence.costs,
      jobs: persistence.executionJobs,
      dialer,
    };
    const callUrl = (callId: string) =>
      config.WEB_URL ? new URL(`/calls/${callId}`, config.WEB_URL).toString() : 'the Calls page';

    if (dialer.configured()) {
      registerCallTools(registry, {
        allowedCountryCodes: config.CALL_ALLOWED_COUNTRY_CODES,
        maxMinutes: config.CALL_MAX_MINUTES,
        startCall: (input) =>
          startCall(
            {
              config,
              calls,
              costs: persistence.costs,
              dialer,
              ownerId,
              voiceModel: () => selectVoiceRoute(persistence, config),
            },
            input,
          ).catch((error) => {
            // Owner-readable refusals reach the model as the tool's error text.
            if (error instanceof CallRefusedError || error instanceof VoiceModelUnavailableError)
              throw new Error(error.message);
            throw error;
          }),
      });
    } else {
      console.warn('calls module enabled but unavailable — run pnpm setup:phone');
    }

    const bridge: CallBridge = {
      attach(socket, services) {
        handleMediaStream(socket, {
          ...finishDeps,
          dialer,
          resolveVoice: async (session) => resolveSessionVoiceRoute(session, persistence, config),
          notifyOwner: async (input) => {
            await services.ownerNotifier.notifyOwner({ ...input, urgency: 'interrupt' });
          },
          callUrl,
          ownerName: config.OWNER_NAME,
          assistantName: config.ASSISTANT_NAME,
          timezone: config.ASSISTANT_TIMEZONE,
        });
      },
    };

    return {
      exports: bridge,
      hooks: {
        webhooks: [
          {
            path: '/twilio/voice',
            handler: async (services, request) =>
              handleInboundCall(
                {
                  notifyOwner: async (input) => {
                    await services.ownerNotifier.notifyOwner(input);
                  },
                  ownerName: config.OWNER_NAME,
                },
                await request.form(),
              ),
          },
          {
            path: '/twilio/voice-status',
            handler: async (services, request) =>
              handleCallStatus(
                {
                  ...finishDeps,
                  notifyOwner: async (input) => {
                    await services.ownerNotifier.notifyOwner(input);
                  },
                },
                await request.form(),
              ),
          },
        ],
        sweepSteps: [
          {
            name: 'call_finish_delivery',
            portable: true,
            run: async () => {
              const agentId = await ownerId();
              let delivered = 0;
              for (const call of await calls.listPendingFinishDelivery(agentId, 100)) {
                if (await deliverCallFinish(finishDeps, call)) delivered += 1;
              }
              return delivered;
            },
          },
          {
            name: 'stale_calls',
            portable: true,
            // A call whose bridge died (instance restart) or whose dial outcome
            // was never learned would otherwise stay "active" and block every
            // later call. Close it out and release what it still holds.
            run: async () => {
              const agentId = await ownerId();
              const now = new Date();
              let closed = 0;
              for (const call of await calls.list(agentId, 20)) {
                if (!(ACTIVE_CALL_STATUSES as readonly string[]).includes(call.status)) continue;
                if (call.createdAt > staleCallCutoff(now, call.maxMinutes)) continue;
                const result = await finishCall(finishDeps, call, {
                  status: 'failed',
                  outcome: 'failed',
                  summary:
                    'The call’s result was lost; check the Calls page for what was recorded.',
                  durationSeconds: call.startedAt
                    ? Math.min(
                        call.maxMinutes * 60,
                        Math.round((now.getTime() - call.startedAt.getTime()) / 1000),
                      )
                    : null,
                  modelCostUsd: 0,
                  error: 'stale call closed by the sweep',
                });
                if (result) closed += 1;
              }
              return closed;
            },
          },
        ],
      },
    };
  },
});
