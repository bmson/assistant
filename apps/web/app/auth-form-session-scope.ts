const SESSION_SCOPE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidFormSessionScope(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SCOPE_RE.test(value);
}

/** Mint only on an actual provider sign-in; an old cookie without a claim stays unavailable. */
export function formSessionScopeForJwt(input: {
  accountPresent: boolean;
  existingScope: unknown;
  createScope: () => string;
}): string | null {
  if (input.accountPresent) {
    const minted = input.createScope();
    return isValidFormSessionScope(minted) ? minted : null;
  }
  return isValidFormSessionScope(input.existingScope) ? input.existingScope : null;
}
