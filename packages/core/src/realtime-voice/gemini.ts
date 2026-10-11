import { createHash } from 'node:crypto';
import {
  Behavior,
  FunctionResponseScheduling,
  GoogleGenAI,
  type LiveConnectConfig,
  type LiveServerMessage,
  Modality,
  type Session,
} from '@google/genai';
import { pcmToTelephone, telephoneToPcm } from './audio-codec.js';
import {
  emptyRealtimeUsage,
  type RealtimeInterruptionResult,
  type RealtimeSession,
  type RealtimeSessionConfig,
  type RealtimeSessionEvents,
  type RealtimeToolCall,
  type RealtimeUsage,
  type RealtimeVoiceProvider,
} from './types.js';

export interface GeminiLiveOptions {
  project: string;
  location: string;
  /** Bounds both the initial setup handshake and every resume attempt. */
  connectTimeoutMs?: number;
  /** Injected for tests. */
  client?: Pick<GoogleGenAI, 'live'>;
}

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;

type TokenDetail = { modality?: string; tokenCount?: number };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprintArgs(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function split(details: TokenDetail[] | undefined, total: number | undefined) {
  let audio = 0;
  let text = 0;
  for (const detail of details ?? []) {
    const tokens = detail.tokenCount ?? 0;
    if (detail.modality === 'AUDIO') audio += tokens;
    else text += tokens;
  }
  // Without a breakdown, count everything as audio: the dearer rate, so an
  // estimate errs toward the budget rather than past it.
  if (!details?.length && total) audio = total;
  return { audio, text };
}

/**
 * Gemini Live on Vertex, authenticated by the service's own Google
 * credentials (ADC) — no API key. The phone's μ-law is widened to 16 kHz PCM
 * on the way in, and the model's 24 kHz speech narrowed back on the way out.
 *
 * Usage arrives per model turn and each turn is billed on its whole prompt,
 * so the turns are summed.
 */
export function createGeminiLiveProvider(options: GeminiLiveOptions): RealtimeVoiceProvider {
  return {
    kind: 'vertex',
    async connect(config, events) {
      const client =
        options.client ??
        new GoogleGenAI({ vertexai: true, project: options.project, location: options.location });
      return connectGeminiLive(client, config, events, options.connectTimeoutMs);
    },
  };
}

async function connectGeminiLive(
  client: Pick<GoogleGenAI, 'live'>,
  request: RealtimeSessionConfig,
  events: RealtimeSessionEvents,
  connectTimeoutMs = 10_000,
): Promise<RealtimeSession> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(request.model))
    throw new Error(`Not a Vertex live model name: ${request.model}`);
  const usage: RealtimeUsage = emptyRealtimeUsage();
  let callerText = '';
  let assistantText = '';
  let closedByUs = false;
  let transportEnded = false;
  let serverConfirmedInterruption = false;
  let fenceInterruptedOutput = false;

  type AssistantTurn = {
    emittedAudio: boolean;
    complete: boolean;
    pendingIfSilent: Set<string>;
  };
  type ToolCallState = {
    name: string;
    argsFingerprint: string | null;
    turn: AssistantTurn;
    result?: { value: unknown; followUp: 'respond' | 'if_silent' | 'none' };
    submitted: boolean;
    cancelled: boolean;
  };
  let currentTurn: AssistantTurn | null = null;
  const toolCalls = new Map<string, ToolCallState>();

  const flush = () => {
    if (callerText.trim()) events.transcript('caller', callerText.trim());
    if (assistantText.trim()) events.transcript('assistant', assistantText.trim());
    callerText = '';
    assistantText = '';
  };

  const ensureTurn = (): AssistantTurn => {
    currentTurn ??= { emittedAudio: false, complete: false, pendingIfSilent: new Set() };
    return currentTurn;
  };

  const sendToolResponse = (
    id: string,
    state: ToolCallState,
    scheduling: FunctionResponseScheduling,
  ) => {
    if (state.submitted || state.cancelled || !state.result || closedByUs || transportEnded) return;
    const connection = active;
    if (!connection || connection.retired || !connection.session) return;
    const result = state.result;
    // The SDK call has no acknowledgement. Mark it before sending so an
    // ambiguous write is never submitted to a second connection.
    state.submitted = true;
    state.result = undefined;
    try {
      connection.session.sendToolResponse({
        functionResponses: [
          {
            id,
            name: state.name,
            response: { output: result.value },
            scheduling,
          },
        ],
      });
    } catch {
      // SDK errors can echo request data; keep them out of owner diagnostics.
      events.error(new Error('Gemini Live could not submit a tool response'));
    }
  };

  const scheduleToolResponse = (id: string, state: ToolCallState) => {
    if (!state.result || state.submitted || state.cancelled || closedByUs || transportEnded) return;
    if (state.result.followUp === 'none') {
      sendToolResponse(id, state, FunctionResponseScheduling.SILENT);
      return;
    }
    if (state.result.followUp === 'respond') {
      // Match the bridge's queued-response behavior: let active speech finish
      // before making the tool result available for a requested follow-up.
      sendToolResponse(id, state, FunctionResponseScheduling.WHEN_IDLE);
      return;
    }
    if (!state.turn.complete) {
      state.turn.pendingIfSilent.add(id);
      return;
    }
    sendToolResponse(
      id,
      state,
      state.turn.emittedAudio
        ? FunctionResponseScheduling.SILENT
        : FunctionResponseScheduling.WHEN_IDLE,
    );
  };

  const completeTurn = () => {
    const turn = currentTurn;
    if (!turn) return;
    turn.complete = true;
    currentTurn = null;
    for (const id of turn.pendingIfSilent) {
      const state = toolCalls.get(id);
      if (state) scheduleToolResponse(id, state);
    }
    turn.pendingIfSilent.clear();
  };

  const flushPendingToolResponses = () => {
    for (const [id, state] of toolCalls) {
      if (state.result && !state.submitted && state.result.followUp !== 'if_silent')
        scheduleToolResponse(id, state);
      else if (state.result && !state.submitted && state.turn.complete)
        scheduleToolResponse(id, state);
    }
  };

  const onMessage = (message: LiveServerMessage) => {
    const content = message.serverContent;
    if (content?.interrupted) {
      // Gemini's `interrupted` server message is its confirmation that the
      // active generation was cancelled. It does not carry a sample offset.
      serverConfirmedInterruption = true;
      fenceInterruptedOutput = true;
      events.speechStarted();
      flush();
    }
    if (content?.inputTranscription?.text) callerText += content.inputTranscription.text;
    if (!fenceInterruptedOutput && content?.outputTranscription?.text) {
      ensureTurn();
      // The model has started answering: the caller's turn is complete.
      if (callerText.trim()) {
        events.transcript('caller', callerText.trim());
        callerText = '';
      }
      assistantText += content.outputTranscription.text;
    }
    for (const part of fenceInterruptedOutput ? [] : (content?.modelTurn?.parts ?? [])) {
      const data = part.inlineData?.data;
      if (data && part.inlineData?.mimeType?.startsWith('audio/')) {
        const audio = pcmToTelephone(new Uint8Array(Buffer.from(data, 'base64')), OUTPUT_RATE);
        if (audio.length > 0) {
          // This records adapter emission, not caller playback or audibility.
          ensureTurn().emittedAudio = true;
          events.audio(audio);
        }
      }
    }
    const turnEnded = Boolean(content?.turnComplete || content?.interrupted);
    for (const id of message.toolCallCancellation?.ids ?? []) {
      if (!id) continue;
      let state = toolCalls.get(id);
      if (!state) {
        state = {
          name: '',
          argsFingerprint: null,
          turn: { emittedAudio: false, complete: true, pendingIfSilent: new Set() },
          submitted: false,
          cancelled: true,
        };
        toolCalls.set(id, state);
      } else {
        state.cancelled = true;
        state.result = undefined;
        state.turn.pendingIfSilent.delete(id);
      }
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (call.id && call.name) {
        // Calls emitted in one model turn share its audio state. Keep that
        // reference across later turns and session resumption.
        const argsFingerprint = fingerprintArgs(call.args ?? {});
        const existing = toolCalls.get(call.id);
        if (!existing) {
          toolCalls.set(call.id, {
            name: call.name,
            argsFingerprint,
            turn: ensureTurn(),
            submitted: false,
            cancelled: false,
          });
          events.toolCall({ id: call.id, name: call.name, args: call.args ?? {} });
        } else if (
          existing.name &&
          (existing.name !== call.name || existing.argsFingerprint !== argsFingerprint)
        ) {
          events.error(new Error('Gemini Live received a conflicting tool call identity'));
        }
      } else {
        events.error(new Error('Gemini Live returned a tool call without an identity'));
      }
    }
    if (turnEnded) {
      flush();
      completeTurn();
      // Preserve a standalone interruption confirmation for the bridge's
      // synchronous interrupt() call. A separate turnComplete clears it.
      if (content?.turnComplete) {
        fenceInterruptedOutput = false;
        serverConfirmedInterruption = false;
      }
    }
    const metadata = message.usageMetadata;
    if (metadata) {
      const input = split(metadata.promptTokensDetails, metadata.promptTokenCount);
      const output = split(metadata.responseTokensDetails, metadata.responseTokenCount);
      usage.inputAudioTokens += input.audio;
      usage.inputTextTokens += input.text;
      usage.cachedInputTokens += metadata.cachedContentTokenCount ?? 0;
      usage.cachedUnclassifiedInputTokens += metadata.cachedContentTokenCount ?? 0;
      usage.outputAudioTokens += output.audio;
      usage.outputTextTokens += output.text + (metadata.thoughtsTokenCount ?? 0);
      if (metadata.thoughtsTokenCount !== undefined) {
        usage.reasoningOutputTokens += metadata.thoughtsTokenCount;
        usage.reasoningUsageReported = true;
      }
    }
  };

  const liveConfig: LiveConnectConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: request.instructions,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Audio sessions otherwise stop at fifteen minutes of context; a sliding
    // window keeps a long call going on its most recent turns.
    contextWindowCompression: { slidingWindow: {} },
    ...(request.voice
      ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice } } } }
      : {}),
    ...(request.tools.length
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.parameters,
                behavior: Behavior.NON_BLOCKING,
              })),
            },
          ],
        }
      : {}),
  };

  // A Live connection has a bounded lifetime: the server sends GoAway and
  // then drops it, around ten minutes in. That used to end the phone call.
  // Resumption hands the same conversation to a fresh connection instead.
  let resumeHandle: string | undefined;
  let resuming: Promise<void> | null = null;
  // Caller audio that arrives while no connection can take it, replayed on
  // the next one so words said during the handover are not lost.
  let heldAudio: string[] = [];

  type Connection = {
    session?: Session;
    retired: boolean;
    ready: boolean;
    activated: boolean;
    queuedMessages: LiveServerMessage[];
    closeCalled: boolean;
    close(): void;
  };
  let active: Connection | null = null;

  const open = async (handle?: string): Promise<Connection> => {
    const connection: Connection = {
      retired: false,
      ready: false,
      activated: false,
      queuedMessages: [],
      closeCalled: false,
      close() {
        if (connection.closeCalled || !connection.session) return;
        connection.closeCalled = true;
        try {
          connection.session.close();
        } catch (error) {
          events.error(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
    let rejectSetup!: (error: Error) => void;
    let setupSettled = false;
    let timer: NodeJS.Timeout | undefined;
    const setupFailure = new Promise<never>((_, reject) => {
      rejectSetup = reject;
    });
    const failSetup = (error: Error) => {
      if (setupSettled || connection.retired) return;
      setupSettled = true;
      connection.retired = true;
      if (timer) clearTimeout(timer);
      rejectSetup(error);
      connection.close();
    };
    const deliver = (message: LiveServerMessage) => {
      if (connection.retired) return;
      const update = message.sessionResumptionUpdate;
      if (update?.resumable && update.newHandle) resumeHandle = update.newHandle;
      if (message.goAway) void resume(false);
      onMessage(message);
    };
    const pending = Promise.resolve().then(() =>
      client.live.connect({
        model: request.model,
        config: { ...liveConfig, sessionResumption: handle ? { handle } : {} },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (connection.retired) return;
            if (!connection.ready || !connection.activated) {
              connection.queuedMessages.push(message);
              return;
            }
            deliver(message);
          },
          onerror: (event) => {
            if (connection.retired) return;
            const error = new Error(`Gemini Live error: ${String(event.message ?? event)}`);
            if (!connection.ready) failSetup(error);
            else events.error(error);
          },
          onclose: () => {
            if (connection.retired || closedByUs) return;
            if (!connection.ready) {
              failSetup(new Error('Gemini Live closed before setup completed'));
              return;
            }
            connection.retired = true;
            if (active === connection) completeTurn();
            // A GoAway handover may still be in flight; if it lands, this
            // connection is no longer the active one and there is nothing to do.
            void Promise.resolve(resuming).then(() =>
              active === connection ? resume(true) : undefined,
            );
          },
        },
      }),
    );
    // Consume a late rejection too: Promise.race settles at the first setup
    // failure, but the SDK's connect promise may reject afterward.
    pending.then(
      (session) => {
        connection.session = session;
        if (connection.retired) connection.close();
      },
      () => {},
    );

    try {
      timer = setTimeout(
        () => failSetup(new Error(`Gemini Live setup timed out after ${connectTimeoutMs} ms`)),
        connectTimeoutMs,
      );
      const session = await Promise.race([pending, setupFailure]);
      if (connection.retired) {
        connection.session = session;
        connection.close();
        throw new Error('Gemini Live setup was retired before becoming ready');
      }
      connection.session = session;
      connection.ready = true;
      setupSettled = true;
      if (timer) clearTimeout(timer);
      return connection;
    } catch (error) {
      connection.retired = true;
      connection.close();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const activate = (connection: Connection) => {
    connection.activated = true;
    const queued = connection.queuedMessages;
    connection.queuedMessages = [];
    for (const message of queued) {
      if (connection.retired) break;
      const update = message.sessionResumptionUpdate;
      if (update?.resumable && update.newHandle) resumeHandle = update.newHandle;
      if (message.goAway) void resume(false);
      onMessage(message);
    }
    flushPendingToolResponses();
  };

  const sendPcm = (data: string) => {
    if (!active || active.retired) {
      heldAudio.push(data);
      // Five seconds of 16 kHz audio at 20 ms a chunk.
      if (heldAudio.length > 250) heldAudio.shift();
      return;
    }
    send((session) =>
      session.sendRealtimeInput({ audio: { data, mimeType: `audio/pcm;rate=${INPUT_RATE}` } }),
    );
  };

  /**
   * Writing to a connection that has just closed throws, and the bridge
   * calls in from timers where a throw would take the process down. During
   * a handover the message is dropped; the resumed session carries on.
   */
  const send = (write: (session: Session) => void) => {
    if (!active || active.retired || !active.session) return;
    try {
      write(active.session);
    } catch (error) {
      events.error(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** Move to a new connection. `lost`: the current one has already closed. */
  const resume = (lost: boolean): Promise<void> => {
    resuming ??= (async () => {
      for (let attempt = 0; attempt < 2 && resumeHandle && !closedByUs; attempt++) {
        try {
          const next = await open(resumeHandle);
          if (closedByUs) {
            next.retired = true;
            next.close();
            return;
          }
          if (!active) {
            next.retired = true;
            next.close();
            return;
          }
          const previous = active;
          previous.retired = true;
          active = next;
          activate(next);
          serverConfirmedInterruption = false;
          if (!lost) previous.close();
          const held = heldAudio;
          heldAudio = [];
          for (const data of held) sendPcm(data);
          return;
        } catch (error) {
          if (!closedByUs)
            events.error(
              new Error(
                `Gemini Live could not resume: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        }
      }
      // After a GoAway the old connection still works until it closes, and
      // its close tries again. A lost connection with no way back is the end.
      if (lost && !closedByUs) {
        transportEnded = true;
        currentTurn = null;
        toolCalls.clear();
        flush();
        events.closed();
      }
    })().finally(() => {
      resuming = null;
    });
    return resuming;
  };

  active = await open();
  activate(active);

  return {
    sendAudio(mulaw) {
      sendPcm(Buffer.from(telephoneToPcm(mulaw, INPUT_RATE)).toString('base64'));
    },
    sendToolResult(call: RealtimeToolCall, result: unknown, followUp = 'respond') {
      if (closedByUs || transportEnded) return;
      const state = toolCalls.get(call.id);
      if (!state) {
        events.error(new Error('Gemini Live ignored a result for an unknown tool call'));
        return;
      }
      if (state.cancelled) return;
      if (state.name !== call.name || state.argsFingerprint !== fingerprintArgs(call.args)) {
        events.error(
          new Error('Gemini Live ignored a result with a conflicting tool call identity'),
        );
        return;
      }
      if (state.submitted || state.result) return;
      state.result = { value: result, followUp };
      scheduleToolResponse(call.id, state);
    },
    respond(instructions) {
      send((session) =>
        session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: instructions ?? 'Continue.' }] }],
          turnComplete: true,
        }),
      );
    },
    // Vertex Live's VAD interruption cancels model generation and reports
    // `serverContent.interrupted`; it has no arbitrary audio truncation offset.
    // If this call was caused by a local clear instead, model history is
    // unknown until a server cancellation arrives, so report that explicitly.
    interrupt(_unplayedMs): RealtimeInterruptionResult {
      if (!serverConfirmedInterruption)
        return { providerState: 'unknown', spokenOffset: 'unknown' };
      serverConfirmedInterruption = false;
      return { providerState: 'cancelled', spokenOffset: 'unknown' };
    },
    usage: () => ({ ...usage }),
    async close() {
      closedByUs = true;
      currentTurn?.pendingIfSilent.clear();
      toolCalls.clear();
      flush();
      if (active) {
        active.retired = true;
        active.close();
      }
    },
  };
}
