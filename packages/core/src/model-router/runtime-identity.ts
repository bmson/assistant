/**
 * Runtime provenance comes only from the process environment injected by the
 * serving platform/release, never from provider output or user-controlled
 * request fields. Missing or malformed values remain unknown.
 */
export function modelCallRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): {
  runtimeRevision: string | null;
  runtimeReleaseSha: string | null;
} {
  const revision = env.K_REVISION?.trim() ?? '';
  const releaseSha = env.ASSISTANT_RELEASE_SHA?.trim().toLowerCase() ?? '';
  return {
    // Cloud Run permits owner-specified revision suffixes, so do not assume
    // its generated numeric/hash form. K_REVISION is the platform-injected
    // source; this only rejects malformed values and does not attest identity.
    runtimeRevision: /^[a-z0-9][a-z0-9-]{0,62}$/.test(revision) ? revision : null,
    runtimeReleaseSha: /^[0-9a-f]{40}$/.test(releaseSha) ? releaseSha : null,
  };
}
