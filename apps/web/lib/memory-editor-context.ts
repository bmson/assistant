/** Only an internal Memory connections/map URL can become a dossier return destination. */
export function memoryMapReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/profile/knowledge?'))
    return null;
  try {
    const url = new URL(value, 'https://internal.invalid');
    if (
      url.origin !== 'https://internal.invalid' ||
      url.pathname !== '/profile/knowledge' ||
      !['map', 'connections'].includes(url.searchParams.get('view') ?? '')
    )
      return null;
    return `${url.pathname}${url.search}${url.hash === '#knowledge-item' ? url.hash : ''}`;
  } catch {
    return null;
  }
}
export function memoryPersonEditorHref(
  contactId: string | null | undefined,
  contextHref: string,
): string | null {
  if (
    !contactId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contactId)
  )
    return null;
  const returnTo = memoryMapReturnTo(contextHref);
  return `/people/${contactId}${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Link to one validated graph claim while keeping the safe generic person fallback. */
export function memoryPersonConnectionHref(
  contactId: string | null | undefined,
  relationId: string | null | undefined,
  contextHref: string,
): string | null {
  const personHref = memoryPersonEditorHref(contactId, contextHref);
  if (!personHref || !relationId || !UUID.test(relationId)) return personHref;
  const id = relationId.toLowerCase();
  return `${personHref}${personHref.includes('?') ? '&' : '?'}connectionId=${id}#person-connection-${id}`;
}
