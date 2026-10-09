import type { GoogleGenAI, LiveConnectParameters, LiveServerMessage } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { pcm16ToBytes } from './audio-codec.js';
import { createGeminiLiveProvider } from './gemini.js';
import type { RealtimeSessionEvents } from './types.js';

function fakeClient() {
  const makeSession = () => ({
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
    sendClientContent: vi.fn(),
    close: vi.fn(),
  });
  // One session per connection, so a resumed call can be told apart.
  const sessions = [makeSession()];
  const connections: LiveConnectParameters[] = [];
  const client = {
    live: {
      connect: vi.fn(async (input: LiveConnectParameters) => {
        connections.push(input);
        if (connections.length > sessions.length) sessions.push(makeSession());
        return sessions[connections.length - 1];
      }),
    },
  } as unknown as Pick<GoogleGenAI, 'live'>;
  return {
    client,
    session: sessions[0] as ReturnType<typeof makeSession>,
    sessions,
    connections,
    params: () => connections.at(-1) as LiveConnectParameters,
    emit: (message: Partial<LiveServerMessage>, connection = connections.length - 1) =>
      connections[connection]?.callbacks.onmessage(message as LiveServerMessage),
  };
}

function recorder(): RealtimeSessionEvents & { log: unknown[] } {
  const log: unknown[] = [];
  return {
    log,
    audio: (bytes) => log.push(['audio', bytes.length]),
    speechStarted: () => log.push(['speechStarted']),
    transcript: (role, text) => log.push(['transcript', role, text]),
    toolCall: (call) => log.push(['toolCall', call]),
    error: (error) => log.push(['error', error.message]),
    closed: () => log.push(['closed']),
  };
}

