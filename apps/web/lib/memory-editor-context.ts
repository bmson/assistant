/** Only an internal Memory map URL can become a dossier return destination. */
export function memoryMapReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/profile/knowledge?'))
    return null;
  try {
    const url = new URL(value, 'https://internal.invalid');
    if (
      url.origin !== 'https://internal.invalid' ||
      url.pathname !== '/profile/knowledge' ||
      url.searchParams.get('view') !== 'map'
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
