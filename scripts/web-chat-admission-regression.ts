/** Synthetic browser regressions of the actual retained controls and polling hook. No product routes or paid/provider calls. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const cancellationConversation = '11111111-1111-4111-8111-111111111111';
const output = path.resolve(
  process.env.ASSISTANT_CHAT_REGRESSION_OUTPUT ??
    '.workspace/playbook-review/web-chat-admission-regression',
);
const webRequire = createRequire(path.join(root, 'apps/web/package.json'));
const runtimeRequire = createRequire(webRequire.resolve('tsx'));
const { build } = runtimeRequire('esbuild') as {
  build(options: Record<string, unknown>): Promise<void>;
};
type Resolve = { path: string; kind: string; resolveDir: string };
type Builder = {
  onResolve(opts: { filter: RegExp }, callback: (args: Resolve) => unknown): void;
  onLoad(opts: { filter: RegExp; namespace: string }, callback: (args: Resolve) => unknown): void;
  resolve(name: string, opts: { kind: string; resolveDir: string }): Promise<unknown>;
};
await mkdir(output, { recursive: true });
await build({
  stdin: {
    loader: 'tsx',
    resolveDir: path.join(root, 'apps/web'),
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatClient } from './app/chat/[id]/chat-client';
const app = createRoot(document.getElementById('app'));
window.__requests = []; window.__actionRequests = []; window.__ignoreAbort = false;
window.fetch = (url, options) => new Promise((resolve, reject) => {
 const request = { url: String(url), body: options?.body ? JSON.parse(options.body) : null, settled:false, resolve: (data, status=200) => { request.settled=true; resolve(Response.json(data,{status})); }, resolveResponse: response => { request.settled=true; resolve(response); }, aborted: false, resolveChat: (headers={}, stream={}) => { request.settled=true; resolve(new Response(new ReadableStream({start(controller) {
 request.streamController = controller;
 const messageId = stream.messageId || 'answer-'+window.__requests.length;
 const start = {type:'start',messageId,...(stream.channelMessageId ? {messageMetadata:{channelMessageId:stream.channelMessageId}} : {})};
 for (const item of [start,{type:'text-start',id:'text'},{type:'text-delta',id:'text',delta:stream.initialText || 'Synthetic answer'}]) controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(item)+'\\n\\n'));
}}),{headers:{'Content-Type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1',...headers}})); },
 streamDelta: delta => request.streamController.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'text-delta',id:'text',delta})+'\\n\\n')),
finishChat: () => { for (const item of [{type:'text-end',id:'text'},{type:'finish'}]) request.streamController.enqueue(new TextEncoder().encode('data: '+JSON.stringify(item)+'\\n\\n')); request.streamController.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n')); request.streamController.close(); } };
 window.__requests.push(request);
 options?.signal?.addEventListener('abort', () => { request.aborted = true; if (!window.__ignoreAbort) reject(new DOMException('Aborted', 'AbortError')); });
});
window.__action = (name, args) => new Promise(resolve => window.__actionRequests.push({ name, args, resolve }));
const card = {id:'card-message',role:'assistant',parts:[{type:'text',text:'A card with an action.'},{type:'data-card',data:{kind:'generated-card',spec:{version:1,title:'Example',facts:[{id:'example',label:'Example',value:'A useful fact',source:'test'}],blocks:[{type:'hero',titleFact:'example'}],actions:[{id:'ask',type:'ask_assistant',label:'Ask about example',prompt:'Explain the example'}]}}}],metadata:{createdAt:'2026-10-07T12:00:00.000Z'}};
const cancellationConversation = ${JSON.stringify(cancellationConversation)};
const formCard = {id:'form-card-message',role:'assistant',parts:[{type:'data-card',data:{kind:'generated-card',id:'22222222-2222-4222-8222-222222222222',revisionId:'33333333-3333-4333-8333-333333333333',spec:{version:1,title:'Trip details',facts:[{id:'trip-summary',label:'Trip',value:'Plan',source:'test'}],blocks:[{type:'form',id:'trip',title:'Trip details',serverAction:'submit_owner_chat_turn',submitLabel:'Review request',warningFactIds:[],fields:[{id:'date',type:'date',label:'Departure date',required:true}]}],actions:[]}}}],metadata:{createdAt:'2026-10-07T12:00:00.000Z'}};
window.__mount = (mode, args) => app.render(mode === 'chat' || mode === 'parked' || mode === 'form' || mode === 'race' ? <ChatClient conversationId={cancellationConversation} formSessionScope='synthetic-session-001' title='Test' agentName='Assistant' agentTimezone='UTC' renderedAt='2026-10-07T12:00:00.000Z' initialMessages={mode==='form'?[formCard]:mode==='race'?[]:[card]} models={[]} modelOverride={null} archived={false} isPrimary={true} canArchive={false} initialInput={mode==='chat'?'Preserved draft':''} initialAsyncTurn={args==='parked'?{taskId:'44444444-4444-4444-8444-444444444444',cursor:'start'}:undefined}/> : null);
window.__unmount = () => app.unmount();
`,
  },
  loader: { '.css': 'empty' },
  outfile: path.join(output, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env': '{}',
    'process.browser': 'true',
  },
  plugins: [
    {
      name: 'synthetic-actions',
      setup(builder: Builder) {
        builder.onResolve({ filter: /(?:\/|^)actions$/ }, (args) => ({
          path: args.path.startsWith('@/')
            ? `${path.join(root, 'apps/web', args.path.slice(2))}.ts`
            : `${path.resolve(args.resolveDir, args.path)}.ts`,
          namespace: 'actions',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'actions' }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
            (m) => m[1],
          );
          return {
            contents: names
              .map(
                (name) =>
                  `export function ${name}(...args) { return window.__action(${JSON.stringify(name)}, args); }`,
              )
              .join('\n'),
            loader: 'js',
          };
        });
        builder.onResolve({ filter: /^next\/(link|navigation)$/ }, (args) => ({
          path: args.path,
          namespace: 'next',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'next' }, (args) => ({
          contents:
            args.path === 'next/link'
              ? "import React from 'react'; export default props => React.createElement('a', props);"
              : "export const useRouter = () => ({ refresh() {} }); export const usePathname = () => '/';",
          loader: 'js',
          resolveDir: path.join(root, 'apps/web'),
        }));
        builder.onResolve({ filter: /^@\// }, (args) =>
          builder.resolve(path.join(root, 'apps/web', args.path.slice(2)), {
            kind: args.kind,
            resolveDir: args.resolveDir,
          }),
        );
      },
    },
  ],
});
const server = createServer(async (request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/client.js' ? 'text/javascript' : 'text/html',
  );
  response.end(
    request.url === '/client.js'
      ? await readFile(path.join(output, 'client.js'))
      : '<!doctype html><html><body><main id="app"></main><script type="module" src="/client.js"></script></body></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback address');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const passed: string[] = [];
try {
  let page = await browser.newPage();
  const errors: string[] = [];
  const duplicateKeyWarnings: string[] = [];
  const watchConsole = (target: typeof page) =>
    target.on('console', (message) => {
      if (/same key/i.test(message.text())) duplicateKeyWarnings.push(message.text());
    });
  watchConsole(page);
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('Browser fixture:', error.message);
  });
  const fresh = async (mode: string, args = '') => {
    await page.close();
    page = await browser.newPage();
    watchConsole(page);
    page.on('pageerror', (error) => {
      errors.push(error.message);
      console.error('Browser fixture:', error.message);
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => typeof Reflect.get(window, '__mount') === 'function');
    await page.evaluate(({ mode, args }) => Reflect.get(window, '__mount')(mode, args), {
      mode,
      args,
    });
  };
  await fresh('chat');
  const ask = page.getByRole('button', { name: 'Ask about example', exact: true });
  await ask.waitFor();
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Ask about example'),
    );
    if (!button) throw new Error('Missing generated ask action');
    button.click();
    button.click();
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat'),
  );
  const chatRequests = () =>
    page.evaluate(() =>
      Reflect.get(window, '__requests')
        .filter((r: { url: string }) => r.url === '/api/chat')
        .map((r: { body: unknown }) => r.body),
    );
  assert.equal((await chatRequests()).length, 1);
  const body = (await chatRequests())[0];
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].parts[0].text, 'Explain the example');
  assert.equal(body.clientOperationId, body.messages[0].id);
  await ask.waitFor({ state: 'detached' });
  assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');
  await page.evaluate(() =>
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  assert.equal((await chatRequests()).length, 1);
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find((r: { url: string }) => r.url === '/api/chat')
      .resolveChat(),
  );
  await page.getByText('Synthetic answer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  assert.equal(await ask.count(), 0);
  await page.evaluate(() =>
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  assert.equal((await chatRequests()).length, 1);
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find((r: { url: string }) => r.url === '/api/chat')
      .finishChat(),
  );
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await ask.waitFor();
  await page.locator('textarea').fill('A later turn');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')
        .length === 2,
  );
  assert.equal((await chatRequests())[1].messages[0].parts[0].text, 'A later turn');
  assert.notEqual((await chatRequests())[1].clientOperationId, body.clientOperationId);
  passed.push(
    'Actual ChatClient, transcript, generated ask action and AI SDK transport: rapid ask/composer events admit one request; submitted and streaming block sends; settled turn admits a fresh operation',
  );
  await fresh('chat', 'parked');
  await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Ask about example', exact: true }).count(),
    0,
  );
  await page.evaluate(() =>
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  assert.equal((await chatRequests()).length, 0);
  passed.push(
    'Actual parked ChatClient: generated ask action is absent, composer cannot send, stop control remains available',
  );

  // An ordinary Stop detaches the stream but asks the server to cancel using
  // the exact admitted identity. An unknown result keeps sends blocked and a
  // retry reuses that same identity.
  await fresh('chat');
  await page.locator('textarea').fill('Stop this ordinary request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat'),
  );
  const ordinaryA = await page.evaluate(
    () =>
      Reflect.get(window, '__requests').find((r: { url: string }) => r.url === '/api/chat').body,
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat/cancel')
        .length === 1,
  );
  const firstCancel = await page.evaluate(() =>
    Reflect.get(window, '__requests').find((r: { url: string }) => r.url === '/api/chat/cancel'),
  );
  assert.deepEqual(firstCancel.body, {
    conversationId: cancellationConversation,
    clientOperationId: ordinaryA.clientOperationId,
  });
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find((r: { url: string }) => r.url === '/api/chat/cancel')
      .resolve(
        {
          ok: false,
          outcome: 'unknown',
          code: 'cancellation_unconfirmed',
          conversationId: Reflect.get(window, '__requests').find(
            (r: { url: string }) => r.url === '/api/chat/cancel',
          ).body.conversationId,
          clientOperationId: Reflect.get(window, '__requests').find(
            (r: { url: string }) => r.url === '/api/chat/cancel',
          ).body.clientOperationId,
          taskId: null,
          effectStatus: 'unknown',
        },
        503,
      ),
  );
  await page.getByRole('button', { name: 'Retry stop', exact: true }).waitFor();
  await page.locator('textarea').fill('Do not send before cancellation is known');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Retry stop', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat/cancel')
        .length === 2,
  );
  const cancelBodies = await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .filter((r: { url: string }) => r.url === '/api/chat/cancel')
      .map((r: { body: unknown }) => r.body),
  );
  assert.deepEqual(cancelBodies[1], cancelBodies[0]);
  await page.evaluate(() => {
    const r = Reflect.get(window, '__requests').filter(
      (r: { url: string }) => r.url === '/api/chat/cancel',
    )[1];
    r.resolve({
      ok: true,
      outcome: 'cancelled_before_admission',
      conversationId: r.body.conversationId,
      clientOperationId: r.body.clientOperationId,
      taskId: null,
      transitioned: true,
      effectStatus: 'not_started',
    });
  });
  await page
    .getByText('This message was stopped before it was admitted. No task started.')
    .waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry stop', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')
        .length === 2,
  );
  const ordinaryB = await page.evaluate(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')[1]
        .body,
  );
  assert.notEqual(ordinaryB.clientOperationId, ordinaryA.clientOperationId);
  passed.push(
    'Ordinary Stop uses exact operation identity; unknown cancellation blocks new sends, exact retry confirms tombstone, then a fresh turn receives a new identity',
  );

  // A confirmed task cancellation keeps polling that exact task until its
  // terminal row arrives, then releases the composer instead of polling forever.
  await fresh('chat');
  const taskId = '55555555-5555-4555-8555-555555555555';
  await page.locator('textarea').fill('Stop the admitted task');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat'),
  );
  await page.evaluate(
    ({ taskId }) => {
      const request = Reflect.get(window, '__requests').find(
        (r: { url: string }) => r.url === '/api/chat',
      );
      request.resolveChat({ 'x-async-task': taskId, 'x-message-cursor': 'cursor-start' });
      request.finishChat();
    },
    { taskId },
  );
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some(
      (r: { url: string; settled: boolean }) => r.url.startsWith('/api/chat/status?') && !r.settled,
    ),
  );
  await page.evaluate(() => {
    const request = Reflect.get(window, '__requests').find(
      (r: { url: string; settled: boolean }) => r.url.startsWith('/api/chat/status?') && !r.settled,
    );
    request.resolve({
      taskStatus: 'running',
      messages: [],
      nextCursor: 'cursor-running',
      hasMore: false,
      activity: [],
    });
  });
  await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop this task', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat/cancel'),
  );
  await page.evaluate(
    ({ taskId }) => {
      const request = Reflect.get(window, '__requests').find(
        (r: { url: string }) => r.url === '/api/chat/cancel',
      );
      request.resolve({
        ok: true,
        outcome: 'cancelled',
        conversationId: '11111111-1111-4111-8111-111111111111',
        clientOperationId: request.body.clientOperationId,
        taskId,
        taskStatus: 'cancelled',
        transitioned: true,
        effectStatus: 'unknown',
      });
    },
    { taskId },
  );
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some(
      (r: { url: string; settled: boolean }) => r.url.startsWith('/api/chat/status?') && !r.settled,
    ),
  );
  await page.evaluate(() => {
    const request = Reflect.get(window, '__requests')
      .filter(
        (r: { url: string; settled: boolean }) =>
          r.url.startsWith('/api/chat/status?') && !r.settled,
      )
      .at(-1);
    request.resolve({
      taskStatus: 'cancelled',
      messages: [],
      nextCursor: 'cursor-cancelled',
      hasMore: false,
      activity: [],
    });
  });
  await page.getByText('The task was cancelled.').waitFor();
  const statusCountAfterTerminal = await page.evaluate(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) =>
        r.url.startsWith('/api/chat/status?'),
      ).length,
  );
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(
      () =>
        Reflect.get(window, '__requests').filter((r: { url: string }) =>
          r.url.startsWith('/api/chat/status?'),
        ).length,
    ),
    statusCountAfterTerminal,
  );
  await page.locator('textarea').fill('Continue after terminal cancellation');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
  passed.push(
    'A cancelled task remains observed until its exact terminal status arrives, then polling stops and the composer is released',
  );

  // The send-side cancellation-first 409 is terminal even if the separate
  // cancellation request is still unresolved. Its delayed response cannot
  // settle or erase a later turn in the same conversation.
  await fresh('chat');
  await page.locator('textarea').fill('Cancellation wins before admission');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat'),
  );
  const racedSend = await page.evaluate(() =>
    Reflect.get(window, '__requests').find((r: { url: string }) => r.url === '/api/chat'),
  );
  await page.evaluate(() => {
    Reflect.set(window, '__ignoreAbort', true);
  });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat/cancel'),
  );
  const racedCancel = await page.evaluate(() =>
    Reflect.get(window, '__requests').find((r: { url: string }) => r.url === '/api/chat/cancel'),
  );
  await page.evaluate(
    ({ conversationId, clientOperationId }) => {
      const r = Reflect.get(window, '__requests').find(
        (request: { url: string }) => request.url === '/api/chat',
      );
      r.resolveResponse(
        Response.json(
          {
            ok: false,
            outcome: 'cancelled_before_admission',
            reason: 'cancelled_before_admission',
            code: 'chat_turn_cancelled_before_admission',
            effectStatus: 'not_started',
            conversationId,
            clientOperationId,
            taskId: null,
          },
          { status: 409 },
        ),
      );
    },
    {
      conversationId: cancellationConversation,
      clientOperationId: racedSend.body.clientOperationId,
    },
  );
  await page
    .getByText('This message was stopped before it was admitted. No task started.')
    .waitFor();
  assert.equal(await page.getByText('Synthetic answer', { exact: true }).count(), 0);
  await page.locator('textarea').fill('A later independent message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')
        .length === 2,
  );
  const laterOperation = await page.evaluate(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')[1]
        .body.clientOperationId,
  );
  assert.notEqual(laterOperation, racedSend.body.clientOperationId);
  await page.evaluate(
    ({ conversationId, clientOperationId }) => {
      const r = Reflect.get(window, '__requests').find(
        (request: { url: string }) => request.url === '/api/chat/cancel',
      );
      r.resolve({
        ok: true,
        outcome: 'cancelled_before_admission',
        conversationId,
        clientOperationId,
        taskId: null,
        transitioned: true,
        effectStatus: 'not_started',
      });
    },
    {
      conversationId: cancellationConversation,
      clientOperationId: racedCancel.body.clientOperationId,
    },
  );
  await page.waitForTimeout(50);
  assert.equal(
    await page
      .getByText('This message was stopped before it was admitted. No task started.')
      .count(),
    1,
  );
  assert.equal((await page.locator('textarea').inputValue()).length, 0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat/cancel')
        .length === 2,
  );
  const laterCancel = await page.evaluate(
    () =>
      Reflect.get(window, '__requests').filter(
        (r: { url: string }) => r.url === '/api/chat/cancel',
      )[1],
  );
  assert.deepEqual(laterCancel.body, {
    conversationId: cancellationConversation,
    clientOperationId: laterOperation,
  });
  await page.evaluate(
    ({ conversationId, clientOperationId }) => {
      const r = Reflect.get(window, '__requests').filter(
        (request: { url: string }) => request.url === '/api/chat/cancel',
      )[1];
      r.resolve(
        {
          ok: false,
          outcome: 'unknown',
          code: 'cancellation_unconfirmed',
          conversationId,
          clientOperationId,
          taskId: null,
          effectStatus: 'unknown',
        },
        503,
      );
    },
    { conversationId: cancellationConversation, clientOperationId: laterOperation },
  );
  await page.getByRole('button', { name: 'Retry stop', exact: true }).waitFor();
  passed.push(
    'Typed cancellation-first send 409 settles without an accepted stream; a late old-operation receipt cannot replace the current same-conversation operation identity',
  );

  // A form submission has a separate frozen operation identity. While its
  // admission receipt is unknown, expose a waiting status, not an ordinary
  // Stop affordance; preserve the exact frozen body for explicit replay.
  await fresh('form');
  await page.getByLabel('Departure date').fill('2026-10-09');
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat'),
  );
  const formRequest = await page.evaluate(() =>
    Reflect.get(window, '__requests').find((r: { url: string }) => r.url === '/api/chat'),
  );
  const waitingForFormReceipt = page.getByRole('button', {
    name: 'Waiting for form receipt',
    exact: true,
  });
  await waitingForFormReceipt.waitFor();
  assert.equal(await waitingForFormReceipt.isDisabled(), true);
  assert.equal(
    await page.evaluate(
      () =>
        Reflect.get(window, '__requests').filter(
          (r: { url: string }) => r.url === '/api/chat/cancel',
        ).length,
    ),
    0,
  );
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find((r: { url: string }) => r.url === '/api/chat')
      .resolve({ error: 'Synthetic response loss.' }, 503),
  );
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')
        .length === 2,
  );
  const formReplay = await page.evaluate(
    () =>
      Reflect.get(window, '__requests').filter((r: { url: string }) => r.url === '/api/chat')[1]
        .body,
  );
  assert.equal(formReplay.clientOperationId, formRequest.body.clientOperationId);
  assert.deepEqual(formReplay.cardFormSubmission, formRequest.body.cardFormSubmission);
  assert.equal(
    await page.evaluate(
      () =>
        Reflect.get(window, '__requests').filter(
          (r: { url: string }) => r.url === '/api/chat/cancel',
        ).length,
    ),
    0,
  );
  passed.push(
    'A pre-receipt form operation exposes a disabled waiting status, never calls ordinary cancellation, and preserves its exact frozen identity and body for explicit retry after an unknown response',
  );

  // Polling may discover the persisted assistant row while AI SDK still owns
  // an open stream snapshot. A later stream delta used to append a second row
  // with the SDK id, producing duplicate React keys and two visible replies.
  await fresh('race');
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some(
      (r: { url: string; settled: boolean }) => r.url.startsWith('/api/chat/status?') && !r.settled,
    ),
  );
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find(
        (r: { url: string; settled: boolean }) =>
          r.url.startsWith('/api/chat/status?') && !r.settled,
      )
      .resolve({ taskStatus: null, messages: [], nextCursor: null, hasMore: false }),
  );
  const replyTaskId = '66666666-6666-4666-8666-666666666666';
  const replyChannelId = `chat-reply:${replyTaskId}`;
  const replyBody = 'This local chat is working.';
  await page.locator('textarea').fill('Check the local chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string }) => r.url === '/api/chat'),
  );
  await page.evaluate(
    ({ replyTaskId, replyChannelId }) => {
      const request = Reflect.get(window, '__requests').find(
        (r: { url: string }) => r.url === '/api/chat',
      );
      request.resolveChat(
        { 'x-async-task': replyTaskId, 'x-message-cursor': 'cursor-reply' },
        {
          messageId: 'qgztrP8oAMBg2epx',
          channelMessageId: replyChannelId,
          initialText: 'Raw draft: ',
        },
      );
    },
    { replyTaskId, replyChannelId },
  );
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some(
      (r: { url: string; settled: boolean }) => r.url.startsWith('/api/chat/status?') && !r.settled,
    ),
  );
  await page.evaluate(
    ({ replyTaskId, replyChannelId, replyBody }) => {
      const request = Reflect.get(window, '__requests')
        .filter(
          (r: { url: string; settled: boolean }) =>
            r.url.startsWith('/api/chat/status?') && !r.settled,
        )
        .at(-1);
      if (!request.url.includes(replyTaskId))
        throw new Error('Poll did not observe the active task');
      request.resolve({
        taskStatus: 'running',
        messages: [
          {
            id: 'c7713c86-cb4a-4b6d-a51e-2d27b7b47ae5',
            role: 'assistant',
            parts: [{ type: 'text', text: replyBody }],
            metadata: { channelMessageId: replyChannelId, createdAt: '2026-10-08T12:00:00.000Z' },
          },
        ],
        nextCursor: 'cursor-persisted-reply',
        hasMore: false,
        activity: [],
      });
    },
    { replyTaskId, replyChannelId, replyBody },
  );
  await page.getByText(replyBody, { exact: true }).waitFor();
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find((r: { url: string }) => r.url === '/api/chat')
      .streamDelta('unverified trailing fragment'),
  );
  const assistantRows = page.locator('[data-message-block="true"][data-role="assistant"]');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-message-block="true"][data-role="assistant"]')].some(
      (row) => row.textContent?.includes('This local chat is working.'),
    ),
  );
  assert.equal(await assistantRows.count(), 1);
  const renderedReply = (await assistantRows.first().innerText()).replace(/\s+/g, ' ');
  assert.match(renderedReply, /This local chat is working\./);
  assert.doesNotMatch(renderedReply, /Raw draft|unverified trailing fragment/);
  assert.deepEqual(duplicateKeyWarnings, []);

  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .find((r: { url: string }) => r.url === '/api/chat')
      .finishChat(),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some(
      (r: { url: string; settled: boolean }) => r.url.startsWith('/api/chat/status?') && !r.settled,
    ),
  );
  await page.evaluate(
    ({ replyChannelId, replyBody }) => {
      const request = Reflect.get(window, '__requests')
        .filter(
          (r: { url: string; settled: boolean }) =>
            r.url.startsWith('/api/chat/status?') && !r.settled,
        )
        .at(-1);
      request.resolve({
        taskStatus: 'done',
        messages: [
          {
            id: 'c7713c86-cb4a-4b6d-a51e-2d27b7b47ae5',
            role: 'assistant',
            parts: [{ type: 'text', text: replyBody }],
            metadata: { channelMessageId: replyChannelId, createdAt: '2026-10-08T12:00:00.000Z' },
          },
        ],
        nextCursor: 'cursor-terminal-reply',
        hasMore: false,
        activity: [],
      });
    },
    { replyChannelId, replyBody },
  );
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await page.waitForFunction(() =>
    Reflect.get(window, '__requests').some((r: { url: string; settled: boolean }) => {
      if (!r.url.startsWith('/api/chat/status?') || r.settled) return false;
      return !new URL(r.url, location.href).searchParams.has('taskId');
    }),
  );
  await page.evaluate(() =>
    Reflect.get(window, '__requests')
      .filter(
        (r: { url: string; settled: boolean }) =>
          r.url.startsWith('/api/chat/status?') && !r.settled,
      )
      .at(-1)
      .resolve({
        taskStatus: null,
        messages: [],
        nextCursor: 'cursor-terminal-reply',
        hasMore: false,
      }),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-message-block="true"][data-role="assistant"]')].some(
      (row) => row.textContent?.includes('This local chat is working.'),
    ),
  );
  assert.equal(await assistantRows.count(), 1);
  assert.deepEqual(duplicateKeyWarnings, []);
  passed.push(
    'Mounted AI SDK stream/poll race: a later partial snapshot cannot replace the identified persisted answer; terminal polling leaves one durable row and no duplicate React key',
  );

  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        passed,
        limitations: [
          'Synthetic actions and status transport; no product route reactivation, provider effects, native VoiceOver, or physical-device qualification.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(passed.join('\n'));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
