/**
 * WEB-17 mounted client race acceptance against the production-shaped local web
 * app and its PostgreSQL-backed conversation/task actions. Task A is a real
 * persisted terminal task loaded through the chat page; poll responses and task
 * B's admission/status responses are scripted in Playwright. This isolates the
 * client ownership race without invoking a worker or model.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { chromium, type Page, type Route } from 'playwright';
import { createWeb17Fixture } from '../../../scripts/web17-delayed-old-poll-fixture.js';

const baseUrl = process.env.SMOKE_BASE_URL;
assert(baseUrl, 'Set SMOKE_BASE_URL to the running loopback production web app');
const origin = new URL(baseUrl);
assert.equal(origin.protocol, 'http:');
assert(['localhost', '127.0.0.1', '::1'].includes(origin.hostname));
const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl, 'Set DATABASE_URL to the isolated CI PostgreSQL database');

function isPathOrChild(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

async function waitFor<T>(promise: Promise<T>, message: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const fixture = createWeb17Fixture(databaseUrl);
const browser = await chromium.launch({ channel: process.env.SMOKE_BROWSER_CHANNEL ?? 'chrome' });
const context = await browser.newContext();

async function createConversation(page: Page): Promise<string> {
  await page.goto(new URL('/chat', origin).toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/mobile/v1/chats', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create' }),
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(created.status, 201, 'The owner session should create an isolated chat');
  assert.match(created.body.conversationId, /^[0-9a-f-]{36}$/i);
  fixture.registerConversation(created.body.conversationId as string);
  return created.body.conversationId as string;
}

function statusPayload(
  taskStatus: string | null,
  options: { activity?: unknown[]; message?: unknown } = {},
) {
  return {
    taskStatus,
    messages: options.message ? [options.message] : [],
    refreshed: [],
    superseded: [],
    nextCursor: null,
    hasMore: false,
    activity: options.activity ?? [],
  };
}

async function syntheticAcceptedStream(
  conversationId: string,
  taskId: string,
  cursor: string,
): Promise<Response> {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({
        type: 'data-task-accepted',
        data: { taskId },
        transient: true,
      });
      writer.write({ type: 'finish', finishReason: 'stop' });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      'x-conversation-id': conversationId,
      'x-owner-message-id': randomUUID(),
      'x-async-task': taskId,
      'x-message-cursor': cursor,
      'cache-control': 'no-store',
    },
  });
}

async function verifyDelayedTerminalPoll(status: 'done' | 'cancelled' | 'failed'): Promise<void> {
  const page = await context.newPage();
  const browserErrors: string[] = [];
  const apiEvents: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiEvents.push(`${request.method()} ${url.pathname}`);
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      apiEvents.push(`${request.method()} ${url.pathname} failed: ${request.failure()?.errorText}`);
    }
  });
  const conversationId = await createConversation(page);
  const oldTaskId = await fixture.insertTerminalTask(conversationId, status);
  const newTaskId = randomUUID();
  const oldCursor = fixture.cursorAt(new Date(0));
  const newCursor = fixture.cursorAt(new Date());

  let releaseOldPoll!: () => void;
  const oldPollRelease = new Promise<void>((resolve) => {
    releaseOldPoll = resolve;
  });
  let oldPollSeen!: () => void;
  const oldPollStarted = new Promise<void>((resolve) => {
    oldPollSeen = resolve;
  });
  let newPollSeen!: () => void;
  const firstNewPollStarted = new Promise<void>((resolve) => {
    newPollSeen = resolve;
  });
  let releaseNewTerminal!: () => void;
  const newTerminalRelease = new Promise<void>((resolve) => {
    releaseNewTerminal = resolve;
  });
  const newPollTasks: string[] = [];
  const admittedTexts: string[] = [];
  const unexpectedChatRequests: string[] = [];
  let newPollCount = 0;
  let admissionCount = 0;
  const routeHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      unexpectedChatRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === '/api/chat/status' && request.method() === 'GET') {
      const taskId = url.searchParams.get('taskId');
      if (!taskId && newPollCount >= 2) {
        await route.fulfill({ json: statusPayload(null) });
        return;
      }
      assert(taskId, 'Every task poll in this scenario must identify its current turn');
      if (taskId === oldTaskId) {
        oldPollSeen();
        await oldPollRelease;
        await route.fulfill({
          json: statusPayload(status, {
            ...(status === 'done'
              ? {
                  message: {
                    id: randomUUID(),
                    role: 'assistant',
                    parts: [{ type: 'text', text: `WEB-17 result from A (${status})` }],
                  },
                }
              : {}),
          }),
        });
        return;
      }
      assert.equal(taskId, newTaskId, 'No unexpected task may take ownership of the poll loop');
      newPollTasks.push(taskId);
      newPollCount += 1;
      if (newPollCount === 1) {
        newPollSeen();
        await route.fulfill({
          json: statusPayload('running', {
            activity: [{ toolName: 'new-task', status: 'running', step: 1 }],
          }),
        });
        return;
      }
      await newTerminalRelease;
      const resultId = randomUUID();
      await route.fulfill({
        json: statusPayload('done', {
          activity: [{ toolName: 'new-task', status: 'succeeded', step: 1 }],
          message: {
            id: resultId,
            role: 'assistant',
            parts: [{ type: 'text', text: `WEB-17 result owned by B (${status})` }],
          },
        }),
      });
      return;
    }
    if (url.pathname === '/api/chat' && request.method() === 'POST') {
      admissionCount += 1;
      if (admissionCount !== 1) {
        unexpectedChatRequests.push(`${request.method()} ${url.pathname} (duplicate)`);
        await route.abort('blockedbyclient');
        return;
      }
      const requestBody = request.postDataJSON() as {
        messages?: Array<{ parts?: Array<{ text?: string }> }>;
      };
      admittedTexts.push(
        requestBody.messages
          ?.at(-1)
          ?.parts?.map((part) => part.text ?? '')
          .join('') ?? '',
      );
      const response = await syntheticAcceptedStream(conversationId, newTaskId, newCursor);
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      });
      return;
    }
    if (
      isPathOrChild(url.pathname, '/api/chat') ||
      isPathOrChild(url.pathname, '/api/mobile/v1/chat')
    ) {
      unexpectedChatRequests.push(`${request.method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  };
  const isChatSafetyRoute = (url: URL) =>
    isPathOrChild(url.pathname, '/api/chat') || isPathOrChild(url.pathname, '/api/mobile/v1/chat');
  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') &&
      requestUrl.origin !== origin.origin
    ) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.route(isChatSafetyRoute, routeHandler);

  try {
    await page.goto(
      new URL(
        `/chat/${conversationId}?task=${oldTaskId}&cursor=${encodeURIComponent(oldCursor)}`,
        origin,
      ).toString(),
      { waitUntil: 'domcontentloaded', timeout: 90_000 },
    );
    const composer = page.getByRole('combobox', { name: 'Message', exact: true });
    try {
      await composer.waitFor({ timeout: 10_000 });
    } catch (error) {
      const details = {
        pagePath: new URL(page.url()).pathname,
        title: await page.title(),
        visibleTextareaLabels: await page
          .locator('textarea')
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
        browserErrors,
        apiEvents,
      };
      throw new Error(`WEB-17 initial composer did not render: ${JSON.stringify(details)}`, {
        cause: error,
      });
    }
    await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
    let pollTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        oldPollStarted,
        new Promise<never>((_, reject) => {
          pollTimeout = setTimeout(
            () => reject(new Error(`Task A ${status} poll did not start`)),
            10_000,
          );
        }),
      ]);
    } finally {
      if (pollTimeout) clearTimeout(pollTimeout);
    }

    // This is the reloaded-task path: the actual page restores the task identity,
    // and Stop uses the real server action against the terminal PostgreSQL row.
    await page.getByRole('button', { name: 'Stop this task', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    await composer.fill('B stays mine while A is late');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
    await composer.fill('Draft that belongs to B');
    assert.equal(await composer.inputValue(), 'Draft that belongs to B');

    releaseOldPoll();
    let newPollTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        firstNewPollStarted,
        new Promise<never>((_, reject) => {
          newPollTimeout = setTimeout(
            () => reject(new Error('Task B did not take over the poll loop')),
            10_000,
          );
        }),
      ]);
    } finally {
      if (newPollTimeout) clearTimeout(newPollTimeout);
    }
    await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
    assert.equal(await composer.inputValue(), 'Draft that belongs to B');
    assert.deepEqual(admittedTexts, ['B stays mine while A is late']);
    if (status === 'done') {
      await page.getByText('WEB-17 result from A (done)', { exact: true }).waitFor();
      assert.equal(await composer.inputValue(), 'Draft that belongs to B');
      await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
    }
    releaseNewTerminal();
    await page
      .getByText(`WEB-17 result owned by B (${status})`, { exact: true })
      .waitFor({ timeout: 20_000 });
    assert.equal(await composer.inputValue(), 'Draft that belongs to B');
    assert.deepEqual(newPollTasks, [newTaskId, newTaskId]);
    assert.equal(admissionCount, 1);
    assert.deepEqual(unexpectedChatRequests, []);
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Stop this task', exact: true }).count(),
      0,
    );
  } finally {
    releaseOldPoll();
    releaseNewTerminal();
    await page.unroute(isChatSafetyRoute, routeHandler).catch(() => {});
    await page.close();
  }
}

async function verifyUnmountedPollDoesNotPublishAfterRemount(): Promise<void> {
  const page = await context.newPage();
  const browserErrors: string[] = [];
  const conversationId = await createConversation(page);
  const taskId = await fixture.insertTerminalTask(conversationId, 'done');
  const cursor = fixture.cursorAt(new Date(0));
  const oldResult = 'WEB-17 stale result from the unmounted request';
  const freshResult = 'WEB-17 result from the restored task poll';

  let releaseOldRequest!: () => void;
  const oldRequestGate = new Promise<void>((resolve) => {
    releaseOldRequest = resolve;
  });
  let oldRequestStarted!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    oldRequestStarted = resolve;
  });
  let oldRouteSettled!: () => void;
  const oldSettled = new Promise<void>((resolve) => {
    oldRouteSettled = resolve;
  });
  let freshRouteSettled!: () => void;
  const freshSettled = new Promise<void>((resolve) => {
    freshRouteSettled = resolve;
  });
  let releaseFreshRequest!: () => void;
  const freshRequestGate = new Promise<void>((resolve) => {
    releaseFreshRequest = resolve;
  });
  let freshRequestStarted!: () => void;
  const freshStarted = new Promise<void>((resolve) => {
    freshRequestStarted = resolve;
  });
  let taskAPollCount = 0;
  let oldRouteEntered = false;
  let oldRouteCount = 0;
  let oldRouteSettledCount = 0;
  let oldGateReleased = false;
  let freshRouteEntered = false;
  let freshPollCount = 0;
  let freshRouteSettledCount = 0;
  let freshGateReleased = false;
  let remounted = false;
  const oldPollIds: string[] = [];
  const freshPollIds: string[] = [];

  const maybeSettleOldRoutes = () => {
    if (oldGateReleased && oldRouteCount > 0 && oldRouteSettledCount === oldRouteCount) {
      oldRouteSettled();
    }
  };
  const maybeSettleFreshRoutes = () => {
    if (freshGateReleased && freshPollCount > 0 && freshRouteSettledCount === freshPollCount) {
      freshRouteSettled();
    }
  };

  page.on('pageerror', (error) => browserErrors.push(error.message));
  const pollTokenPrefix = randomUUID();
  await page.addInitScript(
    ({ expectedTaskId, tokenPrefix }: { expectedTaskId: string; tokenPrefix: string }) => {
      const stateWindow = window as Window & { __web17TaskPollAborts?: string[] };
      const aborts: string[] = [];
      stateWindow.__web17TaskPollAborts = aborts;
      const documentId = crypto.randomUUID();
      let sequence = 0;
      const originalFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = new URL(
          input instanceof Request ? input.url : input.toString(),
          window.location.href,
        );
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (
          requestUrl.pathname === '/api/chat/status' &&
          requestUrl.searchParams.get('taskId') === expectedTaskId
        ) {
          const pollId = `${tokenPrefix}-${documentId}-${++sequence}`;
          signal?.addEventListener('abort', () => aborts.push(pollId), { once: true });
          const headers = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init?.headers).forEach((value, name) => {
            headers.set(name, value);
          });
          headers.set('x-web17-poll-id', pollId);
          return originalFetch(input, { ...init, headers });
        }
        return originalFetch(input, init);
      }) as typeof window.fetch;
    },
    { expectedTaskId: taskId, tokenPrefix: pollTokenPrefix },
  );

  const routeHandler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin.origin) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === '/api/chat/status' && request.method() === 'GET') {
      const requestedTaskId = url.searchParams.get('taskId');
      if (requestedTaskId === taskId) {
        const pollId = await request.headerValue('x-web17-poll-id');
        assert.ok(pollId?.startsWith(`${pollTokenPrefix}-`));
        taskAPollCount += 1;
        if (!remounted) {
          oldRouteCount += 1;
          oldPollIds.push(pollId as string);
          oldRouteEntered = true;
          oldRequestStarted();
          await oldRequestGate;
          try {
            // The component has unmounted and aborted this request. Attempting
            // to answer it late must not publish into the remounted chat.
            await route.fulfill({
              json: statusPayload('done', {
                message: {
                  id: randomUUID(),
                  role: 'assistant',
                  parts: [{ type: 'text', text: oldResult }],
                },
              }),
            });
          } catch {
            // Playwright may report that the browser already closed the route.
          } finally {
            oldRouteSettledCount += 1;
            maybeSettleOldRoutes();
          }
          return;
        }
        freshRouteEntered = true;
        freshPollCount += 1;
        freshPollIds.push(pollId as string);
        freshRequestStarted();
        await freshRequestGate;
        try {
          await route.fulfill({
            json: statusPayload('done', {
              message: {
                id: randomUUID(),
                role: 'assistant',
                parts: [{ type: 'text', text: freshResult }],
              },
            }),
          });
        } finally {
          freshRouteSettledCount += 1;
          maybeSettleFreshRoutes();
        }
        return;
      }
      assert.equal(requestedTaskId, null, 'No other task may be observed in this scenario');
      await route.fulfill({ json: statusPayload(null) });
      return;
    }
    if (
      isPathOrChild(url.pathname, '/api/chat') ||
      isPathOrChild(url.pathname, '/api/mobile/v1/chat')
    ) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  };
  const isChatSafetyRoute = (url: URL) =>
    isPathOrChild(url.pathname, '/api/chat') || isPathOrChild(url.pathname, '/api/mobile/v1/chat');
  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      (requestUrl.protocol === 'http:' || requestUrl.protocol === 'https:') &&
      requestUrl.origin !== origin.origin
    ) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await page.route(isChatSafetyRoute, routeHandler);

  try {
    const deepLink = () =>
      new URL(
        `/chat/${conversationId}?task=${taskId}&cursor=${encodeURIComponent(cursor)}`,
        origin,
      ).toString();
    await page.goto(deepLink(), { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const composer = page.getByRole('combobox', { name: 'Message', exact: true });
    await composer.waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
    await waitFor(oldStarted, 'Task A initial poll did not start');
    const abortsBeforeUnmount = await page.evaluate(
      () => (window as Window & { __web17TaskPollAborts?: string[] }).__web17TaskPollAborts ?? [],
    );
    const pollIdToAbort = oldPollIds
      .slice()
      .reverse()
      .find((pollId) => !abortsBeforeUnmount.includes(pollId));
    assert.ok(pollIdToAbort, 'Task A must have an outstanding request before unmount');

    await page.getByRole('link', { name: 'All chats', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/chat/all', { timeout: 20_000 });
    await composer.waitFor({ state: 'detached', timeout: 10_000 });
    await page.waitForFunction(
      (expectedPollId) =>
        (window as Window & { __web17TaskPollAborts?: string[] }).__web17TaskPollAborts?.includes(
          expectedPollId,
        ) ?? false,
      pollIdToAbort,
      { timeout: 10_000 },
    );
    const exactOldPollAborted = await page.evaluate(
      (expectedPollId) =>
        (window as Window & { __web17TaskPollAborts?: string[] }).__web17TaskPollAborts?.includes(
          expectedPollId,
        ) ?? false,
      pollIdToAbort,
    );
    assert.equal(exactOldPollAborted, true, 'Unmounting the chat must abort the held Task A poll');

    // The ordinary list link intentionally drops task/cursor query state. Use
    // the same supported task deep link to restore the exact persisted A poll.
    remounted = true;
    await page.goto(deepLink(), { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await composer.waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();
    await waitFor(freshStarted, 'Task A fresh poll did not start after remount');

    // Keep the aborted response unresolved until the fresh poll is active. This
    // proves a late completion from A cannot replace or disturb the remounted
    // task controls while the new request is still waiting.
    oldGateReleased = true;
    releaseOldRequest();
    maybeSettleOldRoutes();
    await waitFor(oldSettled, 'Aborted task A route did not settle');
    assert.equal(await page.getByText(oldResult, { exact: true }).count(), 0);
    assert.equal(await page.getByText(freshResult, { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Stop this task', exact: true }).waitFor();

    freshGateReleased = true;
    releaseFreshRequest();
    maybeSettleFreshRoutes();
    await waitFor(freshSettled, 'Fresh task A route did not settle');
    await page.getByText(freshResult, { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    assert.equal(await page.getByText(oldResult, { exact: true }).count(), 0);
    assert.equal(await page.getByText(freshResult, { exact: true }).count(), 1);
    assert.ok(oldRouteCount >= 1, 'The initial task A poll must reach the held route');
    assert.equal(taskAPollCount, oldRouteCount + freshPollCount);
    const abortedFreshPollIds = await page.evaluate(
      () => (window as Window & { __web17TaskPollAborts?: string[] }).__web17TaskPollAborts ?? [],
    );
    const effectiveFreshPollIds = freshPollIds.filter(
      (pollId) => !abortedFreshPollIds.includes(pollId),
    );
    assert.equal(effectiveFreshPollIds.length, 1, 'Exactly one fresh Task A poll must complete');
    assert.deepEqual(browserErrors, []);
  } finally {
    oldGateReleased = true;
    releaseOldRequest();
    maybeSettleOldRoutes();
    freshGateReleased = true;
    releaseFreshRequest();
    maybeSettleFreshRoutes();
    try {
      if (oldRouteEntered) await waitFor(oldSettled, 'Old task A route did not drain', 5_000);
      if (freshRouteEntered) await waitFor(freshSettled, 'Fresh task A route did not drain', 5_000);
    } finally {
      await page.unroute(isChatSafetyRoute, routeHandler).catch(() => {});
      await page.close();
    }
  }
}

try {
  for (const status of ['done', 'cancelled', 'failed'] as const) {
    await verifyDelayedTerminalPoll(status);
  }
  await verifyUnmountedPollDoesNotPublishAfterRemount();
  console.log(
    'WEB-17 mounted client ownership passed for delayed A done/cancelled/failed polls and B-free task A abort/remount; B admission, status payloads and restored task response were synthetic, with no model/provider or worker execution.',
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.cleanup();
}
