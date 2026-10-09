/** Mounted synthetic ChatClient card-form lifecycle regression. Loopback only; no Next server, auth, database, or providers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

interface BrowserRequestRow {
  url: string;
  method: string;
  body: {
    cardFormSubmission?: { operationId?: unknown };
    clientOperationId?: unknown;
    messages?: Array<{ parts?: Array<{ text?: unknown }> }>;
  } | null;
  headers?: Record<string, string>;
  reject?: () => void;
  settled?: boolean;
}
declare global {
  interface Window {
    __cardFormRequests: BrowserRequestRow[];
    __cardFormSetResponseMode(mode: string): void;
    __cardFormResponseMode: string;
    __cardFormSetStatusMode(mode: string): void;
    __cardFormStatusMode: string;
    __cardFormSetTaskStatus(taskId: string, status: string | null): void;
    __cardFormTaskStatuses: Record<string, string>;
    __cardFormTaskStatusHistory: Array<{
      taskId: string;
      previous: string | null;
      next: string | null;
      accepted: boolean;
    }>;
    __cardFormSetCardRevision(revision: string): void;
    __cardFormRevision: string | null;
    __cardFormRemountScope(scope: string): void;
    __cardFormSignOutMode: string;
    __cardFormSetStorageFailure(active: boolean): void;
    __cardFormRecordRequest(row: BrowserRequestRow): void;
    __cardFormMount(scope?: string): void;
    __cardFormUnmount(): void;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function postAt(rows: BrowserRequestRow[], index: number): BrowserRequestRow {
  const row = rows[index];
  if (!row) throw new Error(`Expected POST request at index ${index}, found ${rows.length}`);
  assert.equal(row.method, 'POST', `Request at index ${index} must be POST`);
  return row;
}
function bodyOf(row: BrowserRequestRow): Exclude<BrowserRequestRow['body'], null> {
  if (!row.body || typeof row.body !== 'object')
    throw new Error('POST request is missing a JSON body');
  return row.body;
}
function operationId(row: BrowserRequestRow): string {
  const value = bodyOf(row).cardFormSubmission?.operationId;
  if (typeof value !== 'string') throw new Error('POST request is missing a form operation ID');
  assert.match(value, uuidPattern, 'Form operation ID must be a UUID');
  return value;
}
function syntheticTaskId(namespace: 'a' | 'b' | 'c', operationId: string): string {
  const compact = operationId.replaceAll('-', '');
  assert.match(compact, /^[0-9a-f]{32}$/i);
  const taskId = `${namespace}${compact.slice(1, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  assert.match(
    taskId,
    uuidPattern,
    'Synthetic task IDs must satisfy the same UUID guard as the application',
  );
  return taskId;
}
function formTaskId(id: string): string {
  return syntheticTaskId('a', id);
}
function activeTaskId(id: string): string {
  return syntheticTaskId('b', id);
}
function ownerReplyTaskId(id: string): string {
  return syntheticTaskId('c', id);
}
function ownerText(row: BrowserRequestRow): string {
  const value = bodyOf(row).messages?.[0]?.parts?.[0]?.text;
  if (typeof value !== 'string') throw new Error('POST request is missing owner message text');
  return value;
}
const root = process.cwd();
const output = path.resolve('.workspace/playbook-review/web-card-form-lifecycle-regression');
const webRoot = path.join(root, 'apps/web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
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
const fillForm = async (page: Page, guests: string) => {
  await page.getByLabel('Date').fill('2026-10-12');
  await page.getByLabel('Number of guests').fill(guests);
  await page.getByRole('radio', { name: 'No' }).check();
};
const sourcePaths = [
  'apps/web/app/chat/[id]/chat-client.tsx',
  'apps/web/app/chat/[id]/chat-log.tsx',
  'apps/web/app/chat/[id]/response-card.tsx',
  'apps/web/app/chat/[id]/card-form-block.tsx',
  'apps/web/app/chat/[id]/card-form-operations.ts',
  'apps/web/app/chat/[id]/use-chat-polling.ts',
  'apps/web/app/chat/[id]/use-card-form-task-observer.ts',
  'apps/web/app/browser-signout.ts',
  'apps/web/app/owner-account-menu.tsx',
  'packages/persistence/src/card-form.ts',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(path.join(root, file)))
        .digest('hex'),
    ]),
  ),
);
await build({
  stdin: {
    loader: 'tsx',
    resolveDir: webRoot,
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatClient } from './app/chat/[id]/chat-client';
import { OwnerAccountMenu } from './app/owner-account-menu';
const app = createRoot(document.getElementById('app'));
const syntheticTaskId=(namespace,id)=>{const compact=String(id).replaceAll('-','');if(!/^[0-9a-f]{32}$/i.test(compact))throw new Error('Synthetic task identity requires an operation UUID');return namespace+compact.slice(1,8)+'-'+compact.slice(8,12)+'-'+compact.slice(12,16)+'-'+compact.slice(16,20)+'-'+compact.slice(20)};
const ids = {
 conversation: '11111111-1111-4111-8111-111111111111',
 card: '22222222-2222-4222-8222-222222222222',
 revision: '33333333-3333-4333-8333-333333333333',
};
window.__cardFormRequests = JSON.parse(sessionStorage.getItem('__qa_form_requests') || '[]');
window.__cardFormTaskStatuses = JSON.parse(sessionStorage.getItem('__qa_form_task_statuses') || '{}');
window.__cardFormTaskStatusHistory = JSON.parse(sessionStorage.getItem('__qa_form_task_status_history') || '[]');
window.__cardFormStatusMode = 'ok';
window.__cardFormResponseMode = sessionStorage.getItem('__qa_form_response_mode') || 'reject';
window.__cardFormSignOutMode = 'success';
window.__cardFormFailWrites = false;
const originalSetItem=Storage.prototype.setItem;
Storage.prototype.setItem=function(key,value){if(window.__cardFormFailWrites&&key.includes('assistant:card-form-session:'))throw new Error('Synthetic storage full');return originalSetItem.call(this,key,value)};
window.__cardFormSetStorageFailure=(active)=>{window.__cardFormFailWrites=active};
window.__cardFormSetStatusMode=(mode)=>{window.__cardFormStatusMode=mode};
window.__cardFormRevision = sessionStorage.getItem('__qa_form_revision');
window.__cardFormSetResponseMode = (mode) => { window.__cardFormResponseMode = mode; sessionStorage.setItem('__qa_form_response_mode', mode); };
window.__cardFormSetTaskStatus = (taskId, status) => {
 const terminal = new Set(['done','failed','cancelled']);
 const current = window.__cardFormTaskStatuses[taskId];
 if (current && terminal.has(current) && current !== status) {
  window.__cardFormTaskStatusHistory.push({taskId,previous:current,next:status,accepted:false});
  sessionStorage.setItem('__qa_form_task_status_history', JSON.stringify(window.__cardFormTaskStatusHistory));
  throw new Error('Synthetic task status cannot regress after terminal');
 }
 if (status === null) delete window.__cardFormTaskStatuses[taskId];
 else window.__cardFormTaskStatuses[taskId] = status;
 window.__cardFormTaskStatusHistory.push({taskId,previous:current ?? null,next:status,accepted:true});
 sessionStorage.setItem('__qa_form_task_statuses', JSON.stringify(window.__cardFormTaskStatuses));
 sessionStorage.setItem('__qa_form_task_status_history', JSON.stringify(window.__cardFormTaskStatusHistory));
};
window.__cardFormSetCardRevision = (revision) => { window.__cardFormRevision=revision;sessionStorage.setItem('__qa_form_revision',revision); };
window.__cardFormRecordRequest = (row) => { window.__cardFormRequests.push(row); sessionStorage.setItem('__qa_form_requests', JSON.stringify(window.__cardFormRequests)); };
window.__cardFormMount = (scope = 'synthetic-session-scope-001') => {
 const revision = window.__cardFormRevision || ids.revision;
 const card = { id:'card-row', role:'assistant', parts:[
  { type:'text', text:'Please check the source note before using these details.' },
  { type:'data-card', data:{ kind:'generated-card', id:ids.card, revisionId:revision, spec:{
   version:1, title:'Dinner plan', icon:'calendar',
   facts:[{id:'warning',label:'Timing',value:'Reservation begins at 7 PM',source:'synthetic'}],
   blocks:[{type:'form',id:'dinner',title:'Dinner details',serverAction:'submit_owner_chat_turn',submitLabel:'Send request',warningFactIds:['warning'],fields:[
    {id:'date',type:'date',label:'Date',required:true},
    {id:'guests',type:'text',label:'Number of guests',required:true},
    {id:'confirmed',type:'boolean',label:'Confirmed',required:true},
   ]}], actions:[], refreshable:false
  } } },
 ], metadata:{createdAt:'2026-10-08T12:00:00.000Z'} };
 app.render(<><OwnerAccountMenu name='Synthetic owner'/><ChatClient conversationId={ids.conversation} formSessionScope={scope} title='Synthetic chat' agentName='Assistant' agentTimezone='UTC' renderedAt='2026-10-08T12:00:00.000Z' initialMessages={[card]} models={[]} modelOverride={null} archived={false} isPrimary={true} canArchive={false} /></>);
};
window.__cardFormMount();
window.fetch = async (input, init) => {
 const url = new URL(String(input), location.origin);
 if (url.pathname === '/api/owner/browser-signout' && init?.method === 'POST') {
  window.__cardFormRecordRequest({url:url.pathname,method:'SIGNOUT',body:null});
  if(window.__cardFormSignOutMode==='failure')return Response.json({error:'Synthetic sign-out failure'},{status:503});
  const response=new Response(null,{status:200});
  Object.defineProperties(response,{redirected:{value:true},url:{value:location.origin+'/signin'}});
  return response;
 }
 if (url.pathname === '/api/chat/status') {
  const row = { url:url.pathname + url.search, method:'GET', body:null };
  window.__cardFormRecordRequest(row);
  if(url.searchParams.get('wait')==='0'&&window.__cardFormStatusMode==='401')return new Response(null,{status:401});
  if(url.searchParams.get('wait')==='0'&&window.__cardFormStatusMode==='403')return new Response(null,{status:403});
  const taskId=url.searchParams.get('taskId') || '';
  const isReplyTask=taskId.startsWith('c');
  const messages=isReplyTask?[{id:'synthetic-owner-reply-result-'+taskId,role:'assistant',parts:[{type:'text',text:'I will check that before continuing.'}]}]:[];
  return Response.json({taskStatus:window.__cardFormTaskStatuses[taskId] ?? null,messages,nextCursor:null,hasMore:false,activity:[]});
 }
 if (url.pathname !== '/api/chat' || init?.method !== 'POST') throw new Error('Unexpected synthetic request');
 const row = {url:url.pathname,method:'POST',body:JSON.parse(String(init.body)),headers:Object.fromEntries(new Headers(init.headers).entries())};
 window.__cardFormRecordRequest(row);
 const clientOperationId=String(row.body.clientOperationId || 'missing-operation');
 const replyTaskId=syntheticTaskId('c', clientOperationId);
 if (window.__cardFormResponseMode === 'hold') return new Promise((resolve,reject)=>{row.reject=()=>{row.settled=true;reject(new TypeError('Synthetic response lost.'))};row.resolve=resolve});
 if (window.__cardFormResponseMode === 'reject') throw new TypeError('Synthetic response lost.');
 if (window.__cardFormResponseMode === 'active' || window.__cardFormResponseMode === 'activeStored') {
  if(window.__cardFormResponseMode==='active')window.__cardFormSetStorageFailure(true);
  const blockedTaskId=syntheticTaskId('b', clientOperationId);
  window.__cardFormSetTaskStatus(blockedTaskId, 'waiting_approval');
  return Response.json({ok:false,status:409,reason:'active_form',activeTaskId:blockedTaskId,taskStatus:'waiting_approval',error:'Another form request is active.'},{status:409});
 }
 if (window.__cardFormResponseMode === 'stale') return Response.json({ok:false,status:409,reason:'stale_revision',error:'The card changed.'},{status:409});
 if (window.__cardFormResponseMode === 'generic409') return Response.json({error:'Conflict'},{status:409});
 if (window.__cardFormResponseMode === 'invalid422') return Response.json({error:'Synthetic validation rejection.'},{status:422});
 const taskId=window.__cardFormResponseMode === 'reply' ? replyTaskId : syntheticTaskId('a', String(row.body.cardFormSubmission?.operationId || clientOperationId));
 window.__cardFormSetTaskStatus(taskId, 'waiting_approval');
 const stream = new ReadableStream({start(controller) {
  for (const event of [{type:'start',messageId:'synthetic-accepted-'+clientOperationId},{type:'finish',finishReason:'stop'}])
   controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\\n\\n'));
  controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));
  controller.close();
 }});
 return new Response(stream,{headers:{'Content-Type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1','x-async-task':taskId,'x-message-cursor':'synthetic-cursor'}});
};
window.__cardFormRemountScope = (scope) => window.__cardFormMount(scope);
window.__cardFormUnmount = () => app.unmount();
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
      name: 'isolated-chat-actions-and-next',
      setup(builder: Builder) {
        builder.onResolve({ filter: /(?:\/|^)actions$/ }, (args) => ({
          path: args.path.startsWith('@/')
            ? `${path.join(webRoot, args.path.slice(2))}.ts`
            : `${path.resolve(args.resolveDir, args.path)}.ts`,
          namespace: 'actions',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'actions' }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(
            (match) => match[1],
          );
          return {
            contents: names
              .map(
                (name) =>
                  `export function ${name}(...args){return window.__action(${JSON.stringify(name)},args)}`,
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
              ? "import React from 'react'; export default props=>React.createElement('a',props);"
              : "export const useRouter=()=>({refresh(){},push(){},replace(){}}); export const usePathname=()=>'/chat/synthetic'; export const useSearchParams=()=>new URLSearchParams();",
          loader: 'js',
          resolveDir: webRoot,
        }));
        builder.onResolve({ filter: /^@\// }, (args) =>
          builder.resolve(path.join(webRoot, args.path.slice(2)), {
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
    request.url === '/client.js' ? 'text/javascript' : 'text/html; charset=utf-8',
  );
  response.end(
    request.url === '/client.js'
      ? await readFile(path.join(output, 'client.js'))
      : '<!doctype html><html><body><main id="app"></main><script type="module" src="/client.js"></script></body></html>',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Loopback server did not bind');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures: string[] = [];
const consoleErrors: Array<{ url: string; text: string }> = [];
const watchPage = (candidate: Page) => {
  candidate.on('pageerror', (error) => failures.push(error.message));
  candidate.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push({ url: candidate.url(), text: message.text() });
  });
};
const results: string[] = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  watchPage(page);
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('button', { name: 'Review in message', exact: true }).waitFor();
  const posts = () =>
    page.evaluate(() => window.__cardFormRequests.filter((row) => row.method === 'POST'));
  const draftKeys = () =>
    page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith('assistant:card-form-session:v1:'),
      ),
    );
  assert.equal((await posts()).length, 0, 'Rendering a form must not create a chat request');
  assert.equal((await draftKeys()).length, 0, 'Rendering a form must not write a local draft');
  await fillForm(page, '3');
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  assert.equal((await posts()).length, 0, 'Reviewing must only prefill the ordinary composer');
  const prefilledText = 'Dinner details:\nDate: 2026-10-12\nNumber of guests: 3\nConfirmed: No';
  assert.equal(
    await page.locator('textarea').inputValue(),
    prefilledText,
    'Review prefills the ordinary composer with the formatted form answers',
  );
  const editedText =
    'Please book for three.\nKeep the date unchanged.\nKeep the wording as I edited it.';
  await page.locator('textarea').fill(editedText);
  assert.equal(
    await page.evaluate(() => {
      const entry = Object.entries(sessionStorage).find(([key]) =>
        key.startsWith('assistant:card-form-session:v1:'),
      );
      return entry ? JSON.parse(entry[1]).composerText : null;
    }),
    editedText,
    'Editing a reviewed message persists the exact composer text immediately',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(
    await page.locator('textarea').inputValue(),
    editedText,
    'Edited reviewed composer text survives same-tab reload',
  );
  assert.equal(
    await page.getByLabel('Number of guests').inputValue(),
    '3',
    'Field answers survive same-tab reload',
  );
  assert.equal(
    await page.getByRole('radio', { name: 'No' }).isChecked(),
    true,
    'An explicit false value survives reload',
  );
  results.push(
    'Mounted render/review path performs no send or storage write; reviewed message and values restore after reload.',
  );

  // A lost response must replay the same frozen operation, not mint a second ID.
  await page.evaluate(() => window.__cardFormSetResponseMode('hold'));
  await page.evaluate(() => {
    const send = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
    const form = document.querySelector('textarea[aria-label="Message"]')?.closest('form');
    if (!send || !form) throw new Error('Missing owner composer Send form');
    send.click();
    form.requestSubmit();
    form.requestSubmit();
  });
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 1,
  );
  assert.equal(
    (await posts()).length,
    1,
    'Rapid repeated submit events while the request is held admit one request',
  );
  const first = postAt(await posts(), 0);
  const firstOperationId = operationId(first);
  assert.notEqual(
    formTaskId(firstOperationId),
    activeTaskId(firstOperationId),
    'Form and blocker roles have distinct UUID task IDs',
  );
  assert.notEqual(
    formTaskId(firstOperationId),
    ownerReplyTaskId(firstOperationId),
    'Form and reply roles have distinct UUID task IDs',
  );
  assert.notEqual(
    activeTaskId(firstOperationId),
    ownerReplyTaskId(firstOperationId),
    'Blocker and reply roles have distinct UUID task IDs',
  );
  await page.evaluate(() => {
    const row = window.__cardFormRequests.find((item) => item.method === 'POST');
    if (!row?.reject) throw new Error('Held POST request has no rejection control');
    row.reject();
  });
  await page.waitForFunction(
    () => window.__cardFormRequests.find((row) => row.method === 'POST')?.settled === true,
  );
  await page.reload();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await page.evaluate(() => window.__cardFormSetResponseMode('accept'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 2,
  );
  const replay = postAt(await posts(), 1);
  assert.equal(operationId(replay), firstOperationId);
  assert.equal(ownerText(replay), editedText);
  assert.equal(replay.headers?.['x-chat-card-form'], 'card-form-v1');
  await page.waitForFunction(() =>
    window.__cardFormRequests.some(
      (row) => row.method === 'GET' && row.url.startsWith('/api/chat/status'),
    ),
  );
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'waiting_approval'),
    formTaskId(firstOperationId),
  );
  await page.waitForFunction(
    (expectedTaskId) =>
      window.__cardFormRequests.some(
        (row) => row.method === 'GET' && row.url.includes(`taskId=${expectedTaskId}`),
      ),
    formTaskId(firstOperationId),
  );
  assert.equal(
    (await posts()).length,
    2,
    'A parked accepted task is observed without auto-resubmitting',
  );
  assert.equal(
    await page.locator('textarea').isDisabled(),
    false,
    'An accepted parked form task must not disable ordinary owner replies',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
  assert.equal(
    await page.locator('textarea').isEnabled(),
    true,
    'A restored parked form task keeps its observer cancellation control and normal owner composer available',
  );
  assert.equal(
    await page.locator('textarea').inputValue(),
    '',
    'Reload must not present the already accepted form message as a duplicate ordinary reply',
  );
  await page.locator('textarea').fill('One question before proceeding.');
  await page.reload();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(
    await page.locator('textarea').inputValue(),
    'One question before proceeding.',
    'An ordinary reply draft survives reload while its accepted form task remains parked',
  );
  await page.evaluate(() => window.__cardFormSetResponseMode('reply'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 3,
  );
  const ownerReply = postAt(await posts(), 2);
  assert.equal(ownerText(ownerReply), 'One question before proceeding.');
  assert.equal(
    bodyOf(ownerReply).cardFormSubmission,
    undefined,
    'A normal owner reply cannot replay or mutate the parked form submission',
  );
  const replyOperationId = bodyOf(ownerReply).clientOperationId;
  assert.equal(
    typeof replyOperationId,
    'string',
    'The ordinary reply has its own stable operation identity',
  );
  const replyTaskId = ownerReplyTaskId(replyOperationId as string);
  assert.equal(
    await page.evaluate((taskId) => window.__cardFormTaskStatuses[taskId], replyTaskId),
    'waiting_approval',
  );
  await page.waitForFunction(
    (expectedTaskId) =>
      window.__cardFormRequests.some(
        (row) => row.method === 'GET' && row.url.includes(`taskId=${expectedTaskId}`),
      ),
    replyTaskId,
  );
  await page.evaluate((taskId) => window.__cardFormSetTaskStatus(taskId, 'done'), replyTaskId);
  await page.waitForFunction(
    (taskId) => window.__cardFormTaskStatuses[taskId] === 'done',
    replyTaskId,
  );
  const regressionRejected = await page.evaluate((taskId) => {
    try {
      window.__cardFormSetTaskStatus(taskId, 'waiting_approval');
      return false;
    } catch {
      return window.__cardFormTaskStatuses[taskId] === 'done';
    }
  }, replyTaskId);
  assert.equal(
    regressionRejected,
    true,
    'A terminal task cannot return to waiting after a later operation starts',
  );
  assert.equal(
    await page.evaluate(
      (taskId) => window.__cardFormTaskStatuses[taskId],
      formTaskId(firstOperationId),
    ),
    'waiting_approval',
    'Completing the ordinary reply cannot change the separately parked form task',
  );
  assert.ok(
    await page.evaluate(
      (taskId) =>
        window.__cardFormRequests.some(
          (row) => row.method === 'GET' && row.url.includes(`taskId=${taskId}`),
        ),
      formTaskId(firstOperationId),
    ),
    'The exact form task remains independently observed while the owner reply is sent',
  );
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    formTaskId(firstOperationId),
  );
  await page.waitForFunction(() =>
    Object.keys(sessionStorage).every((key) => !key.startsWith('assistant:card-form-session:v1:')),
  );
  assert.equal((await posts()).length, 3, 'Only the exact form task terminal releases its receipt');
  results.push(
    'Lost-response retry keeps its operation ID; a parked task remains independently observed while a normal owner reply is sent; exact task completion releases the form draft.',
  );

  // Explicit active conflict: wait for exact task, retain draft, then require fresh Send.
  await fillForm(page, '4');
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  await page.evaluate(() => window.__cardFormSetResponseMode('active'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 4,
  );
  const activeOp = operationId(postAt(await posts(), 3));
  const activeBlockerId = activeTaskId(activeOp);
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'waiting_approval'),
    activeBlockerId,
  );
  await page.waitForFunction(
    (expectedTaskId) =>
      window.__cardFormRequests.some(
        (row) => row.method === 'GET' && row.url.includes(`taskId=${expectedTaskId}`),
      ),
    activeBlockerId,
  );
  assert.equal(
    await page.locator('textarea').isDisabled(),
    false,
    'A known active-task conflict may still receive a normal owner reply after a local receipt-write failure',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    (await posts()).length,
    4,
    'The unchanged form message stays unsent while its known task is active',
  );
  await page.locator('textarea').fill('Can you confirm the new time?');
  await page.evaluate((taskId) => {
    window.__cardFormSetTaskStatus(taskId, 'done');
    window.__cardFormSetStorageFailure(false);
  }, activeBlockerId);
  await page
    .getByText(
      'The earlier request has finished. Review this message and press Send to try again.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.locator('textarea').inputValue(),
    'Can you confirm the new time?',
    'The volatile conflict path preserves a reply typed before the exact task settled',
  );
  await page.evaluate(() => window.__cardFormSetResponseMode('reply'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 5,
  );
  assert.equal(ownerText(postAt(await posts(), 4)), 'Can you confirm the new time?');
  assert.equal(
    bodyOf(postAt(await posts(), 4)).cardFormSubmission,
    undefined,
    'A volatile active conflict must route a different owner reply as an ordinary turn, not replay the form operation',
  );
  const activeReplyOperationId = bodyOf(postAt(await posts(), 4)).clientOperationId;
  assert.equal(
    typeof activeReplyOperationId,
    'string',
    'The active-conflict reply has its own operation identity',
  );
  const activeReplyTaskId = ownerReplyTaskId(String(activeReplyOperationId));
  assert.equal(
    await page.evaluate((taskId) => window.__cardFormTaskStatuses[taskId], activeReplyTaskId),
    'waiting_approval',
  );
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    activeReplyTaskId,
  );
  await page.waitForFunction(
    (taskId) =>
      window.__cardFormTaskStatuses[taskId] === 'done' &&
      window.__cardFormRequests.some(
        (row) => row.method === 'GET' && row.url.includes(`taskId=${taskId}`),
      ),
    activeReplyTaskId,
  );
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible' });
  try {
    await page.waitForFunction(
      () => {
        const button = document.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
        return !!button;
      },
      undefined,
      { timeout: 12000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      bodyText: document.body.innerText.slice(-2500),
      buttons: [...document.querySelectorAll('button')].map((button) => ({
        text: button.textContent?.trim(),
        ariaLabel: button.getAttribute('aria-label'),
        disabled: (button as HTMLButtonElement).disabled,
      })),
      textarea: document.querySelector('textarea[aria-label="Message"]')?.outerHTML ?? null,
      formDrafts: Object.entries(sessionStorage).filter(([key]) =>
        key.startsWith('assistant:card-form-session:v1:'),
      ),
      requests: window.__cardFormRequests,
    }));
    await writeFile(
      path.join(output, 'active-recovery-send-failure-diagnostic.json'),
      JSON.stringify(
        {
          diagnostic,
          pageErrors: failures,
          consoleErrors,
          waitError: String(error),
        },
        null,
        2,
      ),
    );
    throw error;
  }
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  assert.equal(
    await page.locator('textarea').inputValue(),
    'Dinner details:\nDate: 2026-10-12\nNumber of guests: 4\nConfirmed: No',
    'The owner explicitly reviews the retained form answers into the empty composer after the ordinary reply',
  );
  const reviewedSend = page.getByRole('button', { name: 'Send', exact: true });
  await reviewedSend.waitFor({ state: 'visible' });
  assert.equal(
    await reviewedSend.isDisabled(),
    false,
    'Reviewing the form explicitly enables its Send action',
  );
  await page.evaluate(() => window.__cardFormSetResponseMode('accept'));
  await reviewedSend.click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 6,
  );
  const freshOp = operationId(postAt(await posts(), 5));
  assert.notEqual(
    freshOp,
    activeOp,
    'Explicit resend after exact active task terminal uses a fresh operation ID',
  );
  assert.equal(
    await page.evaluate((taskId) => window.__cardFormTaskStatuses[taskId], formTaskId(freshOp)),
    'waiting_approval',
  );
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    formTaskId(freshOp),
  );
  await page.waitForFunction(
    () =>
      Object.keys(sessionStorage).every(
        (key) => !key.startsWith('assistant:card-form-session:v1:'),
      ),
    undefined,
    { timeout: 12000 },
  );
  results.push(
    'Active-form conflict retains an unsent owner message, waits for its exact task, then only explicit Send starts a fresh operation.',
  );

  // If a blocked submission is overtaken by the exact task terminal while the owner has typed a reply,
  // sending that different text is a normal chat turn and leaves the original form ready for review.
  await fillForm(page, '5');
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  await page.evaluate(() => window.__cardFormSetResponseMode('activeStored'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 7,
  );
  const activeStoredOp = operationId(postAt(await posts(), 6));
  const activeStoredBlockerId = activeTaskId(activeStoredOp);
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'waiting_approval'),
    activeStoredBlockerId,
  );
  await page
    .getByText(
      'Another request for this form is still running. Your message remains an unsent draft. Send it again after that task finishes.',
      { exact: true },
    )
    .waitFor();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    (await posts()).length,
    7,
    'Send does not bypass the active-form guard with the unchanged rejected message',
  );
  await page.locator('textarea').fill('Please clarify the time before booking.');
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    activeStoredBlockerId,
  );
  await page
    .getByText(
      'The earlier request has finished. Review this message and press Send to try again.',
      { exact: true },
    )
    .waitFor();
  await page.evaluate(() => window.__cardFormSetResponseMode('reply'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 8,
  );
  const resolutionReply = postAt(await posts(), 7);
  assert.equal(ownerText(resolutionReply), 'Please clarify the time before booking.');
  assert.equal(
    bodyOf(resolutionReply).cardFormSubmission,
    undefined,
    'An owner reply typed before the blocking task finishes remains an ordinary chat turn',
  );
  const resolutionReplyOperationId = bodyOf(resolutionReply).clientOperationId;
  assert.equal(
    typeof resolutionReplyOperationId,
    'string',
    'The ordinary reply has its own operation identity',
  );
  const resolutionReplyTaskId = ownerReplyTaskId(String(resolutionReplyOperationId));
  assert.equal(
    await page.evaluate((taskId) => window.__cardFormTaskStatuses[taskId], resolutionReplyTaskId),
    'waiting_approval',
  );
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    resolutionReplyTaskId,
  );
  await page.waitForFunction(
    (taskId) => window.__cardFormTaskStatuses[taskId] === 'done',
    resolutionReplyTaskId,
  );
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible' });
  assert.ok(
    (await page.getByRole('button', { name: 'Review in message', exact: true }).count()) > 0,
    'The blocked form answers remain available for a fresh review after the reply',
  );
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  const resolutionSend = page.getByRole('button', { name: 'Send', exact: true });
  await resolutionSend.waitFor({ state: 'visible' });
  assert.equal(
    await resolutionSend.isDisabled(),
    false,
    'The next form is sendable only after its own review and prior reply completion',
  );
  assert.equal(
    await page.evaluate((taskId) => window.__cardFormTaskStatuses[taskId], activeStoredBlockerId),
    'done',
    'Completing the ordinary reply does not change the exact blocker task status',
  );
  await page.evaluate(() => window.__cardFormSetResponseMode('accept'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 9,
  );
  assert.ok(
    bodyOf(postAt(await posts(), 8)).cardFormSubmission,
    'A fresh form send still requires an explicit review and Send action',
  );
  const finalFormOperationId = operationId(postAt(await posts(), 8));
  assert.notEqual(finalFormOperationId, operationId(postAt(await posts(), 6)));
  assert.equal(
    await page.evaluate(
      (taskId) => window.__cardFormTaskStatuses[taskId],
      formTaskId(finalFormOperationId),
    ),
    'waiting_approval',
  );
  await page.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    formTaskId(finalFormOperationId),
  );
  await page.waitForFunction(
    () =>
      Object.keys(sessionStorage).every(
        (key) => !key.startsWith('assistant:card-form-session:v1:'),
      ),
    undefined,
    { timeout: 12000 },
  );
  results.push(
    'When an active conflict settles while a reply is typed, Send routes that text as an ordinary chat turn and the preserved form can be explicitly reviewed and sent afterward.',
  );

  // A typed stale-revision response is definitive; preserve values/text but require an explicit carry and new review.
  const staleContext = await browser.newContext();
  const stalePage = await staleContext.newPage();
  await stalePage.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  watchPage(stalePage);
  await stalePage.goto(`http://127.0.0.1:${address.port}`);
  await fillForm(stalePage, '7');
  await stalePage.getByRole('button', { name: 'Review in message', exact: true }).click();
  await stalePage.evaluate(() => window.__cardFormSetResponseMode('stale'));
  await stalePage.getByRole('button', { name: 'Send', exact: true }).click();
  await stalePage.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 1,
  );
  const staleRows = await stalePage.evaluate(() =>
    window.__cardFormRequests.filter((row) => row.method === 'POST'),
  );
  const staleOperationId = operationId(postAt(staleRows, 0));
  await stalePage
    .getByText(
      'This card changed before your message was accepted. Review its current form, then send again.',
      { exact: true },
    )
    .waitFor();
  await stalePage.evaluate(() =>
    window.__cardFormSetCardRevision('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  );
  await stalePage.reload();
  await stalePage.getByRole('button', { name: 'Carry compatible answers', exact: true }).waitFor();
  assert.equal(await stalePage.getByLabel('Number of guests').inputValue(), '7');
  await stalePage.getByRole('button', { name: 'Carry compatible answers', exact: true }).click();
  await stalePage.getByRole('button', { name: 'Review in message', exact: true }).click();
  await stalePage.evaluate(() => window.__cardFormSetResponseMode('generic409'));
  await stalePage.getByRole('button', { name: 'Send', exact: true }).click();
  await stalePage.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 2,
  );
  const currentRows = await stalePage.evaluate(() =>
    window.__cardFormRequests.filter((row) => row.method === 'POST'),
  );
  const currentOperationId = operationId(postAt(currentRows, 1));
  assert.notEqual(
    currentOperationId,
    staleOperationId,
    'A definitive stale result requires a newly reviewed operation',
  );
  await stalePage.reload();
  await stalePage.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await stalePage.getByRole('button', { name: 'Send', exact: true }).click();
  await stalePage.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 3,
  );
  const retriedRows = await stalePage.evaluate(() =>
    window.__cardFormRequests.filter((row) => row.method === 'POST'),
  );
  const retriedOperationId = operationId(postAt(retriedRows, 2));
  assert.equal(
    retriedOperationId,
    currentOperationId,
    'An untyped 409 remains an unknown outcome and replays its exact operation',
  );
  results.push(
    'Typed stale revision releases only the confirmed-unadmitted operation; generic 409 remains frozen and retries the same operation ID.',
  );
  await staleContext.close();

  // An HTTP 422 definitively rejects admission. The frozen operation must clear durably; a fresh review starts a new one.
  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  await invalidPage.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  watchPage(invalidPage);
  await invalidPage.goto(`http://127.0.0.1:${address.port}`);
  await fillForm(invalidPage, '8');
  await invalidPage.getByRole('button', { name: 'Review in message', exact: true }).click();
  await invalidPage.evaluate(() => window.__cardFormSetResponseMode('invalid422'));
  await invalidPage.getByRole('button', { name: 'Send', exact: true }).click();
  await invalidPage
    .getByText('This form could not be sent. Review the current card and try again.', {
      exact: true,
    })
    .waitFor();
  const rejectedRows = await invalidPage.evaluate(() =>
    window.__cardFormRequests.filter((row) => row.method === 'POST'),
  );
  assert.equal(rejectedRows.length, 1, 'The typed rejection is one definitive form attempt');
  const rejectedOperationId = operationId(postAt(rejectedRows, 0));
  const rejectedDraft = await invalidPage.evaluate(() => {
    const entry = Object.entries(sessionStorage).find(([key]) =>
      key.startsWith('assistant:card-form-session:v1:'),
    );
    return entry ? JSON.parse(entry[1]) : null;
  });
  assert.ok(rejectedDraft, 'Rejected form values remain locally available');
  assert.equal(
    rejectedDraft.operation,
    undefined,
    'Definitive rejection clears the frozen operation durably',
  );
  await invalidPage.reload();
  await invalidPage.getByRole('button', { name: 'Send', exact: true }).waitFor();
  assert.equal(
    await invalidPage.locator('textarea').inputValue(),
    rejectedDraft.composerText ?? '',
    'Rejected form draft remains editable after reload; an absent optional composerText is an empty textarea',
  );
  assert.equal(await invalidPage.getByLabel('Number of guests').inputValue(), '8');
  assert.equal(await invalidPage.locator('textarea').isEnabled(), true);
  assert.equal(
    (
      await invalidPage.evaluate(() =>
        window.__cardFormRequests.filter((row) => row.method === 'POST'),
      )
    ).length,
    1,
    'Reload alone does not retry a definitively rejected request',
  );
  await invalidPage.getByLabel('Number of guests').fill('9');
  await invalidPage.getByRole('button', { name: 'Review in message', exact: true }).click();
  const reviewedAgain = 'Dinner details:\nDate: 2026-10-12\nNumber of guests: 9\nConfirmed: No';
  assert.equal(await invalidPage.locator('textarea').inputValue(), reviewedAgain);
  assert.equal(
    (
      await invalidPage.evaluate(() =>
        window.__cardFormRequests.filter((row) => row.method === 'POST'),
      )
    ).length,
    1,
    'No retry is dispatched until the owner explicitly presses Send',
  );
  await invalidPage.evaluate(() => window.__cardFormSetResponseMode('accept'));
  await invalidPage.getByRole('button', { name: 'Send', exact: true }).click();
  await invalidPage.waitForFunction(
    () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 2,
  );
  const retryRows = await invalidPage.evaluate(() =>
    window.__cardFormRequests.filter((row) => row.method === 'POST'),
  );
  assert.notEqual(
    operationId(postAt(retryRows, 1)),
    rejectedOperationId,
    'A confirmed rejection followed by a fresh review starts a new operation',
  );
  assert.equal(ownerText(postAt(retryRows, 1)), reviewedAgain);
  const invalidRetryTaskId = formTaskId(operationId(postAt(retryRows, 1)));
  assert.equal(
    await invalidPage.evaluate(
      (taskId) => window.__cardFormTaskStatuses[taskId],
      invalidRetryTaskId,
    ),
    'waiting_approval',
  );
  await invalidPage.evaluate(
    (taskId) => window.__cardFormSetTaskStatus(taskId, 'done'),
    invalidRetryTaskId,
  );
  await invalidPage.waitForFunction(
    () =>
      Object.keys(sessionStorage).every(
        (key) => !key.startsWith('assistant:card-form-session:v1:'),
      ),
    undefined,
    { timeout: 12000 },
  );
  await invalidContext.close();
  results.push(
    'A definitive 422 clears its operation across reload, preserves editable values, and requires a fresh review and Send with a new operation ID.',
  );

  // Expired task-status authorization stops the dedicated observer even when the tab becomes visible again.
  for (const status of ['401', '403']) {
    const authContext = await browser.newContext();
    const authPage = await authContext.newPage();
    await authPage.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    watchPage(authPage);
    await authPage.goto(`http://127.0.0.1:${address.port}`);
    await fillForm(authPage, '2');
    await authPage.getByRole('button', { name: 'Review in message', exact: true }).click();
    await authPage.evaluate((value) => {
      window.__cardFormSetStatusMode(value);
      window.__cardFormSetResponseMode('accept');
    }, status);
    await authPage.getByRole('button', { name: 'Send', exact: true }).click();
    await authPage.waitForFunction(
      () => window.__cardFormRequests.filter((row) => row.method === 'POST').length === 1,
    );
    const authPosts = await authPage.evaluate(() =>
      window.__cardFormRequests.filter((row) => row.method === 'POST'),
    );
    const authTaskId = formTaskId(operationId(postAt(authPosts, 0)));
    await authPage.evaluate(
      (taskId) => window.__cardFormSetTaskStatus(taskId, 'waiting_approval'),
      authTaskId,
    );
    await authPage
      .getByText(
        'The form task could not be checked in this session. Keep its message and retry after refreshing Activity.',
        { exact: true },
      )
      .waitFor();
    const expiredPolls = () =>
      authPage.evaluate(
        (taskId) =>
          window.__cardFormRequests.filter(
            (row) =>
              row.method === 'GET' &&
              row.url.includes('wait=0') &&
              row.url.includes(`taskId=${taskId}`),
          ).length,
        authTaskId,
      );
    const beforeVisibility = await expiredPolls();
    assert.ok(beforeVisibility >= 1, `The exact observer received ${status}`);
    await authPage.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(
      await expiredPolls(),
      beforeVisibility,
      `A ${status} response removes visibility polling and does not repeat the expired request`,
    );
    await authContext.close();
  }
  results.push(
    'The exact form-task observer stops after 401/403 and does not poll again when the tab becomes visible.',
  );

  const taskStateAudit = await page.evaluate(() => ({
    taskStatuses: { ...window.__cardFormTaskStatuses },
    taskStatusHistory: [...window.__cardFormTaskStatusHistory],
  }));
  assert.ok(
    Object.keys(taskStateAudit.taskStatuses).every((taskId) => uuidPattern.test(taskId)),
    'Every retained fake task status is keyed by a valid task UUID',
  );
  assert.ok(
    taskStateAudit.taskStatusHistory.every(
      (entry) =>
        uuidPattern.test(entry.taskId) &&
        (entry.previous === null || typeof entry.previous === 'string') &&
        (entry.next === null || typeof entry.next === 'string') &&
        typeof entry.accepted === 'boolean',
    ),
    'Every retained fake task transition has a typed UUID-bound history record',
  );
  assert.ok(
    taskStateAudit.taskStatusHistory.some(
      (entry) =>
        entry.accepted && entry.taskId === formTaskId(firstOperationId) && entry.next === 'done',
    ),
    'History retains the accepted terminal transition for the parked form task',
  );
  assert.ok(
    taskStateAudit.taskStatusHistory.some(
      (entry) =>
        !entry.accepted &&
        entry.taskId === replyTaskId &&
        entry.previous === 'done' &&
        entry.next === 'waiting_approval',
    ),
    'History retains the rejected attempt to regress a completed reply task',
  );

  // A verified owner-session transition removes only the old session partition and cancels stale client use.
  await fillForm(page, '5');
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  assert.ok((await draftKeys()).some((key) => key.includes('synthetic-session-scope-001')));
  await page.evaluate(() => window.__cardFormRemountScope('synthetic-session-scope-002'));
  await page.waitForFunction(() =>
    Object.keys(sessionStorage).every(
      (key) => !key.includes('assistant:card-form-session:v1:synthetic-session-scope-001:'),
    ),
  );
  assert.equal(
    await page.locator('textarea').inputValue(),
    '',
    'A session transition does not expose the prior session composer draft',
  );
  results.push(
    'A verified session-scope change clears only the old local partition and invalidates its in-memory draft.',
  );

  // Sign-out clears this feature namespace only after a successful same-origin response.
  await fillForm(page, '6');
  await page.getByRole('button', { name: 'Review in message', exact: true }).click();
  const beforeSignOut = await draftKeys();
  assert.ok(beforeSignOut.length > 0);
  await page.evaluate(() => (window.__cardFormSignOutMode = 'failure'));
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not sign out. Try again.' }).waitFor();
  assert.deepEqual(
    await draftKeys(),
    beforeSignOut,
    'A failed logout response must preserve retryable form state',
  );
  await page.evaluate(() => (window.__cardFormSignOutMode = 'success'));
  await page.getByRole('button', { name: 'Sign out of this browser', exact: true }).click();
  await page.waitForFunction(() => location.pathname === '/signin');
  assert.equal(
    (
      await page.evaluate(() =>
        Object.keys(sessionStorage).filter((key) =>
          key.startsWith('assistant:card-form-session:v1:'),
        ),
      )
    ).length,
    0,
  );
  results.push(
    'The actual account-menu sign-out form clears form drafts after a successful local logout response; unrelated sessionStorage keys remain scoped.',
  );
  const expectedTransportConsoleErrors = consoleErrors.filter((entry) =>
    entry.text.includes('Synthetic response lost.'),
  );
  const unexpectedConsoleErrors = consoleErrors.filter(
    (entry) => !entry.text.includes('Synthetic response lost.'),
  );
  assert.deepEqual(failures, [], `Uncaught browser page errors: ${JSON.stringify(failures)}`);
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    `Unexpected browser console errors: ${JSON.stringify(unexpectedConsoleErrors)}`,
  );
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        results,
        sourceHashes,
        taskStatuses: taskStateAudit.taskStatuses,
        taskStatusHistory: taskStateAudit.taskStatusHistory,
        browserDiagnostics: {
          pageErrors: failures,
          consoleErrors,
          expectedTransportConsoleErrors,
          unexpectedConsoleErrors,
        },
        limitations: [
          'Synthetic loopback browser harness with fake task/status transport; it does not qualify authenticated Next routes, real owner sessions, PostgreSQL/Firestore composition, model/provider behavior, accessibility tree, or physical devices.',
        ],
      },
      null,
      2,
    ),
  );
  console.log(results.join('\n'));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
