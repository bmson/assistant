import { expect, it } from 'vitest';
import { TaskStateSchema } from './events.js';

it('preserves the approved original grant through executor checkpoints', () => {
  const marker = {
    operationId: 'operation',
    quoteId: 'quote',
    bindingDigest: 'binding',
    status: 'approved',
    grantId: 'grant',
  } as const;
  const first = TaskStateSchema.parse({ estimatedCostApproval: marker });
  const resumed = TaskStateSchema.parse({ ...first, step: 2 });
  expect(resumed.estimatedCostApproval).toEqual(marker);
});
