import {
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
  /** Injected for tests. */
  client?: Pick<GoogleGenAI, 'live'>;
}

const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;

type TokenDetail = { modality?: string; tokenCount?: number };

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
      return connectGeminiLive(client, config, events);
    },
  };
}

async function connectGeminiLive(
  client: Pick<GoogleGenAI, 'live'>,
  request: RealtimeSessionConfig,
  events: RealtimeSessionEvents,
): Promise<RealtimeSession> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(request.model))
    throw new Error(`Not a Vertex live model name: ${request.model}`);
  const usage: RealtimeUsage = emptyRealtimeUsage();
  let callerText = '';
  let assistantText = '';
  let closedByUs = false;
  let serverConfirmedInterruption = false;
  let fenceInterruptedOutput = false;

  const flush = () => {
    if (callerText.trim()) events.transcript('caller', callerText.trim());
    if (assistantText.trim()) events.transcript('assistant', assistantText.trim());
    callerText = '';
    assistantText = '';
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
      // The model has started answering: the caller's turn is complete.
      if (callerText.trim()) {
        events.transcript('caller', callerText.trim());
        callerText = '';
      }
      assistantText += content.outputTranscription.text;
    }
    for (const part of fenceInterruptedOutput ? [] : (content?.modelTurn?.parts ?? [])) {
      const data = part.inlineData?.data;
      if (data && part.inlineData?.mimeType?.startsWith('audio/'))
        events.audio(pcmToTelephone(new Uint8Array(Buffer.from(data, 'base64')), OUTPUT_RATE));
    }
    if (content?.turnComplete) {
      flush();
      fenceInterruptedOutput = false;
      // Do not carry an unused confirmation into a later, unrelated local
      // clear when no playback was pending during the barge-in.
      serverConfirmedInterruption = false;
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (call.id && call.name)
        events.toolCall({ id: call.id, name: call.name, args: call.args ?? {} });
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

  type Connection = { session: Session; retired: boolean };
  let active: Connection;

  const open = async (handle?: string): Promise<Connection> => {
    const connection = { retired: false } as Connection;
    connection.session = await client.live.connect({
      model: request.model,
      config: { ...liveConfig, sessionResumption: handle ? { handle } : {} },
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          if (connection.retired) return;
          const update = message.sessionResumptionUpdate;
          if (update?.resumable && update.newHandle) resumeHandle = update.newHandle;
          if (message.goAway) void resume(false);
          onMessage(message);
        },
        onerror: (event) =>
          events.error(new Error(`Gemini Live error: ${String(event.message ?? event)}`)),
        onclose: () => {
          if (connection.retired || closedByUs) return;
          connection.retired = true;
          // A GoAway handover may still be in flight; if it lands, this
          // connection is no longer the active one and there is nothing to do.
          void Promise.resolve(resuming).then(() =>
            active === connection ? resume(true) : undefined,
          );
        },
      },
    });
    return connection;
  };

  const sendPcm = (data: string) => {
    if (active.retired) {
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
    if (active.retired) return;
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
            next.session.close();
            return;
          }
          const previous = active;
          previous.retired = true;
          active = next;
          serverConfirmedInterruption = false;
          if (!lost) previous.session.close();
          const held = heldAudio;
          heldAudio = [];
          for (const data of held) sendPcm(data);
          return;
        } catch (error) {
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
        flush();
        events.closed();
      }
    })().finally(() => {
      resuming = null;
    });
    return resuming;
  };

  active = await open();

  return {
    sendAudio(mulaw) {
      sendPcm(Buffer.from(telephoneToPcm(mulaw, INPUT_RATE)).toString('base64'));
    },
    sendToolResult(call: RealtimeToolCall, result: unknown) {
      send((session) =>
        session.sendToolResponse({
          functionResponses: [{ id: call.id, name: call.name, response: { output: result } }],
        }),
      );
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
      flush();
      active.retired = true;
      active.session.close();
    },
  };
}
