/** Credential removal is independent of capture mode; it is not anonymization. */
const SECRET_FIELD =
  /^(authorization|proxyAuthorization|cookie|setCookie|password|passwd|secret|clientSecret|privateKey|apiKey|accessToken|refreshToken|bearerToken|callbackToken|credentialRefs|leaseToken|token|.*Encrypted)$/i;
const SECRET_QUERY =
  /^(?:.*token|.*secret|.*password|.*signature|.*credential|api[-_]?key|key|code|sig|authorization|cookie|x[-_]amz[-_].*|x[-_]goog[-_].*)$/i;
export function isAuditSecretField(key: string): boolean {
  return SECRET_FIELD.test(key.replace(/[_-]/g, ''));
}
export function sanitizeAuditUrls(text: string, minimize = false, depth = 0): string {
  if (depth > 8) return '[nested URL limit]';
  return text.replace(/\bhttps?:\/\/[^\s<>"'\\]+/gi, (candidate) => {
    const punctuation = candidate.match(/[),.;]+$/)?.[0] ?? '';
    const raw = punctuation ? candidate.slice(0, -punctuation.length) : candidate;
    try {
      const url = new URL(raw);
      if (minimize) return `${url.origin}${url.pathname === '/' ? '' : '/[path]'}${punctuation}`;
      const hadCredentials = Boolean(url.username || url.password);
      url.username = '';
      url.password = '';
      let changed = hadCredentials;
      for (const key of new Set(url.searchParams.keys())) {
        if (SECRET_QUERY.test(key)) {
          url.searchParams.set(key, '[redacted]');
          changed = true;
        } else {
          const values = url.searchParams.getAll(key);
          const cleaned = values.map((value) =>
            /https?:\/\//i.test(value) ? sanitizeAuditUrls(value, false, depth + 1) : value,
          );
          if (values.some((value, index) => value !== cleaned[index])) {
            url.searchParams.delete(key);
            for (const value of cleaned) url.searchParams.append(key, value);
            changed = true;
          }
        }
      }
      if (url.hash && /(?:token|secret|password|key|code|sig)[^=]*=/i.test(url.hash)) {
        url.hash = '[redacted]';
        changed = true;
      }
      return (changed ? url.toString() : raw) + punctuation;
    } catch {
      return '[unreadable URL]';
    }
  });
}
export function scrubAuditCredentials(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[depth limit]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (/^[[{]/.test(value.trim())) {
      try {
        return JSON.stringify(scrubAuditCredentials(JSON.parse(value), depth + 1), null, 2);
      } catch {
        /* Clipped/free text receives credential masking below. */
      }
    }
    return sanitizeAuditUrls(value)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|secret|authorization|callback[_-]?token)["']?\s*[=:]\s*["']?)[^\s"'&,}]+/gi,
        '$1[redacted]',
      );
  }
  if (Array.isArray(value)) return value.map((item) => scrubAuditCredentials(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isAuditSecretField(key) ? '[redacted]' : scrubAuditCredentials(item, depth + 1),
      ]),
    );
  return value;
}
