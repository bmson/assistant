// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import type { EstimatedCostDecision, EstimatedCostQuote } from '@assistant/persistence';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCostDecision, retainCostDecision } from './estimated-cost-decision';
import type { EstimatedCostTransport } from './estimated-cost-transport';
import { InlineEstimatedCostRequest } from './inline-estimated-cost-request';

const session = 'synthetic-owner-session';
function quote(operationId = 'request-a'): EstimatedCostQuote {
  return {
    type: 'estimated-cost-approval',
    operationId,
    taskId: `task-${operationId}`,
    requestText: `Synthetic ${operationId}`,
    quoteId: `quote-${operationId}`,
    quoteVersion: 'v1',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    nextAttemptMicros: 17_500,
    allowanceMicros: 200_000,
    recordedDailyMicros: 270_000,
    recordedMonthlyMicros: 2_710_000,
    totalHeldMicros: 5_760_000,
    eligibleHistoricalUnknownMicros: 5_760_000,
    pendingApprovalMicros: 200_000,
    dailyCeilingMicros: 6_000_000,
    monthlyCeilingMicros: 50_000_000,
    dailyProjectedGrossMicros: 6_230_000,
    monthlyProjectedGrossMicros: 8_670_000,
    complete: true,
    canApprove: true,
  };
}
function transport(): EstimatedCostTransport {
  return {
    read: vi.fn<EstimatedCostTransport['read']>(async (operationId) => ({
      ok: true,
      request: { status: 'pending', operationId, quote: quote(operationId) },
    })),
    refresh: vi.fn<EstimatedCostTransport['refresh']>(async ({ operationId }) => ({
      ok: true,
      request: {
        status: 'pending',
        operationId,
        quote: { ...quote(operationId), quoteId: 'refreshed' },
      },
    })),
    decide: vi.fn<EstimatedCostTransport['decide']>(async () => {
      throw new Error('Response lost');
    }),
    receipt: vi.fn<EstimatedCostTransport['receipt']>(async (operationId, decisionId) => ({
      ok: false,
      outcome: 'unconfirmed',
      operationId,
      decisionId,
      message: 'Still checking',
    })),
  };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
async function mount(api: EstimatedCostTransport) {
  await act(async () =>
    root.render(
      <InlineEstimatedCostRequest part={quote()} formSessionScope={session} transport={api} />,
    ),
  );
}

describe('mounted request-scoped estimated spending approval', () => {
  it('stops presenting unused approved authority as available when its clock expires without a refresh', async () => {
    vi.useFakeTimers();
    const api = transport();
    api.read = vi.fn<EstimatedCostTransport['read']>(async (operationId) => ({
      ok: true,
      request: {
        status: 'approved',
        operationId,
        quote: quote(),
        grantExpiresAt: new Date(Date.now() + 1_000).toISOString(),
      },
    }));
    await mount(api);
    expect(container.textContent).toContain('Available until');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(container.textContent).toContain('Unused allowance expired');
    expect(container.textContent).not.toContain('Available until');
    expect(container.textContent).not.toContain('Planned total');
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(api.decide).not.toHaveBeenCalled();
  });
  it('leaves another request and a newer composer draft usable while A is pending or unconfirmed', async () => {
    const api = transport();
    await act(async () =>
      root.render(
        <>
          <InlineEstimatedCostRequest part={quote()} formSessionScope={session} transport={api} />
          <InlineEstimatedCostRequest
            part={quote('request-b')}
            formSessionScope={session}
            transport={api}
          />
          <input aria-label="Draft" defaultValue="Newer draft for B" />
          <button type="button">Send B</button>
        </>,
      ),
    );
    const cards = container.querySelectorAll('section');
    expect(cards[0]?.textContent).toContain('Awaiting approval · planned');
    expect(cards[0]?.textContent).toContain('$6.23');
    expect(cards[0]?.textContent).toContain('included once');
    await click('Approve $0.20', cards[0]);
    await click('Approve $0.20?', cards[0]);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input')?.value).toBe('Newer draft for B');
    expect(
      [...cards[1].querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))
        ?.disabled,
    ).toBe(false);
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send B')?.disabled,
    ).toBe(false);
    expect(cards[0]?.textContent).toContain('not been confirmed');
  });

  it('persists before POST and recovers through the exact receipt without retrying the mutation', async () => {
    const api = transport();
    let sent: EstimatedCostDecision | undefined;
    api.decide = vi.fn<EstimatedCostTransport['decide']>(async (decision) => {
      sent = decision;
      expect(
        readCostDecision(window.sessionStorage, { session, operationId: 'request-a' }),
      ).toEqual(decision);
      throw new Error('Response lost');
    });
    await mount(api);
    await click('Approve $0.20');
    await click('Approve $0.20?');
    expect(sent).toBeDefined();
    // A generic approved read is not a receipt for this client's decision.
    api.read = vi.fn<EstimatedCostTransport['read']>(async (operationId) => ({
      ok: true,
      request: {
        status: 'approved',
        operationId,
        quote: quote(),
        grantExpiresAt: new Date(Date.now() + 1_000_000).toISOString(),
      },
    }));
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount(api);
    expect(api.receipt).toHaveBeenCalledWith('request-a', sent?.decisionId);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(1);
    api.receipt = vi.fn<EstimatedCostTransport['receipt']>(async () => ({
      ok: true,
      receipt: {
        ...(sent as EstimatedCostDecision),
        status: 'approved',
        allowanceMicros: 200_000,
        expiresAt: new Date(Date.now() + 1_000_000).toISOString(),
      },
    }));
    await click('Check decision result');
    expect(window.sessionStorage.length).toBe(0);
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Allowance approved');
  });

  it('does not post when local intent storage is unavailable', async () => {
    const api = transport();
    await act(async () =>
      root.render(
        <InlineEstimatedCostRequest
          part={quote()}
          formSessionScope={session}
          transport={api}
          storage={{
            getItem: () => null,
            setItem: () => {
              throw new Error('Storage blocked');
            },
            removeItem: () => {},
          }}
        />,
      ),
    );
    await click('Approve $0.20');
    await click('Approve $0.20?');
    expect(api.decide).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Storage blocked');
  });

  it('keeps a confirmed decision separate from later current state and a new estimate for the same request', async () => {
    const api = transport();
    api.decide = vi.fn<EstimatedCostTransport['decide']>(async (decision) => ({
      ok: true,
      receipt: {
        operationId: decision.operationId,
        quoteId: decision.quoteId,
        decisionId: decision.decisionId,
        status: 'approved',
        allowanceMicros: 200_000,
        expiresAt: new Date(Date.now() + 1_000_000).toISOString(),
      },
    }));
    await mount(api);
    // This is a later canonical lifecycle, not proof of the decision POST itself.
    api.read = vi.fn<EstimatedCostTransport['read']>(async (operationId) => ({
      ok: true,
      request: { status: 'cancelled', operationId, quote: quote() },
    }));
    await click('Approve $0.20');
    await click('Approve $0.20?');
    expect(container.textContent).toContain('Your approval of $0.20 was confirmed.');
    expect(container.textContent).toContain('Request cancelled');
    expect(container.textContent).not.toContain('Planned total');
    const next = { ...quote(), quoteId: 'next-quote', quoteVersion: 'v2' };
    api.read = vi.fn<EstimatedCostTransport['read']>(async (operationId) => ({
      ok: true,
      request: { status: 'pending', operationId, quote: next },
    }));
    await act(async () =>
      root.render(
        <InlineEstimatedCostRequest part={next} formSessionScope={session} transport={api} />,
      ),
    );
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))
        ?.disabled,
    ).toBe(false);
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it('does not treat a missing receipt as proof of failure or allow another decision', async () => {
    const api = transport();
    const decision: EstimatedCostDecision = {
      operationId: 'request-a',
      quoteId: 'quote-request-a',
      quoteVersion: 'v1',
      decisionId: 'earlier-decision',
      decision: 'decline',
    };
    retainCostDecision(window.sessionStorage, { session, operationId: 'request-a' }, decision);
    api.receipt = vi.fn<EstimatedCostTransport['receipt']>(async () => ({
      ok: false,
      outcome: 'not_found',
      message: 'Not found',
    }));
    await mount(api);
    await click('Check decision result');
    expect(api.decide).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
    expect(readCostDecision(window.sessionStorage, { session, operationId: 'request-a' })).toEqual(
      decision,
    );
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))
        ?.disabled,
    ).toBe(true);
  });

  it('ignores a late response from an old session and never clears the new session draft', async () => {
    const api = transport();
    let resolveOld!: (value: Awaited<ReturnType<EstimatedCostTransport['read']>>) => void;
    api.read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementation(async (operationId) => ({
        ok: true,
        request: { status: 'pending', operationId, quote: quote(operationId) },
      }));
    await mount(api);
    await act(async () =>
      root.render(
        <>
          <InlineEstimatedCostRequest
            part={quote('request-b')}
            formSessionScope="new-owner-session"
            transport={api}
          />
          <input defaultValue="Preserved B draft" />
        </>,
      ),
    );
    await act(async () =>
      resolveOld({
        ok: true,
        request: { status: 'declined', operationId: 'request-a', quote: quote() },
      }),
    );
    expect(container.textContent).toContain('Synthetic request-b');
    expect(container.textContent).not.toContain('Request declined');
    expect(container.querySelector('input')?.value).toBe('Preserved B draft');
  });

  it('offers no approval for expired quotes and does not mint a quote on mount, including Strict Mode', async () => {
    const api = transport();
    api.read = vi.fn<EstimatedCostTransport['read']>(async (operationId) => ({
      ok: true,
      request: {
        status: 'pending',
        operationId,
        quote: { ...quote(), expiresAt: new Date(Date.now() - 1_000).toISOString() },
      },
    }));
    await act(async () =>
      root.render(
        <StrictMode>
          <InlineEstimatedCostRequest part={quote()} formSessionScope={session} transport={api} />
        </StrictMode>,
      ),
    );
    expect(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Approve'))
        ?.disabled,
    ).toBe(true);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(api.decide).not.toHaveBeenCalled();
    await click('Refresh estimate');
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.decide).not.toHaveBeenCalled();
  });
});
