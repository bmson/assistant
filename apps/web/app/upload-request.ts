/** Enhanced multipart upload; the ordinary form route remains usable without JavaScript. */
export async function requestPanelUpload(
  action: string,
  data: FormData,
  fetcher: typeof fetch = fetch,
  origin: string = window.location.origin,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(action, {
      method: 'POST',
      body: data,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Error(
      'The connection was interrupted. Refresh this page to check the list before retrying.',
    );
  }
  if (!response.ok) {
    const message =
      response.status === 413
        ? 'This file is too large. Choose a file up to 25MB and try again.'
        : response.status === 401 || response.status === 403
          ? 'Sign in again before retrying this upload.'
          : response.status === 400 || response.status === 415
            ? 'The file or label was not accepted. Check them and try again.'
            : 'The upload could not be completed. Try again.';
    throw new Error(message);
  }
  const unconfirmed =
    'The upload result could not be confirmed. Refresh this page to check the list before retrying.';
  let payload: { redirectTo?: unknown };
  try {
    payload = await response.json();
  } catch {
    throw new Error(unconfirmed);
  }
  if (!payload || typeof payload.redirectTo !== 'string' || !payload.redirectTo.startsWith('/'))
    throw new Error(unconfirmed);
  const destination = new URL(payload.redirectTo, origin);
  const allowed =
    action === '/api/documents/upload' ? ['/documents'] : ['/import', '/profile/voice'];
  if (destination.origin !== origin || !allowed.includes(destination.pathname))
    throw new Error(unconfirmed);
  return destination.href;
}
