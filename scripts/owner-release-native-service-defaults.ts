/** Native Service comparisons only; raw observations and their receipt hashes stay untouched. */
type Obj = Record<string, unknown>;
type Digest = (value: unknown) => string;

/**
 * Cloud Run v2 Service.sshEnabled is a boolean. ProtoJSON may omit its false default.
 * https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services
 * https://protobuf.dev/programming-guides/json/#presence-and-default-values
 * Deliberately do not apply other protobuf defaults, null coercion, or nested normalization.
 */
export function nativeServiceDefaults(raw: unknown): Obj {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid native service defaults');
  const service = raw as Obj;
  if (Object.hasOwn(service, 'sshEnabled') && typeof service.sshEnabled !== 'boolean')
    throw new Error('Invalid native service defaults');
  const normalized = { ...service };
  if (normalized.sshEnabled === false) delete normalized.sshEnabled;
  return normalized;
}

/** Accept existing raw receipt hashes in either of the two documented false representations. */
export function matchesNativeServiceDigest(
  raw: unknown,
  expected: string,
  digest: Digest,
): boolean {
  const normalized = nativeServiceDefaults(raw);
  return (
    digest(normalized) === expected ||
    (!Object.hasOwn(normalized, 'sshEnabled') &&
      digest({ ...normalized, sshEnabled: false }) === expected)
  );
}
