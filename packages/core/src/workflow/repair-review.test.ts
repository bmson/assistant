import { expect, it, vi } from 'vitest';
import type { ModelRouter } from '../model-router/router.js';
import { createRepairPatchReviewer } from './repair-review.js';

const candidate = {
  commitSha: 'a'.repeat(40),
  files: [{ filename: 'apps/example.ts', patch: '+source' }],
};
it('rejects a nominal approval with actionable findings', async () => {
  const object = vi.fn(async () => ({
    ok: true,
    modelId: 'reviewer',
    object: { approved: true, summary: 'Needs changes', findings: ['Missing null guard'] },
  }));
  const review = await createRepairPatchReviewer(
    { object } as unknown as ModelRouter,
    'task',
  )(candidate);
  expect(review).toMatchObject({ approved: false, modelId: 'reviewer' });
  expect(object).toHaveBeenCalledWith(
    'reason',
    expect.objectContaining({ taskId: 'task', prompt: JSON.stringify(candidate) }),
  );
});
it('does not approve an unavailable, malformed, or budget-blocked review', async () => {
  for (const result of [
    { ok: false },
    { ok: true, modelId: 'reviewer', object: { approved: true, findings: [] } },
  ]) {
    const object = vi.fn(async () => result);
    expect(
      await createRepairPatchReviewer({ object } as unknown as ModelRouter, 'task')(candidate),
    ).toBeNull();
  }
  const object = vi.fn(async () => {
    throw new Error('provider unavailable');
  });
  expect(
    await createRepairPatchReviewer({ object } as unknown as ModelRouter, 'task')(candidate),
  ).toBeNull();
});
