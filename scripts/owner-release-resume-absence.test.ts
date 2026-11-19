import { describe, expect, it, vi } from 'vitest';
import { type BootstrapReceipt, RUN_ROOT, SERVICE_ROOT } from './owner-release-current-snapshot.js';
import { assertResumeRevisionsAbsent } from './owner-release-resume-absence.js';

const token = 'synthetic-only-token-example';
const source = 'a'.repeat(40);
const runId = '12345';
const expected = ['agent', 'web'].map(
  (role) => `${RUN_ROOT}${SERVICE_ROOT}${role}/revisions/assistant-${role}-r-${runId}-1-aaaaaaaa`,
);

function receipt() {
  // The consumer supplies an already validated bootstrap receipt. These are the
  // only fields the absence reader is allowed to use to select a target.
  return {
    kind: 'disabled-bootstrap',
    source,
    services: {
      agent: { service: `${SERVICE_ROOT}agent` },
      web: { service: `${SERVICE_ROOT}web` },
    },
  } as BootstrapReceipt;
}

function response(url: string, status = 404, redirected = false) {
  const result = new Response(null, { status });
  Object.defineProperties(result, {
    url: { value: url },
    redirected: { value: redirected },
  });
  return result;
}

describe('exact first-attempt resume revision absence', () => {
  it('accepts two direct 404s for the exact names and permits only bounded GETs', async () => {
    const request = vi.fn<typeof fetch>(async (url) => response(String(url)));
    await assertResumeRevisionsAbsent(receipt(), runId, token, Date.now() + 1000, request);
    expect(request.mock.calls.map(([url]) => url)).toEqual(expected);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([200, 302, 403, 410, 429, 500])(
    'holds when either exact name returns %d',
    async (status) => {
      const request = vi.fn<typeof fetch>(async (url) =>
        response(String(url), String(url) === expected[0] ? status : 404),
      );
      await expect(
        assertResumeRevisionsAbsent(receipt(), runId, token, Date.now() + 1000, request),
      ).rejects.toThrow('Exact resume revision absence is unverified');
    },
  );

  it.each([
    [true, ''],
    [false, 'https://example.invalid/synthetic-other-revision'],
    [false, ''],
  ] as const)('rejects a redirected or unbound 404', async (redirected, url) => {
    const request = vi.fn<typeof fetch>(async (input) =>
      response(String(input) === expected[0] ? url : String(input), 404, redirected),
    );
    await expect(
      assertResumeRevisionsAbsent(receipt(), runId, token, Date.now() + 1000, request),
    ).rejects.toThrow(/unverified/);
  });

  it('cancels the peer on transport failure and suppresses provider error detail', async () => {
    let peerCancelled = false;
    const request = vi.fn<typeof fetch>((url, init) => {
      if (String(url) === expected[0]) return Promise.reject(new Error('private transport detail'));
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            peerCancelled = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        );
        void resolve;
      });
    });
    await expect(
      assertResumeRevisionsAbsent(receipt(), runId, token, Date.now() + 1000, request),
    ).rejects.toThrow(/^Exact resume revision absence is unverified$/);
    expect(peerCancelled).toBe(true);
  });

  it('fails before any read for an invalid deadline, run or binding', async () => {
    const request = vi.fn<typeof fetch>();
    const foreign = receipt();
    foreign.services.web.service = 'projects/other/locations/us-west1/services/assistant-web';
    await expect(
      assertResumeRevisionsAbsent(receipt(), runId, token, Date.now() - 1, request),
    ).rejects.toThrow(/unverified/);
    await expect(
      assertResumeRevisionsAbsent(receipt(), '1/other', token, Date.now() + 1000, request),
    ).rejects.toThrow(/unverified/);
    await expect(
      assertResumeRevisionsAbsent(foreign, runId, token, Date.now() + 1000, request),
    ).rejects.toThrow(/unverified/);
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts pending reads at the shared deadline', async () => {
    let aborts = 0;
    // Keep the worker alive until its unref'ed AbortSignal timeout fires.
    const keepAlive = setTimeout(() => undefined, 1000);
    const request = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborts += 1;
              reject(new Error('deadline'));
            },
            { once: true },
          );
        }),
    );
    try {
      await expect(
        assertResumeRevisionsAbsent(receipt(), runId, token, Date.now() + 30, request),
      ).rejects.toThrow(/unverified/);
      expect(aborts).toBe(2);
    } finally {
      clearTimeout(keepAlive);
    }
  });
});
