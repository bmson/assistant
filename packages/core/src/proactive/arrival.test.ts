import type { LocationPingRepository, TaskRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { hasConfirmedArrival, maybeEnqueueArrivalNudgeWithRepository } from './arrival.js';

const NOW = new Date('2026-06-15T12:04:00Z');
const AGENT_ID = '3ba0f740-8049-4c7a-9818-aa158b4d53d8';
const arrival = {
  observationId: '8bbfcf58-8b57-4a65-bd5e-390d1bcf8271',
  lat: 64.1123,
  lng: -21.9,
  accuracyM: 10,
  capturedAt: new Date(NOW.getTime() - 4 * 60_000),
};

describe('maybeEnqueueArrivalNudgeWithRepository', () => {
  it('does not make a task when the opaque source reference has expired', async () => {
    const locations = {
      isArrivalObservationActive: vi.fn().mockResolvedValue(false),
      recent: vi.fn(),
      hasArrivalTaskSince: vi.fn(),
    } as unknown as LocationPingRepository;
    const createTask = vi.fn();
    const tasks = { kind: 'task-lease-repository', createTask } as unknown as TaskRepository;

    await expect(
      maybeEnqueueArrivalNudgeWithRepository(
        locations,
        tasks,
        { id: AGENT_ID, timezone: 'Atlantic/Reykjavik' },
        arrival,
        NOW,
      ),
    ).resolves.toBe(false);
    expect(locations.recent).not.toHaveBeenCalled();
    expect(locations.hasArrivalTaskSince).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('stores only an opaque expiring ref and generic text, never location details', async () => {
    const locations = {
      isArrivalObservationActive: vi.fn().mockResolvedValue(true),
      recent: vi.fn().mockResolvedValue([
        {
          lat: 64.2,
          lng: -21.7,
          accuracyM: 10,
          capturedAt: new Date(arrival.capturedAt.getTime() - 40 * 60_000),
        },
        {
          lat: 64.1122,
          lng: -21.9001,
          accuracyM: 10,
          capturedAt: new Date(arrival.capturedAt.getTime() - 4 * 60_000),
        },
      ]),
      hasArrivalTaskSince: vi.fn().mockResolvedValue(false),
    } as unknown as LocationPingRepository;
    let saved: Record<string, unknown> | undefined;
    const createTask = vi.fn(async (input: Record<string, unknown>) => {
      saved = input;
      return { created: true, task: { status: 'done' } };
    });
    const tasks = { kind: 'task-lease-repository', createTask } as unknown as TaskRepository;

    await expect(
      maybeEnqueueArrivalNudgeWithRepository(
        locations,
        tasks,
        { id: AGENT_ID, timezone: 'Atlantic/Reykjavik' },
        arrival,
        NOW,
      ),
    ).resolves.toBe(true);

    const serialized = JSON.stringify(saved);
    expect(serialized).toContain(arrival.observationId);
    expect(serialized).toContain('arrivalExpiresAt');
    expect(serialized).toContain('successful_silent');
    expect(serialized).not.toContain(String(arrival.lat));
    expect(serialized).not.toContain(String(arrival.lng));
    expect(serialized).not.toContain('Reykjavík');
    expect(serialized).not.toContain('Reykjavik Harbour');
    expect(serialized).toContain(`arrival:${AGENT_ID}:2026-06-15`);
  });

  it('requires separated stationary samples at a new place', () => {
    const dwell = {
      ...arrival,
      observationId: 'older',
      lat: 64.1122,
      lng: -21.9001,
      capturedAt: new Date(arrival.capturedAt.getTime() - 4 * 60_000),
    };
    const priorPlace = {
      ...arrival,
      observationId: 'prior-place',
      lat: 64.2,
      lng: -21.7,
      capturedAt: new Date(arrival.capturedAt.getTime() - 40 * 60_000),
    };
    expect(hasConfirmedArrival(arrival, [dwell, priorPlace], NOW)).toBe(true);
    expect(hasConfirmedArrival(arrival, [], NOW)).toBe(false);
    expect(hasConfirmedArrival({ ...arrival, accuracyM: 500 }, [dwell, priorPlace], NOW)).toBe(
      false,
    );
  });
});
