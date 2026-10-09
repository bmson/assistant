import { describe, expect, it } from 'vitest';
import { readMobileWorkspaceSection } from './mobile-workspace-sections.js';

describe('mobile workspace section reads', () => {
  it('returns typed failure for a slow independent section without exposing an empty success', async () => {
    const result = await readMobileWorkspaceSection(
      () => new Promise<string[]>((resolve) => setTimeout(() => resolve(['late']), 40)),
      5,
    );

    expect(result).toEqual({
      value: null,
      availability: {
        status: 'unavailable',
        version: 1,
        message: 'This section could not be loaded. Refresh to try again.',
      },
    });
  });

  it('keeps successful sections explicitly versioned', async () => {
    await expect(readMobileWorkspaceSection(async () => ['one'])).resolves.toEqual({
      value: ['one'],
      availability: { status: 'available', version: 1 },
    });
  });
});
