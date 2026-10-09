import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { type BrowserEgressProxy, startBrowserEgressProxy } from './egress-proxy.js';
import { type JobInput, parseJobInput } from './input.js';
import { assertPublicHttpUrl } from './network.js';
import { loadProfile, saveProfile } from './profile.js';
import { runSteps } from './steps.js';
import { buildStores } from './storage.js';

/**
 * The Workspace browser job. Credential-free by construction: it receives a
 * plan + one-shot callback token via env, reads/writes only the agent's
 * Workspace storage, and reports back over a single HTTP callback. It has no
 * database access and no API keys. Always exits 0 — failure is a callback
 * payload, not a job retry (the executor's timeout backstop covers total loss).
 */

interface JobResult {
  ok: boolean;
  goal: string;
  outputs: unknown[];
  screenshots: string[];
  finalUrl?: string;
  tracePath?: string;
  profile?: { loaded: boolean; persistedBytes: number };
  error?: string;
  [key: string]: unknown;
}

const MAX_TRACE_BYTES = 50 * 1024 * 1024;

async function run(input: JobInput): Promise<JobResult> {
  const stores = buildStores(input.storage);
  const encKey = process.env.PROFILE_ENC_KEY ?? '';
  const work = await mkdtemp(path.join(os.tmpdir(), 'browser-job-'));
  const profileDir = path.join(work, 'profile');
  let egressProxy: BrowserEgressProxy | undefined;
  try {
    const profileLoaded = input.plan.useProfile
      ? await loadProfile(stores.workspace, profileDir, encKey)
      : false;
    const tracesEnabled = process.env.BROWSER_TRACES === 'true';
    egressProxy = await startBrowserEgressProxy();
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      chromiumSandbox: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
      proxy: { server: egressProxy.url },
      // WebRTC's ICE/STUN/TURN traffic egresses as raw UDP that never passes
      // through the loopback HTTP(S) proxy or context.route, so it would be an
      // exfiltration path around every other network control. Force any WebRTC
      // through the proxy (which cannot carry UDP, so it simply fails) and
      // additionally remove the peer-connection constructors below.
      args: [
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 assistant-workspace/0.1',
    });

    let finalUrl: string | undefined;
    let tracePath: string | undefined;
    let stepResult: Awaited<ReturnType<typeof runSteps>>;
    try {
      // Every HTTP request, including redirects and subresources, is checked
      // immediately before Chromium may issue it. Blocking service workers and
      // WebSockets closes the two common paths around request routing.
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        let protocol = '';
        try {
          protocol = new URL(requestUrl).protocol;
          if (protocol === 'http:' || protocol === 'https:') {
            await assertPublicHttpUrl(requestUrl);
          } else if (!['data:', 'blob:', 'about:'].includes(protocol)) {
            throw new Error(`unsupported request protocol: ${protocol}`);
          }
          await route.continue();
        } catch (err) {
          console.error(`blocked browser request (${protocol || 'invalid URL'}): ${String(err)}`);
          await route.abort('blockedbyclient');
        }
      });
      await context.routeWebSocket('**/*', (socket) => socket.close({ code: 1008 }));
      // Defense in depth for the WebRTC UDP egress path: no form-fill/read plan
      // needs peer connections, so remove the constructors entirely before any
      // page script runs. Injected as a string so it is not type-checked against
      // the worker's Node lib (it runs in the page, where globalThis is window).
      await context.addInitScript({
        content:
          "for (const n of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel']) { try { Object.defineProperty(globalThis, n, { value: undefined, configurable: false }); } catch (e) {} }",
      });

      if (tracesEnabled) {
        await context.tracing.start({ screenshots: true, snapshots: true });
      }
      const page = context.pages()[0] ?? (await context.newPage());
      stepResult = await runSteps(page, input.plan.steps, {
        executionId: createHash('sha256')
          .update(JSON.stringify([input.taskId, input.callbackToken]))
          .digest('hex'),
        taskId: input.taskId,
        workspace: stores.workspace,
      });
      finalUrl = page.url();

      if (tracesEnabled) {
        const traceFile = path.join(work, 'trace.zip');
        await context.tracing.stop({ path: traceFile });
        const traceSize = (await stat(traceFile)).size;
        if (traceSize <= MAX_TRACE_BYTES) {
          tracePath = `traces/${input.taskId}-${Date.now()}.zip`;
          await stores.traces.put(tracePath, await readFile(traceFile), 'application/zip');
        } else {
          console.error(`trace ${traceSize}B exceeds cap — not uploading`);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }

    let persistedBytes = 0;
    if (input.plan.useProfile) {
      persistedBytes = await saveProfile(stores.workspace, profileDir, encKey).catch((err) => {
        console.error('profile persist failed', err);
        return 0;
      });
    }

    return {
      ok: stepResult.failedAtStep === undefined,
      goal: input.plan.goal,
      outputs: stepResult.outputs,
      screenshots: stepResult.screenshots,
      finalUrl,
      tracePath,
      profile: { loaded: profileLoaded, persistedBytes },
      ...(stepResult.failedAtStep !== undefined
        ? { error: `plan failed at step ${stepResult.failedAtStep}` }
        : {}),
    };
  } finally {
    await egressProxy?.close().catch((error) => console.error('egress proxy close failed', error));
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The agent's webhook routes cap request bodies at 512 KiB, and a rejected
 * callback strands the task until its timeout backstop. Shrink oversized
 * results here — dropping extracted text from the largest outputs first — so
 * the callback always fits. 400 KiB leaves headroom for JSON overhead.
 */
const CALLBACK_BODY_BUDGET = 400 * 1024;

function fitResultToBudget(result: JobResult): JobResult {
  if (JSON.stringify(result).length <= CALLBACK_BODY_BUDGET) return result;
  const outputs = [...result.outputs];
  // Repeatedly halve the largest serialized output until the body fits.
  for (let round = 0; round < 16; round++) {
    let largest = -1;
    let largestLength = 0;
    for (const [index, output] of outputs.entries()) {
      const length = JSON.stringify(output)?.length ?? 0;
      if (length > largestLength) {
        largest = index;
        largestLength = length;
      }
    }
    if (largest < 0 || largestLength < 1024) break;
    const serialized = JSON.stringify(outputs[largest]) ?? '';
    outputs[largest] = {
      truncated: true,
      note: `output truncated from ${serialized.length} chars to fit the callback size limit`,
      preview: serialized.slice(0, Math.floor(largestLength / 2)),
    };
    const candidate = { ...result, outputs };
    if (JSON.stringify(candidate).length <= CALLBACK_BODY_BUDGET) return candidate;
  }
  return { ...result, outputs };
}

async function postCallback(input: JobInput, result: JobResult): Promise<void> {
  const body = JSON.stringify({
    taskId: input.taskId,
    token: input.callbackToken,
    result: fitResultToBudget(result),
  });
  const delaysMs = [0, 2_000, 5_000, 15_000];
  for (const [attempt, delay] of delaysMs.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(input.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      // 4xx other than 409 will not improve with retries
      if (res.status !== 409 && res.status < 500) {
        console.error(`callback rejected: ${res.status} ${await res.text()}`);
        return;
      }
      console.error(`callback attempt ${attempt + 1} got ${res.status} — retrying`);
    } catch (err) {
      console.error(`callback attempt ${attempt + 1} failed: ${err}`);
    }
  }
  console.error('callback exhausted retries — the task will settle via its timeout backstop');
}

async function main(): Promise<void> {
  let input: JobInput;
  try {
    input = parseJobInput(process.env.BROWSER_JOB_INPUT);
  } catch (err) {
    // No input → no callback target; all we can do is log.
    console.error('invalid job input:', err);
    return;
  }

  const started = Date.now();
  const result = await run(input).catch(
    (err): JobResult => ({
      ok: false,
      goal: input.plan?.goal ?? '',
      outputs: [],
      screenshots: [],
      error: String(err).slice(0, 1000),
    }),
  );
  result.durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      msg: 'browser job finished',
      taskId: input.taskId,
      ok: result.ok,
      durationMs: result.durationMs,
      steps: result.outputs.length,
    }),
  );
  await postCallback(input, result);
}

await main();
process.exit(0);
