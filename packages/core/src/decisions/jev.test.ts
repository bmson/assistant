import { describe, expect, it, vi } from 'vitest';
import {
  createJevShadowService,
  DECISION_LABELS,
  type DecisionReceipt,
  type DecisionRequest,
} from './jev.js';

const request = (): DecisionRequest => ({
  decisionId: 'd',
  agentId: 'owner',
  turnId: 'turn',
  taskRevision: 'r1',
  schemaVersion: 1,
  task: 'chat_triage',
  dataClass: 'synthetic',
  deadline: Date.now() + 1000,
  contextComplete: true,
  state: {
    currentRequest: 'Explain scheduling and draft a plan.',
    turns: [{ id: 'prior', role: 'user', text: 'My request', sourceHash: 'a'.repeat(64) }],
    exclusions: [],
  },
});
const response = () => ({
  model: 'jev-1.2.3',
  answers: Object.fromEntries(
    DECISION_LABELS.map((label) => [
      label,
      { type: 'noul', noul: label === 'requests_state_change' ? 0.95 : 0.1 },
    ]),
  ),
  usage: { input_tokens: 12, output_tokens: 6 },
});
function setup(raw: unknown = response()) {
  const transport = vi.fn(async () => raw);
  const recordReceipt = vi.fn(async (_receipt: DecisionReceipt) => {});
  return {
    transport,
    recordReceipt,
    service: createJevShadowService({ model: 'jev-1.2.3', transport, recordReceipt }),
  };
}
describe('bounded decision shadow', () => {
  it('keeps independent heads and content-free receipt with no route authority', async () => {
    const s = setup();
    const result = await s.service.evaluate(request());
    expect(result).toMatchObject({
      status: 'accepted',
      mode: 'shadow',
      canControlRoute: false,
      labels: { requests_state_change: 0.95, conceptual_only: 0.1 },
      receipt: { costBasis: 'unknown', usage: { status: 'reported', inputTokens: 12 } },
    });
    expect(JSON.stringify(s.recordReceipt.mock.calls)).not.toContain('Explain scheduling');
    expect(s.transport.mock.calls).toHaveLength(1);
  });
  it.each(['incomplete', 'private', 'oversize', 'many_turns', 'malformed'] as const)(
    'does not dispatch %s input',
    async (kind) => {
      const s = setup();
      const r = request();
      if (kind === 'incomplete') r.contextComplete = false;
      if (kind === 'private') r.dataClass = 'owner_private';
      if (kind === 'oversize') r.state.currentRequest = '🙂'.repeat(7000);
      if (kind === 'many_turns') r.state.turns = Array(21).fill(r.state.turns[0]);
      if (kind === 'malformed') r.state = null as unknown as DecisionRequest['state'];
      expect((await s.service.evaluate(r)).status).not.toBe('accepted');
      expect(s.transport).not.toHaveBeenCalled();
    },
  );
  it.each(['missing', 'extra', 'nan', 'version'] as const)(
    'rejects %s provider contract',
    async (kind) => {
      const raw = response();
      if (kind === 'missing') delete raw.answers.conceptual_only;
      if (kind === 'extra') raw.answers.extra = { type: 'noul', noul: 0.2 };
      if (kind === 'nan') raw.answers.conceptual_only = { type: 'noul', noul: NaN };
      if (kind === 'version') raw.model = 'jev-1.2.4';
      const s = setup(raw);
      const r = await s.service.evaluate(request());
      expect(r.status).toBe('invalid');
      expect(r.receipt?.usage.status).toBe('reported');
    },
  );
  it.each(['conflict', 'reference'] as const)('abstains from %s', async (kind) => {
    const raw = response();
    raw.answers[kind === 'conflict' ? 'conceptual_only' : 'unresolved_reference'] = {
      type: 'noul',
      noul: 0.95,
    };
    expect((await setup(raw).service.evaluate(request())).status).toBe('abstained');
  });
  it('rejects unpinned model', () =>
    expect(() =>
      createJevShadowService({
        model: 'jev-latest',
        transport: async () => response(),
        recordReceipt: async () => {},
      }),
    ).toThrow('pinned'));
  it('reports unknown usage and unavailable when transport fails', async () => {
    const sink = vi.fn(async (_receipt: DecisionReceipt) => {});
    const service = createJevShadowService({
      model: 'jev-1.2.3',
      transport: async () => {
        throw new Error('offline');
      },
      recordReceipt: sink,
    });
    expect((await service.evaluate(request())).status).toBe('unavailable');
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ usage: { status: 'unknown' } });
  });
  it('cannot accept a prediction whose receipt failed', async () => {
    const service = createJevShadowService({
      model: 'jev-1.2.3',
      transport: async () => response(),
      recordReceipt: async () => {
        throw new Error('sink offline');
      },
    });
    expect((await service.evaluate(request())).status).toBe('unavailable');
  });
  it('records late usage after deadline without changing the returned decision', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((resolve_) => {
      resolve = resolve_;
    });
    const sink = vi.fn(async (_receipt: DecisionReceipt) => {});
    let signal: AbortSignal | undefined;
    const service = createJevShadowService({
      model: 'jev-1.2.3',
      transport: async (_, s) => {
        signal = s;
        return pending;
      },
      recordReceipt: sink,
    });
    const r = request();
    r.deadline = Date.now() + 10;
    const result = await service.evaluate(r);
    expect(result.status).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    resolve(response());
    await vi.waitFor(() => expect(sink).toHaveBeenCalledOnce());
    expect(result.labels).toBeUndefined();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ usage: { status: 'reported' } });
  });
});
