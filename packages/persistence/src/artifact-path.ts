/** Validate a purpose-scoped artifact before namespace checks or any read. */
export function allowedArtifactPath(rel: string, prefixes: readonly string[]): string {
  const candidate = rel.replace(/^\/+/, '');
  if (
    !candidate ||
    /[\\%]/.test(candidate) ||
    [...candidate].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    candidate.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
    !prefixes.some((prefix) => candidate.startsWith(prefix))
  ) {
    throw new Error('artifact path not allowed: outside the allowed namespace');
  }
  return candidate;
}

/** Keep old receipts stable when another execution emits the same filename. */
export function immutableArtifactPath(
  prefix: string,
  scopeHash: string,
  contentHash: string,
  name: string,
): string {
  if (
    !prefix.endsWith('/') ||
    !/^[a-f0-9]{64}$/.test(scopeHash) ||
    !/^[a-f0-9]{64}$/.test(contentHash)
  )
    throw new Error('Invalid immutable artifact identity');
  const filename =
    name
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 80) || 'artifact';
  const candidate = `${prefix}${scopeHash}/${contentHash}/${filename}`;
  if (candidate.length > 300)
    throw new Error('Immutable artifact path exceeds the supported bound');
  return allowedArtifactPath(candidate, [prefix]);
}
