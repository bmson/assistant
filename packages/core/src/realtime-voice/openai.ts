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
  let responseRequested = false;
  let pendingResponse: { instructions?: string } | null = null;
  let activeTurn: { spoke: boolean } | null = null;
  const callTurns = new Map<string, { spoke: boolean }>();
  let replyStallTimer: NodeJS.Timeout | null = null;

  const cancelReplyWatch = () => {
    if (replyStallTimer) clearTimeout(replyStallTimer);
    replyStallTimer = null;
  };

  const send = (event: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };

  const requestResponse = (instructions?: string) => {
    if (responseActive || responseRequested) {
      pendingResponse = { instructions: instructions ?? pendingResponse?.instructions };
      return;
    }
    responseRequested = true;
    send({ type: 'response.create', ...(instructions ? { response: { instructions } } : {}) });
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('OpenAI Realtime did not connect in time'));
    }, options.connectTimeoutMs ?? 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(
        new Error(
          response.statusCode === 401
            ? 'OpenAI rejected the API key'
            : `OpenAI Realtime refused the connection (HTTP ${response.statusCode})`,
        ),
      );
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.on('message', (raw) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw.toString()) as ServerEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case 'response.created':
        cancelReplyWatch();
        responseRequested = false;
        responseActive = true;
        activeTurn = { spoke: false };
        break;
      case 'response.output_audio.delta':
        if (event.delta) {
          const audio = new Uint8Array(Buffer.from(event.delta, 'base64'));
          if (event.item_id && event.item_id !== currentAudioItem) {
            currentAudioItem = event.item_id;
            currentAudioItemMs = 0;
          }
          // μ-law at 8 kHz: one byte per sample, eight per millisecond.
          currentAudioItemMs += audio.length / 8;
          if (activeTurn) activeTurn.spoke = true;
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
        let args: unknown = {};
        try {
          args = event.arguments ? JSON.parse(event.arguments) : {};
        } catch {
          args = { _unparsed: event.arguments };
        }
        if (event.call_id && event.name) {
          callTurns.set(event.call_id, activeTurn ?? { spoke: false });
          events.toolCall({ id: event.call_id, name: event.name, args });
        }
        break;
      }
      case 'response.done': {
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
        responseActive = false;
        activeTurn = null;
        if (pendingResponse) {
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
  socket.on('error', (error) => events.error(error));
  socket.on('close', () => {
    cancelReplyWatch();
    if (!closedByUs) events.closed();
  });

  send({
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
  });

  return {
    sendAudio(mulaw) {
      send({ type: 'input_audio_buffer.append', audio: Buffer.from(mulaw).toString('base64') });
    },
    sendToolResult(call: RealtimeToolCall, result: unknown, followUp: ToolFollowUp = 'respond') {
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) },
      });
      const turn = callTurns.get(call.id);
      callTurns.delete(call.id);
      // Asking for a response after every result made the model restate
      // what it had just said alongside a `note`, and say goodbye twice
      // after `end_call`.
      if (followUp === 'respond' || (followUp === 'if_silent' && !turn?.spoke)) requestResponse();
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
    async close() {
      closedByUs = true;
      cancelReplyWatch();
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close();
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 2_000).unref();
      });
    },
  };
}
