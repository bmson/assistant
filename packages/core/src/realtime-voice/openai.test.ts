import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createOpenAIRealtimeProvider } from './openai.js';
import type { RealtimeSessionEvents } from './types.js';

let server: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeRealtime(): Promise<{
  url: string;
  received: Array<Record<string, unknown>>;
  headers: Promise<Record<string, string | string[] | undefined>>;
  client: Promise<WebSocket>;
}> {
  const received: Array<Record<string, unknown>> = [];
  let resolveClient: (socket: WebSocket) => void = () => {};
  let resolveHeaders: (headers: Record<string, string | string[] | undefined>) => void = () => {};
  const client = new Promise<WebSocket>((resolve) => {
    resolveClient = resolve;
  });
  const headers = new Promise<Record<string, string | string[] | undefined>>((resolve) => {
    resolveHeaders = resolve;
  });
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  server.on('connection', (socket, request) => {
    resolveHeaders(request.headers);
    socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    resolveClient(socket);
  });
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${address.port}`, received, headers, client };
}

function recorder(): RealtimeSessionEvents & { log: unknown[] } {
  const log: unknown[] = [];
  return {
    log,
    audio: (bytes) => log.push(['audio', [...bytes]]),
    speechStarted: () => log.push(['speechStarted']),
    transcript: (role, text) => log.push(['transcript', role, text]),
    toolCall: (call) => log.push(['toolCall', call]),
    error: (error) => log.push(['error', error.message]),
    closed: () => log.push(['closed']),
  };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

describe('OpenAI Realtime adapter', () => {
  it('configures a μ-law phone session with the brief, voice and tools', async () => {
    const fake = await fakeRealtime();
    const session = await createOpenAIRealtimeProvider({
      apiKey: 'sk-test',
      url: fake.url,
    }).connect(
      {
        model: 'gpt-realtime',
        instructions: 'Book a table for two.',
        voice: 'marin',
        tools: [{ name: 'end_call', description: 'Hang up.', parameters: { type: 'object' } }],
      },
      recorder(),
    );
    expect((await fake.headers).authorization).toBe('Bearer sk-test');
    await until(() => fake.received.length === 1);
    expect(fake.received[0]).toMatchObject({
      type: 'session.update',
      session: {
        instructions: 'Book a table for two.',
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: { model: 'gpt-live-transcribe' },
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'marin' },
        },
        tools: [{ type: 'function', name: 'end_call' }],
      },
    });

    session.sendAudio(Uint8Array.of(1, 2, 3));
    session.respond('Greet them.');
    await until(() => fake.received.length === 3);
    expect(fake.received[1]).toEqual({ type: 'input_audio_buffer.append', audio: 'AQID' });
    expect(fake.received[2]).toEqual({
      type: 'response.create',
      response: { instructions: 'Greet them.' },
    });
    await session.close();
  });

  it('relays audio, barge-in, transcripts, tool calls and usage', async () => {
    const fake = await fakeRealtime();
    const events = recorder();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      events,
    );
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    push({ type: 'response.output_audio.delta', item_id: 'item_1', delta: 'AQI=' });
    // One second of μ-law speech: the truncation below is measured against it.
    push({
      type: 'response.output_audio.delta',
      item_id: 'item_1',
      delta: Buffer.alloc(7_998).toString('base64'),
    });
    push({ type: 'input_audio_buffer.speech_started' });
    push({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' 7pm? ' });
    push({ type: 'response.output_audio_transcript.done', transcript: 'Seven works.' });
    push({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'ask_owner',
      arguments: '{"question":"7pm ok?"}',
    });
    push({
      type: 'response.done',
      response: {
        usage: {
          input_token_details: { audio_tokens: 100, text_tokens: 50, cached_tokens: 10 },
          output_token_details: { audio_tokens: 200, text_tokens: 20 },
        },
      },
    });
    await until(() => events.log.length === 6);
    expect(events.log).toEqual([
      ['audio', [1, 2]],
      ['audio', new Array(7_998).fill(0)],
      ['speechStarted'],
      ['transcript', 'caller', '7pm?'],
      ['transcript', 'assistant', 'Seven works.'],
      ['toolCall', { id: 'call_1', name: 'ask_owner', args: { question: '7pm ok?' } }],
    ]);
    await until(() => session.usage().outputAudioTokens === 200);
    expect(session.usage()).toEqual({
      inputAudioTokens: 100,
      inputTextTokens: 50,
      cachedInputTokens: 10,
      cachedAudioInputTokens: 0,
      cachedTextInputTokens: 0,
      cachedUnclassifiedInputTokens: 10,
      outputAudioTokens: 200,
      outputTextTokens: 20,
      reasoningOutputTokens: 0,
      reasoningUsageReported: false,
      transcriptionInputAudioTokens: 0,
      transcriptionOutputTextTokens: 0,
      transcriptionUsageReported: false,
      transcriptionInputAudioMilliseconds: 0,
    });

    // 360 ms of the second was still unplayed: the caller heard 640 ms.
    session.interrupt(360);
    session.sendToolResult({ id: 'call_1', name: 'ask_owner', args: {} }, { answer: 'yes' });
    await until(() => fake.received.length === 4);
    expect(fake.received.slice(1)).toEqual([
      {
        type: 'conversation.item.truncate',
        item_id: 'item_1',
        content_index: 0,
        audio_end_ms: 640,
      },
      {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: 'call_1', output: '{"answer":"yes"}' },
      },
      { type: 'response.create' },
    ]);

    socket.close();
    await until(() => events.log.some((entry) => (entry as string[])[0] === 'closed'));
  });

  it('holds a reply request until the response in flight is done', async () => {
    const fake = await fakeRealtime();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      recorder(),
    );
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    push({ type: 'response.created' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Sent now, the API would refuse both and the caller would hear nothing.
    session.respond('Wrap up now.');
    session.respond();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.received.filter((event) => event.type === 'response.create')).toEqual([]);
    push({ type: 'response.done', response: {} });
    await until(() => fake.received.some((event) => event.type === 'response.create'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.received.filter((event) => event.type === 'response.create')).toEqual([
      { type: 'response.create', response: { instructions: 'Wrap up now.' } },
    ]);
    await session.close();
  });

  it('speaks after a tool result only when the turn needs a reply', async () => {
    const fake = await fakeRealtime();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      recorder(),
    );
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    const call = (id: string, name: string) => {
      push({ type: 'response.function_call_arguments.done', call_id: id, name, arguments: '{}' });
    };
    const creates = () => fake.received.filter((event) => event.type === 'response.create');
    const outputs = () =>
      fake.received.filter((event) => event.type === 'conversation.item.create').length;

    // Spoke, then noted a fact: another reply would repeat what was just said.
    push({ type: 'response.created' });
    push({ type: 'response.output_audio.delta', item_id: 'item_1', delta: 'AQI=' });
    call('spoken_note', 'note');
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.sendToolResult(
      { id: 'spoken_note', name: 'note', args: {} },
      { noted: true },
      'if_silent',
    );
    push({ type: 'response.done', response: {} });
    await until(() => outputs() === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creates()).toHaveLength(0);

    // Noted without speaking: the caller is still owed an answer.
    push({ type: 'response.created' });
    call('silent_note', 'note');
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.sendToolResult(
      { id: 'silent_note', name: 'note', args: {} },
      { noted: true },
      'if_silent',
    );
    push({ type: 'response.done', response: {} });
    await until(() => creates().length === 1);

    // Hanging up: no second goodbye.
    push({ type: 'response.created' });
    call('bye', 'end_call');
    push({ type: 'response.done', response: {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.sendToolResult({ id: 'bye', name: 'end_call', args: {} }, { ok: true }, 'none');
    await until(() => outputs() === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creates()).toHaveLength(1);
    await session.close();
  });

  it('asks for a reply when a finished caller turn gets none', async () => {
    const fake = await fakeRealtime();
    const session = await createOpenAIRealtimeProvider({
      apiKey: 'k',
      url: fake.url,
      replyStallMs: 60,
    }).connect({ model: 'gpt-realtime', instructions: '', tools: [] }, recorder());
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    const creates = () => fake.received.filter((event) => event.type === 'response.create');

    // Turn detection answered in time: nothing extra.
    push({ type: 'input_audio_buffer.speech_stopped' });
    push({ type: 'response.created' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(creates()).toHaveLength(0);
    push({ type: 'response.done', response: {} });

    // Its reply was lost: the caller is not left in silence.
    push({ type: 'input_audio_buffer.speech_stopped' });
    await until(() => creates().length === 1);
    expect(creates()[0]).toEqual({ type: 'response.create' });
    await session.close();
  });

  it('refuses model names that could alter the URL', async () => {
    await expect(
      createOpenAIRealtimeProvider({ apiKey: 'k', url: 'ws://unused' }).connect(
        { model: 'gpt&x=1', instructions: '', tools: [] },
        recorder(),
      ),
    ).rejects.toThrow('Not an OpenAI realtime model name');
  });
});
