/** Synthetic browser regressions of the actual retained controls and polling hook. No product routes or paid/provider calls. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const output = path.resolve('.workspace/playbook-review/web-control-regression');
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
import React, { useState, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { EndpointPicker, AddKnowledgeRelation } from './app/profile/knowledge/add-relation';
import { SensitiveValue } from './app/chat/[id]/sensitive-value';
import { LiveCallControls } from './app/calls/[id]/live-controls';
import { useChatPolling } from './app/chat/[id]/use-chat-polling';
import { BudgetCapsForm } from './app/costs/budget-caps-form';
import { AddFact } from './app/profile/add-fact';
import { AddPerson } from './app/people/add-person';
import { OccasionsPanel } from './app/people/occasions-panel';
import { AgentForm } from './app/settings/agent-form';
import { EditKnowledgeEntity } from './app/profile/knowledge/entity-forms';
const app = createRoot(document.getElementById('app'));
window.__requests = []; window.__actionRequests = [];
window.fetch = (url, options) => new Promise((resolve, reject) => {
 const request = { url: String(url), resolve: data => resolve(Response.json(data)), aborted: false };
 window.__requests.push(request);
 options?.signal?.addEventListener('abort', () => { request.aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
});
window.__action = (name, args) => new Promise(resolve => window.__actionRequests.push({ name, args, resolve }));
function DateForm({ canonical }) { const [kind, setKind] = useState('date'); const [preview, setPreview] = useState(''); return <form id="date-form"><EndpointPicker name="object" legend="Object" kind={kind} onKindChange={setKind} prefill={{ id: 'date-original', kind: 'date', label: 'Human display', canonicalKey: 'date:' + canonical }} placeholder="Date" onValueChange={useCallback(x => setPreview(x.label), [])}/><output>{preview}</output></form>; }
function Secret() { const [shown, setShown] = useState(false); return <SensitiveValue value="SECRET-X9" label="Booking reference" revealed={shown} onToggle={() => setShown(x => !x)}/>; }
function Call() { const [checkin, setCheckin] = useState({ id: 'A', question: 'Question A' }); window.__setCheckin = setCheckin; return <LiveCallControls callId="call" checkin={checkin}/>; }
function Poll() {
 const [messages, setMessages] = useState([]); const [turn, setTurn] = useState({ taskId: 'A', cursor: 'start' }); const [note, setNote] = useState(null); const [activity, setActivity] = useState([]); const [trouble, setTrouble] = useState(null);
 const turnRef = useRef(null), asyncTurnRef = useRef(turn), cursorRef = useRef(null), logRef = useRef(messages), serverIdsRef = useRef(new Set()), pokePollRef = useRef(null), statusRef = useRef('ready');
 asyncTurnRef.current = turn; logRef.current = messages;
 window.__setTurn = setTurn; window.__poke = () => pokePollRef.current?.();
 useChatPolling({ conversationId: 'conversation', setMessages, statusRef, asyncTurnRef, cursorRef, logRef, serverIdsRef, turnRef, pokePollRef, setAsyncNote: setNote, setAsyncTurn: setTurn, setActivity, setLiveRecall: () => {}, setPollTrouble: setTrouble });
 return <pre id="state">{JSON.stringify({messages, turn, note, activity, trouble})}</pre>;
}
window.__mount = (mode, args) => app.render(mode === 'date' ? <DateForm key={args} canonical={args}/> : mode === 'secret' ? <Secret/> : mode === 'call' ? <Call/> : mode === 'relation' ? <AddKnowledgeRelation selected={null} vocabulary={[]}/> : mode === 'caps' ? <BudgetCapsForm initial={{task_default:'0.03',daily:'1.23',monthly:'5.67'}}/> : mode === 'fact' ? <AddFact subjectContactId="owner" subjectLabel="Owner"/> : mode === 'person' ? <AddPerson/> : mode === 'occasion' ? <OccasionsPanel contactId="contact" personName="Anna" occasions={[]}/> : mode === 'settings' ? <AgentForm initial={{timezone:'UTC',locale:'en',signature:''}}/> : mode === 'entity-edit' ? <EditKnowledgeEntity entity={{id:'entity-1',label:'Old name',kind:'organization',canonicalKey:'organization:old-name'}} duplicates={[]}/> : <Poll/>);
window.__unmount = () => app.unmount();
`,
  },
  loader: { '.css': 'empty' },
  outfile: path.join(output, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
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
  page.on('pageerror', (error) => errors.push(error.message));
  const fresh = async (mode: string, args = '') => {
    await page.close();
    page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => typeof Reflect.get(window, '__mount') === 'function');
    await page.evaluate(({ mode, args }) => Reflect.get(window, '__mount')(mode, args), {
      mode,
      args,
    });
  };
  for (const canonical of ['2026-10-07', '2026-10', '--10-07']) {
    await fresh('date', canonical);
    await page.waitForFunction(() => document.querySelector('output')?.textContent !== '');
    const initial = await page
      .locator('form')
      .evaluate((form) => Object.fromEntries(new FormData(form as HTMLFormElement)));
    assert.equal(initial.objectId, 'date-original');
    assert.equal(initial.objectLabel, canonical);
    if (canonical.startsWith('--')) await page.getByLabel('Day of month').fill('8');
    else
      await page
        .locator(`input[type=${canonical.length === 7 ? 'month' : 'date'}]`)
        .fill(canonical.length === 7 ? '2026-11' : '2026-10-08');
    const changed = await page
      .locator('form')
      .evaluate((form) => Object.fromEntries(new FormData(form as HTMLFormElement)));
    assert.equal(changed.objectId, '');
    assert.notEqual(changed.objectLabel, canonical);
    assert.equal(await page.locator('output').textContent(), changed.objectLabel);
  }
  passed.push(
    'Actual browser FormData: day/month/recurring canonical prefill, changed identity and preview',
  );
  await fresh('secret');
  assert(!(await page.locator('main').ariaSnapshot()).includes('SECRET-X9'));
  await page.getByRole('button', { name: 'Show booking reference' }).click();
  assert((await page.locator('main').ariaSnapshot()).includes('SECRET-X9'));
  await page.getByRole('button', { name: 'Hide booking reference' }).click();
  assert(!(await page.locator('main').ariaSnapshot()).includes('SECRET-X9'));
  passed.push(
    'Browser accessibility tree: secret absent when hidden, accessible after reveal, absent after hide',
  );
  await fresh('relation');
  await page.getByRole('button', { name: 'Add connection', exact: true }).click();
  await page.getByLabel('First item', { exact: true }).fill('Anna');
  await page.getByLabel('Connected item', { exact: true }).fill('Example');
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__actionRequests').some(
      (r: { name: string }) => r.name === 'addKnowledgeRelation',
    ),
  );
  assert(await page.getByRole('button', { name: 'Saving…', exact: true }).first().isDisabled());
  await page.keyboard.press('Escape');
  assert(await page.getByRole('dialog').isVisible());
  await page.evaluate(() =>
    Reflect.get(window, '__actionRequests')
      .find((r: { name: string }) => r.name === 'addKnowledgeRelation')
      .resolve({ error: 'Synthetic validation failure', success: null }),
  );
  await page.getByRole('alert').filter({ hasText: 'Synthetic validation failure' }).waitFor();
  assert.equal(await page.getByLabel('First item', { exact: true }).inputValue(), 'Anna');
  passed.push(
    'Connection save: pending Escape cannot hide native dialog; validation failure preserves controlled draft',
  );
  await fresh('entity-edit');
  await page.getByRole('button', { name: 'Edit item', exact: true }).click();
  const rename = page.getByLabel('Display name');
  await rename.fill('Updated name');
  await page.getByRole('button', { name: 'Rename display', exact: true }).click();
  await page.waitForFunction(() =>
    Reflect.get(window, '__actionRequests').some(
      (request: { name: string }) => request.name === 'renameKnowledgeEntity',
    ),
  );
  const editor = page.getByRole('dialog', { name: 'Edit Old name' });
  assert(await editor.isVisible());
  assert(await editor.getByRole('button', { name: 'Done', exact: true }).isDisabled());
  assert(await rename.isDisabled());
  await page.keyboard.press('Escape');
  assert(await editor.isVisible(), 'Escape cannot dismiss an in-flight entity mutation');
  await page.evaluate(() =>
    Reflect.get(window, '__actionRequests')
      .find((request: { name: string }) => request.name === 'renameKnowledgeEntity')
      .resolve({ error: 'Synthetic rename failure', success: null }),
  );
  await page.getByRole('alert').filter({ hasText: 'Synthetic rename failure' }).waitFor();
  assert(await editor.isVisible(), 'The failed action remains visible with its result');
  assert.equal(await page.getByLabel('Display name').inputValue(), 'Updated name');
  await page.getByRole('button', { name: 'Rename display', exact: true }).click();
  await page.waitForFunction(() => Reflect.get(window, '__actionRequests').length === 2);
  assert(await editor.getByRole('button', { name: 'Done', exact: true }).isDisabled());
  await page.evaluate(() =>
    Reflect.get(window, '__actionRequests')[1].resolve({
      error: null,
      success: 'Display name updated.',
    }),
  );
  await page.getByRole('status').filter({ hasText: 'Display name updated.' }).waitFor();
  assert(await editor.isVisible(), 'The successful action remains visible with its result');
  assert.equal(await page.getByLabel('Display name').inputValue(), 'Updated name');
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  passed.push(
    'Entity editor: deferred failure and success block Escape/Done while pending, preserve the submitted value, and expose the authoritative result before closing',
  );
  await fresh('caps');
  const caps = page.locator('input');
  await caps.nth(1).fill('2.75');
  await caps.nth(2).fill('4prefix');
  await page.getByRole('button', { name: 'Update caps', exact: true }).click();
  assert.equal(await page.evaluate(() => Reflect.get(window, '__actionRequests').length), 0);
  await page.getByRole('alert').waitFor();
  await caps.nth(2).fill('8.35');
  await page.getByRole('button', { name: 'Update caps', exact: true }).click();
  await page.waitForFunction(() => Reflect.get(window, '__actionRequests').length === 1);
  assert.deepEqual(
    await page.evaluate(() =>
      Object.fromEntries(Reflect.get(window, '__actionRequests')[0].args[0]),
    ),
    { task_default: '0.03', daily: '2.75', monthly: '8.35' },
  );
  await page.evaluate(() => Reflect.get(window, '__actionRequests')[0].resolve());
  await page.getByRole('status').waitFor();
  passed.push(
    'Caps: existing fractional values accepted, numeric prefix blocks all mutations, all changes submitted together with exact-cent receipt',
  );
  for (const mode of ['fact', 'person', 'occasion']) {
    await fresh(mode);
    await page
      .getByRole('button', {
        name:
          mode === 'fact'
            ? 'Add a fact about Owner'
            : mode === 'person'
              ? 'Add person'
              : 'Add occasion',
        exact: true,
      })
      .click();
    const draft =
      mode === 'fact'
        ? page.locator('textarea')
        : mode === 'person'
          ? page.getByLabel('Name', { exact: true })
          : page.getByLabel('Month', { exact: true });
    await draft.fill(mode === 'fact' ? 'My detailed draft' : mode === 'person' ? 'Anna' : '2');
    if (mode === 'occasion') await page.getByLabel('Day', { exact: true }).fill('31');
    await page
      .getByRole('button', {
        name: mode === 'fact' ? 'Save fact' : mode === 'person' ? 'Add person' : 'Save occasion',
        exact: true,
      })
      .click();
    await page.waitForFunction(() => Reflect.get(window, '__actionRequests').length === 1);
    assert(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled());
    await page.evaluate(() =>
      Reflect.get(window, '__actionRequests')[0].resolve({
        error: 'Synthetic invalid or duplicate input',
      }),
    );
    await page.getByRole('alert').waitFor();
    assert.equal(
      await draft.inputValue(),
      mode === 'fact' ? 'My detailed draft' : mode === 'person' ? 'Anna' : '2',
    );
  }
  passed.push(
    'Fact/person/invalid occasion: pending dismissal disabled and failed submissions preserve drafts',
  );
  await fresh('call');
  await page.getByRole('textbox').fill('Yes A');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  assert(await page.getByRole('button', { name: 'Hang up', exact: true }).isEnabled());
  await page.evaluate(() =>
    Reflect.get(window, '__setCheckin')({ id: 'B', question: 'Question B' }),
  );
  await page.getByText('“Question B”', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox').inputValue(), '');
  await page.evaluate(() => Reflect.get(window, '__actionRequests')[0].resolve({}));
  assert(await page.getByRole('textbox').isVisible());
  assert.equal(await page.getByRole('textbox').inputValue(), '');
  passed.push(
    'Deferred answer A cannot hide check-in B; B gets a fresh draft; hang-up enabled during answer save',
  );
  for (const status of [
    'done',
    'failed',
    'cancelled',
    'waiting_approval',
    'waiting_budget',
    'needs_attention',
  ]) {
    await fresh('poll');
    await page.clock.install();
    await page.waitForFunction(() => Reflect.get(window, '__requests').length === 1);
    await page.evaluate(
      (status) =>
        Reflect.get(window, '__requests')[0].resolve({
          taskStatus: status,
          messages: [{ id: 'reply-A', role: 'assistant', parts: [{ type: 'approval' }] }],
          nextCursor: 'cursor-1',
          hasMore: false,
        }),
      status,
    );
    await page.waitForFunction(
      () => JSON.parse(document.getElementById('state')?.textContent ?? '{}').turn === null,
    );
    await page.clock.runFor(12_100);
    await page.waitForFunction(() => Reflect.get(window, '__requests').length === 2);
    await page.evaluate(() =>
      Reflect.get(window, '__requests')[1].resolve({
        taskStatus: null,
        messages: [
          { id: 'unrelated', role: 'assistant', parts: [{ type: 'text', text: 'Later arrival' }] },
        ],
        nextCursor: 'cursor-2',
        hasMore: false,
      }),
    );
    await page.getByText('Later arrival', { exact: false }).waitFor();
  }
  passed.push(
    'Actual polling hook: done/failed/cancelled/all parked states continue lifetime polling and deliver unrelated durable rows',
  );
  await fresh('poll');
  await page.waitForFunction(() => Reflect.get(window, '__requests').length === 1);
  await page.evaluate(() => {
    Reflect.get(window, '__setTurn')({ taskId: 'B', cursor: 'B' });
    Reflect.get(window, '__poke')();
  });
  await page.waitForFunction(
    () => JSON.parse(document.getElementById('state')?.textContent ?? '{}').turn?.taskId === 'B',
  );
  await page.evaluate(() =>
    Reflect.get(window, '__requests')[0].resolve({
      taskStatus: 'failed',
      activity: [{ toolName: 'old', status: 'done', step: 1 }],
      messages: [],
      nextCursor: 'A',
      hasMore: false,
    }),
  );
  await page.waitForFunction(() => Reflect.get(window, '__requests').length === 2);
  assert.equal(
    await page.locator('#state').evaluate((el) => JSON.parse(el.textContent ?? '{}').turn.taskId),
    'B',
  );
  assert.deepEqual(
    await page.locator('#state').evaluate((el) => JSON.parse(el.textContent ?? '{}').activity),
    [],
  );
  await page.evaluate(() => Reflect.get(window, '__unmount')());
  await page.waitForFunction(() => Reflect.get(window, '__requests')[1].aborted === true);
  passed.push(
    'Delayed A response preserves B state/activity; wake requests serialized; unmount aborts observation',
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
