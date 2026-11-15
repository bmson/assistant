import { pathToFileURL } from 'node:url';

// One additive setting only. Reject normalization, credentials, queries, ports,
// fragments and separators that could expand a gcloud environment assignment.
export function googleCalendarReleaseCallback(value) {
  if (value === undefined || value === '') return undefined;
  try {
    if (typeof value !== 'string' || value.length > 512 || /[\s,]/.test(value)) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== '/api/oauth/google-calendar/callback' ||
      url.href !== value ||
      url.hostname.length > 253 ||
      !url.hostname.includes('.') ||
      !url.hostname
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      'GOOGLE_CALENDAR_OAUTH_CALLBACK_URL must be an exact HTTPS URL ending /api/oauth/google-calendar/callback',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Release-only input, outside cached Turbo tasks.
    googleCalendarReleaseCallback(process.env.GOOGLE_CALENDAR_OAUTH_CALLBACK_URL);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
