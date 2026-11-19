// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EstimatedCostTransport } from '@/app/chat/[id]/estimated-cost-transport';
import { EstimatedCostRequestReview } from './request-review';

vi.mock('@/app/chat/[id]/inline-estimated-cost-request', () => ({
  InlineEstimatedCostRequest: ({ part }: { part: { operationId: string } }) => (
    <div>Exact request: {part.operationId}</div>
  ),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('opens the exact selected operation after its canonical read', async () => {
  const read = vi.fn(async (operationId: string) => ({
    ok: true as const,
    request: { status: 'pending' as const, operationId, quote: { operationId } },
    tracking: null,
  }));
  const transport = { read } as unknown as EstimatedCostTransport;
  await act(async () =>
    root.render(<EstimatedCostRequestReview operationId="operation-b" transport={transport} />),
  );
  expect(read).toHaveBeenCalledExactlyOnceWith('operation-b');
  expect(container.textContent).toContain('Exact request: operation-b');
});

it('does not open a different or unavailable request', async () => {
  const read = vi.fn(async () => ({
    ok: true as const,
    request: {
      status: 'pending' as const,
      operationId: 'operation-b',
      quote: { operationId: 'operation-b' },
    },
    tracking: null,
  }));
  const transport = { read } as unknown as EstimatedCostTransport;
  await act(async () =>
    root.render(<EstimatedCostRequestReview operationId="operation-a" transport={transport} />),
  );
  expect(container.textContent).toContain('unavailable');
  expect(container.textContent).not.toContain('Exact request');
});
