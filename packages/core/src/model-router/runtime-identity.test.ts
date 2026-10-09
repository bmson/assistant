import { describe, expect, it } from 'vitest';
import { modelCallRuntimeIdentity } from './runtime-identity.js';

describe('model-call runtime identity', () => {
  it('uses only well-formed serving environment values', () => {
    expect(
      modelCallRuntimeIdentity({
        K_REVISION: 'assistant-agent-00042-abc',
        ASSISTANT_RELEASE_SHA: 'a'.repeat(40),
      } as NodeJS.ProcessEnv),
    ).toEqual({
      runtimeRevision: 'assistant-agent-00042-abc',
      runtimeReleaseSha: 'a'.repeat(40),
    });
    expect(
      modelCallRuntimeIdentity({
        K_REVISION: 'assistant-agent-owner-approved-canary',
        ASSISTANT_RELEASE_SHA: 'b'.repeat(40),
      } as NodeJS.ProcessEnv),
    ).toEqual({
      runtimeRevision: 'assistant-agent-owner-approved-canary',
      runtimeReleaseSha: 'b'.repeat(40),
    });
  });

  it('fails closed when the runtime release identity is absent or malformed', () => {
    expect(modelCallRuntimeIdentity({} as NodeJS.ProcessEnv)).toEqual({
      runtimeRevision: null,
      runtimeReleaseSha: null,
    });
    expect(
      modelCallRuntimeIdentity({
        K_REVISION: 'claimed/by-prompt',
        ASSISTANT_RELEASE_SHA: 'not-a-release',
      } as NodeJS.ProcessEnv),
    ).toEqual({ runtimeRevision: null, runtimeReleaseSha: null });
  });
});