describe('Gemini Live adapter', () => {
  it('opens an audio session with the brief, voice, transcription and tools', async () => {
    const fake = fakeClient();
    await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect(
      {
        model: 'gemini-live-2.5-flash-native-audio',
        instructions: 'Ask about opening hours.',
        voice: 'Aoede',
        tools: [{ name: 'end_call', description: 'Hang up.', parameters: { type: 'object' } }],
      },
      recorder(),
    );
    expect(fake.params()).toMatchObject({
      model: 'gemini-live-2.5-flash-native-audio',
      config: {
        responseModalities: ['AUDIO'],
        systemInstruction: 'Ask about opening hours.',
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
        tools: [
          {
            functionDeclarations: [{ name: 'end_call', parametersJsonSchema: { type: 'object' } }],
          },
        ],
      },
    });
  });

  it('transcodes phone audio both ways and relays turns, tools and usage', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);

    session.sendAudio(new Uint8Array(160));
    const sent = fake.session.sendRealtimeInput.mock.calls[0]?.[0];
    expect(sent.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(Buffer.from(sent.audio.data, 'base64')).toHaveLength(640);

    fake.emit({ serverContent: { inputTranscription: { text: 'We open ' } } });
    fake.emit({ serverContent: { inputTranscription: { text: 'at nine.' } } });
    fake.emit({
      serverContent: {
        outputTranscription: { text: 'Thanks!' },
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: Buffer.from(pcm16ToBytes(new Int16Array(480))).toString('base64'),
              },
            },
          ],
        },
      },
    });
    fake.emit({
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokenCount: 120,
        promptTokensDetails: [
          { modality: 'AUDIO' as never, tokenCount: 100 },
          { modality: 'TEXT' as never, tokenCount: 20 },
        ],
        responseTokenCount: 50,
        responseTokensDetails: [{ modality: 'AUDIO' as never, tokenCount: 50 }],
      },
    });
    fake.emit({ serverContent: { interrupted: true } });
    expect(session.interrupt(20)).toEqual({
      providerState: 'cancelled',
      spokenOffset: 'unknown',
    });
    fake.emit({
      toolCall: { functionCalls: [{ id: 't1', name: 'end_call', args: { outcome: 'done' } }] },
    });

    expect(events.log).toEqual([
      ['transcript', 'caller', 'We open at nine.'],
      ['audio', 160],
      ['transcript', 'assistant', 'Thanks!'],
      ['speechStarted'],
      ['toolCall', { id: 't1', name: 'end_call', args: { outcome: 'done' } }],
    ]);
    expect(session.usage()).toEqual({
      inputAudioTokens: 100,
      inputTextTokens: 20,
      cachedInputTokens: 0,
      cachedAudioInputTokens: 0,
      cachedTextInputTokens: 0,
      cachedUnclassifiedInputTokens: 0,
      outputAudioTokens: 50,
      outputTextTokens: 0,
      reasoningOutputTokens: 0,
      reasoningUsageReported: false,
      transcriptionInputAudioTokens: 0,
      transcriptionOutputTextTokens: 0,
      transcriptionUsageReported: false,
      transcriptionInputAudioMilliseconds: 0,
    });

    session.sendToolResult({ id: 't1', name: 'end_call', args: {} }, { ok: true });
    expect(fake.session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: 't1', name: 'end_call', response: { output: { ok: true } } }],
    });
    session.respond('Greet them.');
    expect(fake.session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: 'Greet them.' }] }],
      turnComplete: true,
    });
    await session.close();
    fake.params().callbacks.onclose?.({} as CloseEvent);
    expect(events.log.at(-1)).toEqual(['toolCall', expect.anything()]);
  });

  it('fences interrupted output and reports unknown model state without server confirmation', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    const audio = {
      inlineData: {
        mimeType: 'audio/pcm;rate=24000',
        data: Buffer.from(pcm16ToBytes(new Int16Array(480))).toString('base64'),
      },
    };

    expect(session.interrupt(20)).toEqual({
      providerState: 'unknown',
      spokenOffset: 'unknown',
    });
    fake.emit({
      serverContent: { interrupted: true, modelTurn: { parts: [audio] } },
    });
    expect(events.log).toEqual([['speechStarted']]);
    expect(session.interrupt(20)).toEqual({
      providerState: 'cancelled',
      spokenOffset: 'unknown',
    });

    // The interruption message ends the cancelled turn. Only output on the
    // following turn is allowed through the adapter.
    fake.emit({ serverContent: { turnComplete: true } });
    fake.emit({ serverContent: { modelTurn: { parts: [audio] } } });
    expect(events.log).toEqual([['speechStarted'], ['audio', 160]]);

    // If there was no queued audio, the bridge has no reason to call
    // interrupt(); a completed old confirmation must not leak to a later clear.
    fake.emit({ serverContent: { interrupted: true, turnComplete: true } });
    expect(session.interrupt(20)).toEqual({
      providerState: 'unknown',
      spokenOffset: 'unknown',
    });
    await session.close();
  });

  it('hands the conversation to a new connection when the server says GoAway', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    expect(fake.params().config?.sessionResumption).toEqual({});
    expect(fake.params().config?.contextWindowCompression).toEqual({ slidingWindow: {} });

    fake.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
    fake.emit({ goAway: { timeLeft: '10s' } });
    await vi.waitFor(() => expect(fake.connections).toHaveLength(2));
    expect(fake.connections[1]?.config?.sessionResumption).toEqual({ handle: 'handle-1' });
    await vi.waitFor(() => expect(fake.session.close).toHaveBeenCalled());

    session.sendAudio(new Uint8Array(160));
    expect(fake.sessions[1]?.sendRealtimeInput).toHaveBeenCalledTimes(1);
    expect(fake.session.sendRealtimeInput).not.toHaveBeenCalled();
    // The retired connection's close is expected, not the call ending.
    fake.connections[0]?.callbacks.onclose?.({} as CloseEvent);
    fake.emit(
      {
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/pcm;rate=24000',
                  data: Buffer.from(pcm16ToBytes(new Int16Array(480))).toString('base64'),
                },
              },
            ],
          },
        },
      },
      0,
    );
    expect(events.log).not.toContainEqual(['closed']);
    expect(events.log).not.toContainEqual(['audio', 160]);
    await session.close();
  });

  it('resumes a dropped connection, and reports the end only when it cannot', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);

    fake.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
    fake.connections[0]?.callbacks.onclose?.({} as CloseEvent);
    // Speech in the gap is held and replayed on the new connection.
    session.sendAudio(new Uint8Array(160));
    await vi.waitFor(() => expect(fake.connections).toHaveLength(2));
    await vi.waitFor(() => expect(fake.sessions[1]?.sendRealtimeInput).toHaveBeenCalledTimes(1));
    expect(events.log).not.toContainEqual(['closed']);

    // No handle to resume from: the call has lost its model.
    const fresh = fakeClient();
    const freshEvents = recorder();
    await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fresh.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, freshEvents);
    fresh.params().callbacks.onclose?.({} as CloseEvent);
    await vi.waitFor(() => expect(freshEvents.log).toContainEqual(['closed']));
    expect(fresh.connections).toHaveLength(1);
    await session.close();
  });
});
