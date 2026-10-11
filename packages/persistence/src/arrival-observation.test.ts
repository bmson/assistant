import { describe, expect, it } from 'vitest';
import { isLegacyArrivalTrigger, redactTerminalArrivalTask } from './arrival-observation.js';

const agentId = '00000000-0000-4000-8000-000000000001';
const externalEventId = `arrival:${agentId}:2026-09-24:47.12,-122.57`;
const instruction =
  'Accurate location observations at least three minutes apart suggest the owner has stopped near a new area: an unlabeled place (lat 47.1234, lng -122.5678). Decide whether one proactive note is worth a push right now.';
const legacyTrigger = {
  source: 'internal',
  agentId,
  trust: 'assistant',
  externalEventId,
  payload: { instruction },
};

describe('legacy arrival trigger retirement', () => {
  it('recognizes only the instruction-only legacy arrival envelope', () => {
    expect(isLegacyArrivalTrigger(legacyTrigger, agentId, externalEventId)).toBe(true);
    expect(
      isLegacyArrivalTrigger(
        { ...legacyTrigger, payload: { instruction, extra: true } },
        agentId,
        externalEventId,
      ),
    ).toBe(false);
    expect(
      isLegacyArrivalTrigger(
        { ...legacyTrigger, payload: { instruction: 'A different internal task.' } },
        agentId,
        externalEventId,
      ),
    ).toBe(false);
  });

  it('removes location-bearing instruction, coordinates, and grid key on terminal completion', () => {
    const redaction = redactTerminalArrivalTask(legacyTrigger, agentId, externalEventId);

    expect(redaction).toMatchObject({
      trigger: { payload: { kind: 'arrival' } },
      externalEventId: null,
      title: null,
      state: {},
    });
    expect(JSON.stringify(redaction)).not.toContain('47.1234');
    expect(JSON.stringify(redaction)).not.toContain('-122.5678');
    expect(JSON.stringify(redaction)).not.toContain('47.12,-122.57');
    expect(JSON.stringify(redaction)).not.toContain('instruction');
  });

  it('keeps safe daily dedupe for current structured arrival triggers', () => {
    const currentId = `arrival:${agentId}:2026-09-24`;
    const currentTrigger = {
      source: 'internal',
      agentId,
      trust: 'assistant',
      externalEventId: currentId,
      payload: { kind: 'arrival', arrivalObservationId: 'opaque', instruction: 'No place data.' },
    };

    expect(redactTerminalArrivalTask(currentTrigger, agentId, currentId)).toMatchObject({
      trigger: { externalEventId: currentId, payload: { kind: 'arrival' } },
      externalEventId: currentId,
      state: {},
    });
  });
});
