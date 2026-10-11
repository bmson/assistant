import {
  Behavior,
  FunctionResponseScheduling,
  type GoogleGenAI,
  type LiveConnectParameters,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
            functionDeclarations: [
              {
                name: 'end_call',
                parametersJsonSchema: { type: 'object' },
                behavior: Behavior.NON_BLOCKING,
              },
            ],
          },
        ],
      },
    });
  });

  it('rejects a setup callback error and closes a late SDK session once', async () => {
    const fake = fakeClient();
    const pending = deferred<Session>();
    let parameters: LiveConnectParameters | undefined;
    const connect = vi.fn((input: LiveConnectParameters) => {
      parameters = input;
      return pending.promise;
    });
    (fake.client.live.connect as unknown as typeof connect) = connect;
    const events = recorder();
    const opening = createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
      connectTimeoutMs: 100,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);

    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    parameters?.callbacks.onerror?.({ message: 'configuration rejected' } as ErrorEvent);
    await expect(opening).rejects.toThrow('configuration rejected');

    pending.resolve(fake.session as unknown as Session);
    await vi.waitFor(() => expect(fake.session.close).toHaveBeenCalledTimes(1));
    parameters?.callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
    parameters?.callbacks.onerror?.({ message: 'late error' } as ErrorEvent);
    expect(events.log).toEqual([]);
  });

  it('times out a hung initial handshake and retires its late session', async () => {
    const fake = fakeClient();
    const pending = deferred<Session>();
    let parameters: LiveConnectParameters | undefined;
    const connect = vi.fn((input: LiveConnectParameters) => {
      parameters = input;
      return pending.promise;
    });
    (fake.client.live.connect as unknown as typeof connect) = connect;
    const events = recorder();
    const opening = createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
      connectTimeoutMs: 5,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);

    await expect(opening).rejects.toThrow('Gemini Live setup timed out');
    pending.resolve(fake.session as unknown as Session);
    await vi.waitFor(() => expect(fake.session.close).toHaveBeenCalledTimes(1));
    parameters?.callbacks.onclose?.({} as CloseEvent);
    expect(events.log).toEqual([]);
  });

  it('bounds resume handshakes and closes sessions that complete after retirement', async () => {
    const first = fakeClient();
    const initialSession = first.session as unknown as Session;
    const pending: Array<ReturnType<typeof deferred<Session>>> = [];
    const connections: LiveConnectParameters[] = [];
    const client = {
      live: {
        connect: vi.fn((input: LiveConnectParameters) => {
          connections.push(input);
          if (connections.length === 1) return Promise.resolve(initialSession);
          const wait = deferred<Session>();
          pending.push(wait);
          return wait.promise;
        }),
      },
    } as unknown as Pick<GoogleGenAI, 'live'>;
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client,
      connectTimeoutMs: 5,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    connections[0]?.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'resume-1' },
    } as LiveServerMessage);
    connections[0]?.callbacks.onclose?.({} as CloseEvent);

    await vi.waitFor(() => expect(events.log).toContainEqual(['closed']), { timeout: 1_000 });
    expect(connections).toHaveLength(3);
    expect(events.log.filter((entry) => (entry as string[])[0] === 'error')).toHaveLength(2);

    for (const [index, late] of pending.entries()) {
      const resumedSession = {
        sendRealtimeInput: vi.fn(),
        sendToolResponse: vi.fn(),
        sendClientContent: vi.fn(),
        close: vi.fn(),
      };
      late.resolve(resumedSession as unknown as Session);
      await vi.waitFor(() => expect(resumedSession.close).toHaveBeenCalledTimes(1));
      connections[index + 1]?.callbacks.onmessage({
        serverContent: { turnComplete: true },
      } as LiveServerMessage);
    }
    expect(events.log.filter((entry) => (entry as string[])[0] === 'closed')).toHaveLength(1);
    await session.close();
    expect(first.session.close).toHaveBeenCalledTimes(1);
  });

  it('retires an in-flight resume when the caller closes and ignores late callbacks', async () => {
    const first = fakeClient();
    const initialSession = first.session as unknown as Session;
    const pending = deferred<Session>();
    const connections: LiveConnectParameters[] = [];
    const client = {
      live: {
        connect: vi.fn((input: LiveConnectParameters) => {
          connections.push(input);
          return connections.length === 1 ? Promise.resolve(initialSession) : pending.promise;
        }),
      },
    } as unknown as Pick<GoogleGenAI, 'live'>;
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client,
      connectTimeoutMs: 100,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    connections[0]?.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'resume-1' },
    } as LiveServerMessage);
    connections[0]?.callbacks.onmessage({ goAway: { timeLeft: '10s' } } as LiveServerMessage);
    await vi.waitFor(() => expect(connections).toHaveLength(2));

    await Promise.all([session.close(), session.close()]);
    expect(first.session.close).toHaveBeenCalledTimes(1);
    const resumedSession = {
      sendRealtimeInput: vi.fn(),
      sendToolResponse: vi.fn(),
      sendClientContent: vi.fn(),
      close: vi.fn(),
    };
    pending.resolve(resumedSession as unknown as Session);
    await vi.waitFor(() => expect(resumedSession.close).toHaveBeenCalledTimes(1));
    connections[1]?.callbacks.onmessage({
      serverContent: { turnComplete: true },
    } as LiveServerMessage);
    connections[1]?.callbacks.onerror?.({ message: 'late error' } as ErrorEvent);
    connections[1]?.callbacks.onclose?.({} as CloseEvent);
    expect(events.log).toEqual([]);
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

    session.sendToolResult({ id: 't1', name: 'end_call', args: { outcome: 'done' } }, { ok: true });
    expect(fake.session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: 't1',
          name: 'end_call',
          response: { output: { ok: true } },
          scheduling: FunctionResponseScheduling.WHEN_IDLE,
        },
      ],
    });
    session.sendToolResult(
      { id: 't1', name: 'end_call', args: { outcome: 'done' } },
      { ok: false, duplicate: true },
    );
    expect(fake.session.sendToolResponse).toHaveBeenCalledTimes(1);
    expect(events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'error')).toHaveLength(
      0,
    );
    session.respond('Greet them.');
    expect(fake.session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: 'Greet them.' }] }],
      turnComplete: true,
    });
    await Promise.all([session.close(), session.close()]);
    expect(fake.session.close).toHaveBeenCalledTimes(1);
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

    // Stale model output remains fenced until the server closes the cancelled
    // turn; only output after that completion is allowed through.
    fake.emit({ serverContent: { modelTurn: { parts: [audio] } } });
    expect(events.log).toEqual([['speechStarted']]);
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

  it('maps none, respond, and interrupted if_silent results to SDK scheduling', async () => {
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

    fake.emit({
      serverContent: { modelTurn: { parts: [audio] } },
      toolCall: {
        functionCalls: [
          { id: 'silent-1', name: 'checkin', args: { private: 'one' } },
          { id: 'silent-2', name: 'checkin', args: { private: 'two' } },
        ],
      },
    });
    session.sendToolResult(
      { id: 'silent-1', name: 'checkin', args: { private: 'one' } },
      { ok: true },
      'if_silent',
    );
    session.sendToolResult(
      { id: 'silent-2', name: 'checkin', args: { private: 'two' } },
      { ok: true },
      'if_silent',
    );
    expect(fake.session.sendToolResponse).not.toHaveBeenCalled();
    fake.emit({ serverContent: { interrupted: true } });
    expect(fake.session.sendToolResponse).toHaveBeenNthCalledWith(1, {
      functionResponses: [
        {
          id: 'silent-1',
          name: 'checkin',
          response: { output: { ok: true } },
          scheduling: FunctionResponseScheduling.SILENT,
        },
      ],
    });
    expect(fake.session.sendToolResponse).toHaveBeenNthCalledWith(2, {
      functionResponses: [
        {
          id: 'silent-2',
          name: 'checkin',
          response: { output: { ok: true } },
          scheduling: FunctionResponseScheduling.SILENT,
        },
      ],
    });

    fake.emit({ toolCall: { functionCalls: [{ id: 'explicit-none', name: 'note', args: {} }] } });
    fake.emit({
      toolCall: { functionCalls: [{ id: 'explicit-respond', name: 'note', args: {} }] },
    });
    session.sendToolResult({ id: 'explicit-none', name: 'note', args: {} }, { ok: true }, 'none');
    session.sendToolResult(
      { id: 'explicit-respond', name: 'note', args: {} },
      { ok: true },
      'respond',
    );
    expect(fake.session.sendToolResponse).toHaveBeenNthCalledWith(3, {
      functionResponses: [
        {
          id: 'explicit-none',
          name: 'note',
          response: { output: { ok: true } },
          scheduling: FunctionResponseScheduling.SILENT,
        },
      ],
    });
    expect(fake.session.sendToolResponse).toHaveBeenNthCalledWith(4, {
      functionResponses: [
        {
          id: 'explicit-respond',
          name: 'note',
          response: { output: { ok: true } },
          scheduling: FunctionResponseScheduling.WHEN_IDLE,
        },
      ],
    });
    await session.close();
  });

  it('settles an outstanding if_silent result on interruption and resume without writing to the retired session', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    fake.emit({ sessionResumptionUpdate: { resumable: true, newHandle: 'resume-if-silent' } });
    fake.emit({ toolCall: { functionCalls: [{ id: 'pending', name: 'checkin', args: {} }] } });
    session.sendToolResult({ id: 'pending', name: 'checkin', args: {} }, { ok: true }, 'if_silent');
    expect(fake.session.sendToolResponse).not.toHaveBeenCalled();

    fake.connections[0]?.callbacks.onclose?.({} as CloseEvent);
    await vi.waitFor(() => expect(fake.connections).toHaveLength(2));
    await vi.waitFor(() => expect(fake.sessions[1]?.sendToolResponse).toHaveBeenCalledTimes(1));
    expect(fake.session.sendToolResponse).not.toHaveBeenCalled();
    expect(fake.sessions[1]?.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        {
          id: 'pending',
          name: 'checkin',
          response: { output: { ok: true } },
          scheduling: FunctionResponseScheduling.WHEN_IDLE,
        },
      ],
    });
    await session.close();
  });

  it('uses the originating turn audio state after later turns have completed', async () => {
    const fake = fakeClient();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, recorder());
    const audio = {
      inlineData: {
        mimeType: 'audio/pcm;rate=24000',
        data: Buffer.from(pcm16ToBytes(new Int16Array(480))).toString('base64'),
      },
    };

    fake.emit({
      serverContent: { modelTurn: { parts: [audio] } },
      toolCall: { functionCalls: [{ id: 'origin-spoke', name: 'checkin', args: {} }] },
    });
    fake.emit({ serverContent: { turnComplete: true } });
    fake.emit({
      toolCall: { functionCalls: [{ id: 'origin-silent', name: 'checkin', args: {} }] },
    });
    fake.emit({ serverContent: { turnComplete: true } });

    // Resolve the old results after both originating turns are complete.
    // Audio from a later turn cannot change either call's follow-up policy.
    session.sendToolResult({ id: 'origin-spoke', name: 'checkin', args: {} }, {}, 'if_silent');
    session.sendToolResult({ id: 'origin-silent', name: 'checkin', args: {} }, {}, 'if_silent');
    expect(fake.session.sendToolResponse).toHaveBeenNthCalledWith(1, {
      functionResponses: [
        {
          id: 'origin-spoke',
          name: 'checkin',
          response: { output: {} },
          scheduling: FunctionResponseScheduling.SILENT,
        },
      ],
    });
    expect(fake.session.sendToolResponse).toHaveBeenNthCalledWith(2, {
      functionResponses: [
        {
          id: 'origin-silent',
          name: 'checkin',
          response: { output: {} },
          scheduling: FunctionResponseScheduling.WHEN_IDLE,
        },
      ],
    });
    await session.close();
  });

  it('drops deferred if_silent results when explicitly closed before turn completion', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    fake.emit({ toolCall: { functionCalls: [{ id: 'pending', name: 'checkin', args: {} }] } });
    session.sendToolResult({ id: 'pending', name: 'checkin', args: {} }, { ok: true }, 'if_silent');
    await session.close();
    session.sendToolResult({ id: 'pending', name: 'checkin', args: {} }, { ok: true }, 'if_silent');
    fake.emit({ serverContent: { turnComplete: true } });
    expect(fake.session.sendToolResponse).not.toHaveBeenCalled();
  });

  it('retires cancelled call IDs and ignores late results and replayed tool calls', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);

    fake.emit({
      toolCall: {
        functionCalls: [{ id: 'cancelled-call', name: 'checkin', args: { day: 'today' } }],
      },
    });
    session.sendToolResult(
      { id: 'cancelled-call', name: 'checkin', args: { day: 'today' } },
      { noted: true },
      'if_silent',
    );
    fake.emit({ toolCallCancellation: { ids: ['cancelled-call'] } });
    fake.emit({ serverContent: { turnComplete: true } });
    session.sendToolResult(
      { id: 'cancelled-call', name: 'checkin', args: { day: 'today' } },
      { noted: true },
      'respond',
    );
    fake.emit({
      toolCall: {
        functionCalls: [{ id: 'cancelled-call', name: 'checkin', args: { day: 'today' } }],
      },
    });

    expect(fake.session.sendToolResponse).not.toHaveBeenCalled();
    expect(
      events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'toolCall'),
    ).toHaveLength(1);
    await session.close();
  });

  it('fails closed on unknown results and reports changed call identity without exposing arguments', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    fake.emit({
      toolCall: {
        functionCalls: [{ id: 'stable-id', name: 'checkin', args: { private: 'first' } }],
      },
    });
    fake.emit({
      toolCall: {
        functionCalls: [{ id: 'stable-id', name: 'checkin', args: { private: 'changed' } }],
      },
    });
    session.sendToolResult({ id: 'unknown-id', name: 'checkin', args: {} }, { ok: true });
    session.sendToolResult({ id: 'stable-id', name: 'different-tool', args: {} }, { ok: true });
    session.sendToolResult(
      { id: 'stable-id', name: 'checkin', args: { private: 'changed' } },
      { ok: true },
    );

    const errors = events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'error');
    expect(errors).toEqual([
      ['error', 'Gemini Live received a conflicting tool call identity'],
      ['error', 'Gemini Live ignored a result for an unknown tool call'],
      ['error', 'Gemini Live ignored a result with a conflicting tool call identity'],
      ['error', 'Gemini Live ignored a result with a conflicting tool call identity'],
    ]);
    expect(JSON.stringify(errors)).not.toContain('private');
    expect(fake.session.sendToolResponse).not.toHaveBeenCalled();
    await session.close();
  });

  it('does not forward SDK tool-response errors into owner diagnostics', async () => {
    const fake = fakeClient();
    const events = recorder();
    const session = await createGeminiLiveProvider({
      project: 'p',
      location: 'us-central1',
      client: fake.client,
    }).connect({ model: 'gemini-live', instructions: '', tools: [] }, events);
    fake.session.sendToolResponse.mockImplementation(() => {
      throw new Error('private function arguments');
    });
    events.log.length = 0;

    fake.emit({ toolCall: { functionCalls: [{ id: 'sensitive-id', name: 'checkin', args: {} }] } });
    session.sendToolResult({ id: 'sensitive-id', name: 'checkin', args: {} }, {}, 'none');

    expect(events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'error')).toEqual([
      ['error', 'Gemini Live could not submit a tool response'],
    ]);
    expect(
      events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'error'),
    ).not.toContainEqual(expect.arrayContaining(['error', 'private function arguments']));
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
