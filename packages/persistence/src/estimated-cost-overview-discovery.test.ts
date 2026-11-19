import { describe, expect, it } from 'vitest';
import {
  estimatedCostOperationLocator,
  matchesTaskDiscovery,
  type TaskDiscoveryRow,
} from './task-discovery.js';

describe('spending request activity discovery', () => {
  it('locates only a parked pending checkpoint and exposes no other task state', () => {
    const state = {
      secret: 'not returned',
      estimatedCostApproval: {
        status: 'pending',
        operationId: 'operation-123',
        bindingDigest: 'not returned',
      },
    };
    expect(estimatedCostOperationLocator('waiting_estimated_cost', state)).toBe('operation-123');
    expect(estimatedCostOperationLocator('running', state)).toBeNull();
    expect(
      estimatedCostOperationLocator('waiting_estimated_cost', {
        estimatedCostApproval: { status: 'approved', operationId: 'operation-123' },
      }),
    ).toBeNull();
    expect(
      estimatedCostOperationLocator('waiting_estimated_cost', {
        estimatedCostApproval: { status: 'pending', operationId: '../bad' },
      }),
    ).toBeNull();
    expect(estimatedCostOperationLocator('waiting_estimated_cost', null)).toBeNull();
  });
  it('includes waiting spending requests in Needs you', () => {
    const row = {
      id: 't',
      title: '',
      progress: '',
      conversationId: null,
      externalEventId: null,
      status: 'waiting_estimated_cost',
      archivedAt: null,
    } as unknown as TaskDiscoveryRow;
    expect(matchesTaskDiscovery(row, { archived: false, filter: 'needs-you' })).toBe(true);
    expect(matchesTaskDiscovery(row, { archived: false, filter: 'working' })).toBe(false);
  });
});
