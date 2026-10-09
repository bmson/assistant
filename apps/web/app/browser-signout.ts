/** Request the current-browser logout endpoint and accept only its same-origin redirect. */
export async function requestBrowserSignOut(
  fetcher: typeof fetch = fetch,
  origin: string = window.location.origin,
): Promise<string> {
  const response = await fetcher('/api/owner/browser-signout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'text/html' },
  });
  if (!response.ok || !response.redirected) throw new Error('Sign out was not confirmed.');
  const destination = new URL(response.url);
  if (destination.origin !== origin) throw new Error('Sign-out destination was not local.');
  if (
    destination.search ||
    destination.hash ||
    !['/signin', '/api/auth/signin'].includes(destination.pathname)
  )
    throw new Error('Sign-out destination was not the configured sign-in page.');
  return destination.href;
}
