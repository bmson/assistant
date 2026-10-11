import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { createOpenAIRealtimeProvider } from './openai.js';
import type { RealtimeSessionEvents } from './types.js';

let server: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function fakeRealtime(options: { setup?: 'ack' | 'reject' | 'hold' | 'late' } = {}): Promise<{
  url: string;
  received: Array<Record<string, unknown>>;
  headers: Promise<Record<string, string | string[] | undefined>>;
  client: Promise<WebSocket>;
  closed: () => number;
}> {
  const received: Array<Record<string, unknown>> = [];
  let closeCount = 0;
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
    socket.on('close', () => closeCount++);
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(event);
      if (event.type === 'session.update') {
        const setup = options.setup ?? 'ack';
        if (setup === 'ack')
          socket.send(JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }));
        else if (setup === 'reject')
          socket.send(
            JSON.stringify({ type: 'error', error: { message: 'invalid session config' } }),
          );
        else if (setup === 'late')
          setTimeout(() => {
            if (socket.readyState === socket.OPEN)
              socket.send(
                JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }),
              );
          }, 80);
      }
    });
    resolveClient(socket);
  });
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    headers,
    client,
    closed: () => closeCount,
  };
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

function responseItem(callId: string, name: string, argumentsJson: string, status = 'completed') {
  return { type: 'function_call', status, call_id: callId, name, arguments: argumentsJson };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

describe('OpenAI Realtime adapter', () => {
  it('configures a μ-law phone session with the brief, voice and tools', async () => {
    const fake = await fakeRealtime({ setup: 'ack' });
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

  it('does not return a session until the server confirms configuration', async () => {
    const fake = await fakeRealtime({ setup: 'hold' });
    let settled = false;
    const opening = createOpenAIRealtimeProvider({ apiKey: 'sk-test', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: 'Test setup.', tools: [] },
      recorder(),
    );
    void opening.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await until(() => fake.received.some((event) => event.type === 'session.update'));
    expect(settled).toBe(false);
    (await fake.client).send(
      JSON.stringify({ type: 'session.updated', session: { type: 'realtime' } }),
    );
    const session = await opening;
    expect(session).toBeDefined();
    await session.close();
  });

  it('rejects a server setup error and retires the fake socket', async () => {
    const fake = await fakeRealtime({ setup: 'reject' });
    const events = recorder();
    const opening = createOpenAIRealtimeProvider({
      apiKey: 'sk-test',
      url: fake.url,
      connectTimeoutMs: 100,
    }).connect({ model: 'gpt-realtime', instructions: '', tools: [] }, events);
    await expect(opening).rejects.toThrow('invalid session config');
    await until(() => fake.closed() === 1);
    expect(events.log).toEqual([]);
  });

  it('times out without setup acknowledgment and retires a late fake acknowledgment', async () => {
    const fake = await fakeRealtime({ setup: 'late' });
    const events = recorder();
    const opening = createOpenAIRealtimeProvider({
      apiKey: 'sk-test',
      url: fake.url,
      connectTimeoutMs: 10,
    }).connect({ model: 'gpt-realtime', instructions: '', tools: [] }, events);
    await expect(opening).rejects.toThrow('OpenAI Realtime setup timed out');
    await until(() => fake.closed() === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.log).toEqual([]);
    expect(fake.received.map((event) => event.type)).toEqual(['session.update']);
  });

  it('makes close idempotent after successful setup', async () => {
    const fake = await fakeRealtime();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      recorder(),
    );
    const firstClose = session.close();
    expect(session.close()).toBe(firstClose);
    await firstClose;
    await until(() => fake.closed() === 1);
    expect(fake.closed()).toBe(1);
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
    push({ type: 'response.created', response: { id: 'resp_1' } });
    push({
      type: 'response.output_audio.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: 'AQI=',
    });
    // One second of μ-law speech: the truncation below is measured against it.
    push({
      type: 'response.output_audio.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: Buffer.alloc(7_998).toString('base64'),
    });
    push({ type: 'input_audio_buffer.speech_started' });
    push({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' 7pm? ' });
    push({ type: 'response.output_audio_transcript.done', transcript: 'Seven works.' });
    push({
      type: 'response.function_call_arguments.done',
      response_id: 'resp_1',
      call_id: 'call_1',
      name: 'ask_owner',
      arguments: '{"question":"7pm ok?"}',
    });
    push({
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [responseItem('call_1', 'ask_owner', '{"question":"7pm ok?"}')],
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
    session.sendToolResult(
      { id: 'call_1', name: 'ask_owner', args: { question: '7pm ok?' } },
      { answer: 'yes' },
    );
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
    push({ type: 'response.created', response: { id: 'resp_2' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Sent now, the API would refuse both and the caller would hear nothing.
    session.respond('Wrap up now.');
    session.respond();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.received.filter((event) => event.type === 'response.create')).toEqual([]);
    push({ type: 'response.done', response: { id: 'resp_2', status: 'completed', output: [] } });
    await until(() => fake.received.some((event) => event.type === 'response.create'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.received.filter((event) => event.type === 'response.create')).toEqual([
      { type: 'response.create', response: { instructions: 'Wrap up now.' } },
    ]);
    await session.close();
  });

  it('speaks after a tool result only when the turn needs a reply', async () => {
    const fake = await fakeRealtime();
    const events = recorder();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      events,
    );
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    const call = (responseId: string, id: string, name: string, argumentsJson = '{}') => {
      push({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: id,
        name,
        arguments: argumentsJson,
      });
    };
    const finish = (responseId: string, ...items: Array<Record<string, unknown>>) => {
      push({
        type: 'response.done',
        response: { id: responseId, status: 'completed', output: items },
      });
    };
    const creates = () => fake.received.filter((event) => event.type === 'response.create');
    const outputs = () =>
      fake.received.filter((event) => event.type === 'conversation.item.create').length;

    // Spoke, then noted a fact: another reply would repeat what was just said.
    push({ type: 'response.created', response: { id: 'resp_spoken' } });
    push({
      type: 'response.output_audio.delta',
      response_id: 'resp_spoken',
      item_id: 'item_1',
      delta: 'AQI=',
    });
    call('resp_spoken', 'spoken_note', 'note');
    finish('resp_spoken', responseItem('spoken_note', 'note', '{}'));
    await until(() => events.log.some((entry) => JSON.stringify(entry).includes('spoken_note')));
    session.sendToolResult(
      { id: 'spoken_note', name: 'note', args: {} },
      { noted: true },
      'if_silent',
    );
    await until(() => outputs() === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creates()).toHaveLength(0);

    // Noted without speaking: the caller is still owed an answer.
    push({ type: 'response.created', response: { id: 'resp_silent' } });
    call('resp_silent', 'silent_note', 'note');
    finish('resp_silent', responseItem('silent_note', 'note', '{}'));
    await until(() => events.log.some((entry) => JSON.stringify(entry).includes('silent_note')));
    session.sendToolResult(
      { id: 'silent_note', name: 'note', args: {} },
      { noted: true },
      'if_silent',
    );
    await until(() => creates().length === 1);

    // Hanging up: no second goodbye.
    push({ type: 'response.created', response: { id: 'resp_bye' } });
    call('resp_bye', 'bye', 'end_call');
    finish('resp_bye', responseItem('bye', 'end_call', '{}'));
    await until(() => events.log.some((entry) => JSON.stringify(entry).includes('bye')));
    session.sendToolResult({ id: 'bye', name: 'end_call', args: {} }, { ok: true }, 'none');
    await until(() => outputs() === 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(creates()).toHaveLength(1);
    await session.close();
  });

  it('dispatches only function calls confirmed by a successful completed response', async () => {
    const fake = await fakeRealtime();
    const events = recorder();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      events,
    );
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    const call = (responseId: string, id: string, argumentsJson = '{"secret":"private"}') =>
      push({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: id,
        name: 'note',
        arguments: argumentsJson,
      });
    const finish = (responseId: string, status: string, output: Array<Record<string, unknown>>) =>
      push({ type: 'response.done', response: { id: responseId, status, output } });

    for (const [responseId, status] of [
      ['resp_cancelled', 'cancelled'],
      ['resp_incomplete', 'incomplete'],
      ['resp_failed', 'failed'],
    ] as const) {
      push({ type: 'response.created', response: { id: responseId } });
      call(responseId, responseId);
      finish(responseId, status, [responseItem(responseId, 'note', '{"secret":"private"}')]);
    }
    push({ type: 'response.created', response: { id: 'resp_missing_item' } });
    call('resp_missing_item', 'missing_item');
    finish('resp_missing_item', 'completed', []);

    push({ type: 'response.created', response: { id: 'resp_unobserved_call' } });
    finish('resp_unobserved_call', 'completed', [
      responseItem('unobserved_call', 'note', '{"secret":"private"}'),
    ]);

    push({ type: 'response.created', response: { id: 'resp_mismatched_item' } });
    call('resp_mismatched_item', 'mismatched_item');
    finish('resp_mismatched_item', 'completed', [
      responseItem('mismatched_item', 'note', '{"secret":"changed"}'),
    ]);

    push({ type: 'response.created', response: { id: 'resp_incomplete_item' } });
    call('resp_incomplete_item', 'incomplete_item');
    finish('resp_incomplete_item', 'completed', [
      responseItem('incomplete_item', 'note', '{"secret":"private"}', 'incomplete'),
    ]);

    push({ type: 'response.created', response: { id: 'resp_changed_duplicate' } });
    call('resp_changed_duplicate', 'changed_duplicate');
    call('resp_changed_duplicate', 'changed_duplicate', '{"secret":"changed"}');
    finish('resp_changed_duplicate', 'completed', [
      responseItem('changed_duplicate', 'note', '{"secret":"private"}'),
    ]);

    push({ type: 'response.created', response: { id: 'resp_valid' } });
    call('resp_valid', 'valid_call');
    finish('resp_valid', 'completed', [responseItem('valid_call', 'note', '{"secret":"private"}')]);

    await until(() => events.log.some((entry) => JSON.stringify(entry).includes('valid_call')));
    expect(events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'toolCall')).toEqual([
      ['toolCall', { id: 'valid_call', name: 'note', args: { secret: 'private' } }],
    ]);
    const errors = events.log
      .filter((entry) => Array.isArray(entry) && entry[0] === 'error')
      .map((entry) => JSON.stringify(entry));
    expect(errors.length).toBeGreaterThanOrEqual(8);
    expect(errors.join('\n')).not.toContain('private');
    expect(errors.join('\n')).not.toContain('changed');
    session.sendToolResult(
      { id: 'valid_call', name: 'note', args: { secret: 'private' } },
      { noted: true },
      'none',
    );
    await until(() => fake.received.some((event) => event.type === 'conversation.item.create'));
    await session.close();
  });

  it('deduplicates exact IDs and rejects changed arguments without rebinding the first turn', async () => {
    const fake = await fakeRealtime();
    const events = recorder();
    const session = await createOpenAIRealtimeProvider({ apiKey: 'k', url: fake.url }).connect(
      { model: 'gpt-realtime', instructions: '', tools: [] },
      events,
    );
    const socket = await fake.client;
    const push = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    const call = (responseId: string, argumentsJson: string) =>
      push({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: 'stable_id',
        name: 'note',
        arguments: argumentsJson,
      });
    const finish = (responseId: string, argumentsJson: string) =>
      push({
        type: 'response.done',
        response: {
          id: responseId,
          status: 'completed',
          output: [responseItem('stable_id', 'note', argumentsJson)],
        },
      });

    const originalArgs = '{"fact":"private fact"}';
    push({ type: 'response.created', response: { id: 'resp_original' } });
    push({
      type: 'response.output_audio.delta',
      response_id: 'resp_original',
      item_id: 'audio_1',
      delta: 'AQI=',
    });
    call('resp_original', originalArgs);
    call('resp_original', originalArgs); // exact event replay
    finish('resp_original', originalArgs);
    await until(() => events.log.some((entry) => JSON.stringify(entry).includes('stable_id')));

    push({ type: 'response.created', response: { id: 'resp_replay' } });
    call('resp_replay', originalArgs); // same call, but a new response must not replace its turn
    call('resp_replay', '{"fact":"different private fact"}');
    finish('resp_replay', originalArgs);
    await until(
      () => events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'error').length > 0,
    );

    const toolCalls = events.log.filter((entry) => Array.isArray(entry) && entry[0] === 'toolCall');
    expect(toolCalls).toEqual([
      ['toolCall', { id: 'stable_id', name: 'note', args: { fact: 'private fact' } }],
    ]);
    const errors = events.log
      .filter((entry) => Array.isArray(entry) && entry[0] === 'error')
      .map((entry) => JSON.stringify(entry));
    expect(errors.join('\n')).toContain('reused a function-call ID with different content');
    expect(errors.join('\n')).not.toContain('private fact');

    const result = { id: 'stable_id', name: 'note', args: { fact: 'private fact' } };
    session.sendToolResult(result, { noted: true }, 'if_silent');
    session.sendToolResult(result, { noted: true }, 'if_silent');
    await until(
      () => fake.received.filter((event) => event.type === 'conversation.item.create').length === 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.received.filter((event) => event.type === 'response.create')).toHaveLength(0);
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
    push({ type: 'response.created', response: { id: 'resp_wait' } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(creates()).toHaveLength(0);
    push({ type: 'response.done', response: { id: 'resp_wait', status: 'completed', output: [] } });

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
