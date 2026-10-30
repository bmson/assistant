const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function memoryNoteReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/profile/knowledge?'))
    return null;
  try {
    const url = new URL(value, 'https://internal.invalid');
    if (
      url.origin !== 'https://internal.invalid' ||
      url.pathname !== '/profile/knowledge' ||
      !['library', 'map', 'connections'].includes(url.searchParams.get('view') ?? '')
    )
      return null;
    return `${url.pathname}${url.search}${url.hash === '#knowledge-item' ? url.hash : ''}`;
  } catch {
    return null;
  }
}
export function memoryNoteHref(memoryId: string, contextHref: string): string | null {
  if (!UUID.test(memoryId)) return null;
  const back = memoryNoteReturnTo(contextHref);
  return `/profile/knowledge/notes/${memoryId}${back ? `?returnTo=${encodeURIComponent(back)}` : ''}`;
}
