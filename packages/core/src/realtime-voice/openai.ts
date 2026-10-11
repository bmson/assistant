import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import {
  emptyRealtimeUsage,
  type RealtimeInterruptionResult,
  type RealtimeSession,
  type RealtimeSessionConfig,
  type RealtimeSessionEvents,
  type RealtimeToolCall,
  type RealtimeUsage,
  type RealtimeVoiceProvider,
  type ToolFollowUp,
} from './types.js';

export interface OpenAIRealtimeOptions {
  apiKey: string;
  /** Override for tests. */
  url?: string;
  /** Speech-to-text model for the caller's side of the transcript. */
  transcriptionModel?: string;
  connectTimeoutMs?: number;
  /**
   * How long after the caller stops speaking a reply must have started.
   * Turn detection creates it within a few hundred milliseconds; past this
   * the reply was lost (a refused or cancelled request) and one is asked for.
   */
  replyStallMs?: number;
}

type ServerEvent = {
  type?: string;
  delta?: string;
  item_id?: string;
  response_id?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_token_details?: { audio_tokens?: number; text_tokens?: number };
  };
  error?: { message?: string };
  response?: {
    id?: string;
    status?: string;
    output?: Array<{
      type?: string;
      status?: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    usage?: {
      input_token_details?: {
        audio_tokens?: number;
        text_tokens?: number;
        cached_tokens?: number;
        cached_tokens_details?: { audio_tokens?: number; text_tokens?: number };
      };
      output_token_details?: {
        audio_tokens?: number;
        text_tokens?: number;
        reasoning_tokens?: number;
      };
    };
  };
};

