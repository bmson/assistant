import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function isIgnored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', relativePath]);
    return true;
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return false;
    throw error;
  }
}

describe('voice sample ignore policy', () => {
  it('ignores all accepted private sample formats while keeping public guidance tracked', () => {
    expect(isIgnored('seed-data/voice/email-sample.txt')).toBe(true);
    expect(isIgnored('seed-data/voice/email-sample.md')).toBe(true);
    expect(isIgnored('seed-data/voice/README.md')).toBe(false);
  });
});
