export interface ExternalEffectProgress {
  provider: 'google';
  kind: 'document' | 'sheet' | 'slides' | 'email' | 'draft';
  objectId: string;
  stage: 'created' | 'filled' | 'shared' | 'sent';
  payloadDigest: string;
}

export function advanceExternalEffect(
  previous: unknown,
  next: ExternalEffectProgress,
): ExternalEffectProgress {
  if (
    next.provider !== 'google' ||
    !['document', 'sheet', 'slides', 'email', 'draft'].includes(next.kind) ||
    !/^[A-Za-z0-9_-]{1,254}$/.test(next.objectId) ||
    !/^[a-f0-9]{64}$/.test(next.payloadDigest)
  )
    throw new Error('Invalid external effect receipt');
  const sequence =
    next.kind === 'email'
      ? ['sent']
      : next.kind === 'draft'
        ? ['created']
        : ['created', 'filled', 'shared'];
  const index = sequence.indexOf(next.stage);
  if (index < 0) throw new Error('Invalid external effect stage');
  if (previous == null) {
    if (index !== 0) throw new Error('External effect must start at its first stage');
    return next;
  }
  const before = previous as ExternalEffectProgress;
  if (
    before.provider !== next.provider ||
    before.kind !== next.kind ||
    before.objectId !== next.objectId ||
    before.payloadDigest !== next.payloadDigest
  )
    throw new Error('External effect identity or approved bytes changed');
  const previousIndex = sequence.indexOf(before.stage);
  if (previousIndex < 0 || index < previousIndex || index > previousIndex + 1)
    throw new Error('External effect stage is stale or skipped');
  return next;
}