type ToolCallTurn = { spoke: boolean };
type PendingToolCall = {
  call?: RealtimeToolCall;
  fingerprint: string;
  turn: ToolCallTurn;
  state: 'pending' | 'dispatched' | 'rejected';
  resultSent: boolean;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function parseToolArguments(argumentsJson: unknown): { args: unknown } | null {
  if (typeof argumentsJson !== 'string') return null;
  try {
    const args = JSON.parse(argumentsJson) as unknown;
    return { args };
  } catch {
    return null;
  }
}

function toolFingerprint(name: string, args: unknown): string {
  return createHash('sha256')
    .update(`${name}\n${stableJson(args)}`)
    .digest('hex');
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * OpenAI Realtime over WebSocket. Phone audio passes straight through: the
 * API speaks G.711 μ-law (`audio/pcmu`) natively, so there is no transcoding
 * and no added latency on either leg.
 */
export function createOpenAIRealtimeProvider(
  options: OpenAIRealtimeOptions,
): RealtimeVoiceProvider {
  if (!options.apiKey) throw new Error('OpenAI Realtime requires an API key');
  return {
    kind: 'openai',
    connect(config, events) {
      return connectOpenAIRealtime(options, config, events);
    },
  };
}

async function connectOpenAIRealtime(
  options: OpenAIRealtimeOptions,
  config: RealtimeSessionConfig,
  events: RealtimeSessionEvents,
): Promise<RealtimeSession> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.model))
    throw new Error(`Not an OpenAI realtime model name: ${config.model}`);
  const url =
    options.url ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${options.apiKey}` } });
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const usage: RealtimeUsage = emptyRealtimeUsage();
  // The item whose speech is on its way to the line, and how many ms of it
  // have been generated — a truncation past that length is rejected.
  let currentAudioItem: string | undefined;
  let currentAudioItemMs = 0;
  let closedByUs = false;
  // One response at a time. The API rejects a `response.create` while another
  // is in flight (`conversation_already_has_active_response`), and a rejected
  // request is a reply that never comes: the caller hears silence. A request
  // made while one is active waits for its `response.done` instead.
  let responseActive = false;
  let activeResponseId: string | null = null;
  let responseRequested = false;
  let pendingResponse: { instructions?: string } | null = null;
  let activeTurn: ToolCallTurn | null = null;
  const startedResponseIds = new Set<string>();
  const settledResponseIds = new Set<string>();
  const turnsByResponse = new Map<string, ToolCallTurn>();
  const pendingCallsByResponse = new Map<string, Set<string>>();
  // Keep terminal IDs for this socket's lifetime: an event replay must not
  // dispatch an action again or replace the turn that owns its follow-up.
  const callsById = new Map<string, PendingToolCall>();
  let replyStallTimer: NodeJS.Timeout | null = null;
  let setupReady = false;
  let setupRetired = false;
  let setupTimer: NodeJS.Timeout | null = null;
  let closePromise: Promise<void> | null = null;
  let setupResolve!: () => void;
  let setupReject!: (error: Error) => void;
  const setupPromise = new Promise<void>((resolve, reject) => {
    setupResolve = resolve;
    setupReject = reject;
  });
  let terminationStarted = false;

  const terminateOnce = () => {
    if (terminationStarted || socket.readyState === WebSocket.CLOSED) return;
    terminationStarted = true;
    socket.terminate();
  };

  const failSetup = (error: Error) => {
    if (setupReady || setupRetired) return;
    setupRetired = true;
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = null;
    setupReject(error);
    terminateOnce();
  };

  setupTimer = setTimeout(
    () => failSetup(new Error(`OpenAI Realtime setup timed out after ${connectTimeoutMs} ms`)),
    connectTimeoutMs,
  );

  const cancelReplyWatch = () => {
    if (replyStallTimer) clearTimeout(replyStallTimer);
    replyStallTimer = null;
  };

  const send = (event: Record<string, unknown>) => {
    if (!closedByUs && !setupRetired && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(event));
  };

  const requestResponse = (instructions?: string) => {
    if (responseActive || responseRequested) {
      pendingResponse = { instructions: instructions ?? pendingResponse?.instructions };
      return;
    }
    responseRequested = true;
    send({ type: 'response.create', ...(instructions ? { response: { instructions } } : {}) });
  };

  socket.on('message', (raw) => {
    if (setupRetired || closedByUs) return;
    let event: ServerEvent;
    try {
      event = JSON.parse(raw.toString()) as ServerEvent;
    } catch {
      return;
    }
    if (!setupReady) {
      if (event.type === 'session.updated') {
        if (socket.readyState !== WebSocket.OPEN) {
          failSetup(new Error('OpenAI Realtime closed before setup completed'));
          return;
        }
        setupReady = true;
        if (setupTimer) clearTimeout(setupTimer);
        setupTimer = null;
        setupResolve();
      } else if (event.type === 'error') {
        failSetup(
          new Error(
            `OpenAI Realtime rejected session setup: ${event.error?.message ?? 'unknown error'}`,
          ),
        );
      }
      return;
    }
    switch (event.type) {
      case 'response.created':
        if (!event.response?.id) {
          events.error(new Error('OpenAI Realtime created a response without its ID'));
          break;
        }
        if (startedResponseIds.has(event.response.id) || settledResponseIds.has(event.response.id))
          break;
        cancelReplyWatch();
        responseRequested = false;
        responseActive = true;
        activeResponseId = event.response.id;
        activeTurn = { spoke: false };
        startedResponseIds.add(event.response.id);
        turnsByResponse.set(event.response.id, activeTurn);
        break;
      case 'response.output_audio.delta':
        if (event.delta) {
          // Audio deltas belong to the response that generated them. A late
          // event for a settled response must not mark the active turn spoken,
          // reach the caller, or replace its truncation item/offset.
          const responseId = event.response_id;
          const turn = responseId ? turnsByResponse.get(responseId) : undefined;
          if (!responseId || responseId !== activeResponseId || !turn) {
            events.error(new Error('OpenAI Realtime audio delta referenced an inactive response'));
            break;
          }
          const audio = new Uint8Array(Buffer.from(event.delta, 'base64'));
          if (event.item_id && event.item_id !== currentAudioItem) {
            currentAudioItem = event.item_id;
            currentAudioItemMs = 0;
          }
          // μ-law at 8 kHz: one byte per sample, eight per millisecond.
          currentAudioItemMs += audio.length / 8;
          turn.spoke = true;
          events.audio(audio);
        }
        break;
      case 'input_audio_buffer.speech_started':
        cancelReplyWatch();
        events.speechStarted();
        break;
      case 'input_audio_buffer.speech_stopped':
        // The caller finished a turn and is now waiting. If no reply has
        // started by the deadline, the one turn detection made was lost, and
        // the caller would otherwise sit in silence until they speak again.
        cancelReplyWatch();
        replyStallTimer = setTimeout(() => {
          replyStallTimer = null;
          if (!responseActive && !responseRequested && !pendingResponse) requestResponse();
        }, options.replyStallMs ?? 4_000);
        replyStallTimer.unref?.();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.usage) {
          const inputAudio = count(event.usage.input_token_details?.audio_tokens);
          usage.transcriptionInputAudioTokens += inputAudio || count(event.usage.input_tokens);
          usage.transcriptionOutputTextTokens += count(event.usage.output_tokens);
          usage.transcriptionUsageReported = true;
        }
        if (event.transcript?.trim()) events.transcript('caller', event.transcript.trim());
        break;
      case 'response.output_audio_transcript.done':
        if (event.transcript?.trim()) events.transcript('assistant', event.transcript.trim());
        break;
      case 'response.function_call_arguments.done': {
        if (!event.call_id || !event.name || !event.response_id) {
          events.error(new Error('OpenAI Realtime returned incomplete function-call metadata'));
          break;
        }
        const parsed = parseToolArguments(event.arguments);
        const callFingerprint = parsed ? toolFingerprint(event.name, parsed.args) : '';
        const previous = callsById.get(event.call_id);
        if (previous) {
          if (previous.fingerprint !== callFingerprint) {
            if (previous.state === 'pending') {
              previous.state = 'rejected';
              previous.call = undefined;
            }
            events.error(
              new Error('OpenAI Realtime reused a function-call ID with different content'),
            );
          }
          break;
        }
        const turn = turnsByResponse.get(event.response_id);
        if (!turn) {
          callsById.set(event.call_id, {
            fingerprint: callFingerprint,
            turn: { spoke: false },
            state: 'rejected',
            resultSent: false,
          });
          events.error(new Error('OpenAI Realtime function call referenced an unknown response'));
          break;
        }
        if (!parsed) {
          callsById.set(event.call_id, {
            fingerprint: '',
            turn,
            state: 'rejected',
            resultSent: false,
          });
          events.error(new Error('OpenAI Realtime returned invalid function-call arguments'));
          break;
        }
        const record: PendingToolCall = {
          call: { id: event.call_id, name: event.name, args: parsed.args },
          fingerprint: callFingerprint,
          turn,
          state: 'pending',
          resultSent: false,
        };
        callsById.set(event.call_id, record);
        const pending = pendingCallsByResponse.get(event.response_id) ?? new Set<string>();
        pending.add(event.call_id);
        pendingCallsByResponse.set(event.response_id, pending);
        break;
      }
      case 'response.done': {
        const responseId = event.response?.id;
        if (!responseId) {
          for (const pendingIds of pendingCallsByResponse.values()) {
            for (const callId of pendingIds) {
              const record = callsById.get(callId);
              if (record?.state === 'pending') {
                record.state = 'rejected';
                record.call = undefined;
              }
            }
          }
          pendingCallsByResponse.clear();
          events.error(new Error('OpenAI Realtime completed a response without its ID'));
          break;
        }
        // Completion events can be replayed after a later response has begun.
        // Settle a response once so its usage, tool output, and lifecycle do
        // not affect a newer response.
        if (settledResponseIds.has(responseId)) break;
        settledResponseIds.add(responseId);
        const ownsActiveResponse = activeResponseId === responseId;
        const input = event.response?.usage?.input_token_details;
        const output = event.response?.usage?.output_token_details;
        const cached = count(input?.cached_tokens);
        const cachedAudio = count(input?.cached_tokens_details?.audio_tokens);
        const cachedText = count(input?.cached_tokens_details?.text_tokens);
        usage.inputAudioTokens += count(input?.audio_tokens);
        usage.inputTextTokens += count(input?.text_tokens);
        usage.cachedInputTokens += cached;
        usage.cachedAudioInputTokens += cachedAudio;
        usage.cachedTextInputTokens += cachedText;
        usage.cachedUnclassifiedInputTokens += Math.max(0, cached - cachedAudio - cachedText);
        usage.outputAudioTokens += count(output?.audio_tokens);
        usage.outputTextTokens += count(output?.text_tokens);
        if (output?.reasoning_tokens !== undefined) {
          usage.reasoningOutputTokens += count(output.reasoning_tokens);
          usage.reasoningUsageReported = true;
        }
        const pending = responseId ? pendingCallsByResponse.get(responseId) : undefined;
        if (pending) {
          const outputItems = event.response?.output ?? [];
          for (const callId of pending) {
            const record = callsById.get(callId);
            if (record?.state !== 'pending') continue;
            const item = outputItems.find((candidate) => candidate.call_id === callId);
            const itemArgs = item && parseToolArguments(item.arguments);
            const itemFingerprint = itemArgs
              ? toolFingerprint(item?.name ?? '', itemArgs.args)
              : '';
            if (
              event.response?.status !== 'completed' ||
              item?.type !== 'function_call' ||
              item.status !== 'completed' ||
              itemFingerprint !== record.fingerprint
            ) {
              record.state = 'rejected';
              record.call = undefined;
              events.error(
                new Error(
                  'OpenAI Realtime function call was not confirmed by a completed response',
                ),
              );
              continue;
            }
            const call = record.call;
            if (!call) {
              record.state = 'rejected';
              events.error(
                new Error('OpenAI Realtime confirmed a function call without its arguments'),
              );
              continue;
            }
            record.state = 'dispatched';
            record.call = undefined;
            events.toolCall(call);
          }
          pendingCallsByResponse.delete(responseId as string);
        }
        if (
          event.response?.output?.some(
            (item) =>
              item.type === 'function_call' && (!item.call_id || !pending?.has(item.call_id)),
          )
        ) {
          events.error(
            new Error(
              'OpenAI Realtime completed a function call without matching streamed arguments',
            ),
          );
        }
        turnsByResponse.delete(responseId);
        if (ownsActiveResponse) {
          responseActive = false;
          activeResponseId = null;
          activeTurn = null;
        }
        if (ownsActiveResponse && pendingResponse) {
          const next = pendingResponse;
          pendingResponse = null;
          requestResponse(next.instructions);
        }
        break;
      }
      case 'error':
        // A refused `response.create` never produces `response.created`;
        // clear the request so the next one is not held behind it forever.
        if (!responseActive) responseRequested = false;
        events.error(new Error(event.error?.message ?? 'OpenAI Realtime error'));
        break;
    }
  });
  socket.once('open', () => {
    if (setupRetired) return;
    try {
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: config.model,
            output_modalities: ['audio'],
            instructions: config.instructions,
            audio: {
              input: {
                format: { type: 'audio/pcmu' },
                // Line hiss, traffic and a TV in the background otherwise register
                // as speech: each false start cancels the reply mid-sentence, and
                // the model then says it again from the top.
                noise_reduction: { type: 'near_field' },
                // Semantic VAD waits for the other person to finish a thought, not
                // just a pause — fewer interruptions of someone reading out a date.
                // On narrowband phone audio its end-of-turn confidence is low, so
                // the default eagerness sat out its full four-second ceiling after
                // most turns. `high` caps that wait at two seconds.
                turn_detection: {
                  type: 'semantic_vad',
                  eagerness: 'high',
                  create_response: true,
                  interrupt_response: true,
                },
                transcription: { model: options.transcriptionModel ?? 'gpt-live-transcribe' },
              },
              output: {
                format: { type: 'audio/pcmu' },
                ...(config.voice ? { voice: config.voice } : {}),
              },
            },
            tools: config.tools.map((tool) => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            tool_choice: 'auto',
          },
        }),
      );
    } catch (error) {
      failSetup(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.once('unexpected-response', (_request, response) => {
    failSetup(
      new Error(
        response.statusCode === 401
          ? 'OpenAI rejected the API key'
          : `OpenAI Realtime refused the connection (HTTP ${response.statusCode})`,
      ),
    );
  });
  socket.on('error', (error) => {
    if (!setupReady) failSetup(error);
    else if (!closedByUs) events.error(error);
  });
  socket.on('close', () => {
    if (!setupReady) {
      failSetup(new Error('OpenAI Realtime closed before setup completed'));
      return;
    }
    cancelReplyWatch();
    if (!closedByUs) events.closed();
  });

  await setupPromise;

  return {
    sendAudio(mulaw) {
      send({ type: 'input_audio_buffer.append', audio: Buffer.from(mulaw).toString('base64') });
    },
    sendToolResult(call: RealtimeToolCall, result: unknown, followUp: ToolFollowUp = 'respond') {
      const record = callsById.get(call.id);
      if (
        record?.state !== 'dispatched' ||
        record.fingerprint !== toolFingerprint(call.name, call.args)
      ) {
        events.error(
          new Error('OpenAI Realtime received a result for an unconfirmed function call'),
        );
        return;
      }
      if (record.resultSent) return;
      record.resultSent = true;
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) },
      });
      // Asking for a response after every result made the model restate
      // what it had just said alongside a `note`, and say goodbye twice
      // after `end_call`.
      if (followUp === 'respond' || (followUp === 'if_silent' && !record.turn.spoke))
        requestResponse();
    },
    respond(instructions) {
      requestResponse(instructions);
    },
    interrupt(unplayedMs): RealtimeInterruptionResult {
      if (!currentAudioItem || unplayedMs <= 0 || socket.readyState !== WebSocket.OPEN)
        return { providerState: 'unknown', spokenOffset: 'unknown' };
      send({
        type: 'conversation.item.truncate',
        item_id: currentAudioItem,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.round(currentAudioItemMs - unplayedMs)),
      });
      currentAudioItem = undefined;
      currentAudioItemMs = 0;
      // The provider command was sent, but this adapter does not wait for a
      // server truncation receipt; only the transport offset is estimated.
      return { providerState: 'requested', spokenOffset: 'estimated' };
    },
    usage: () => ({ ...usage }),
    close() {
      if (closePromise) return closePromise;
      closedByUs = true;
      cancelReplyWatch();
      if (socket.readyState === WebSocket.CLOSED) {
        closePromise = Promise.resolve();
        return closePromise;
      }
      closePromise = new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
        setTimeout(() => {
          terminateOnce();
          resolve();
        }, 2_000).unref();
      });
      return closePromise;
    },
  };
}
