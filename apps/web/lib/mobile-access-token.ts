import { loadConfig } from '@assistant/config';

const CACHE_MS = 30_000;
let cached: { project: string; token: string; at: number } | undefined;
let pending: Promise<string> | undefined;
let lastAttempt: { project: string; at: number; failed: boolean } | undefined;

export function clearMobileAccessTokenCache() {
  cached = undefined;
  pending = undefined;
  lastAttempt = undefined;
}

export function hasMobileTokenRotationCapability(config = loadConfig()): boolean {
  return Boolean(config.MOBILE_API_TOKEN_ROTATION_ENABLED && config.MOBILE_API_TOKEN_SECRET_NAME);
}

/** Cloud Run secret environment values are snapshots taken at instance startup. */
export async function getMobileAccessToken(
  forceRefresh: boolean | 'mismatch' = false,
): Promise<string> {
  const config = loadConfig();
  // Passkey installations issue independent device keys and can provision an
  // optional legacy token in an installation-specific secret. That token is
  // not rotated by this console, so preserve its configured value.
  if (
    config.OWNER_AUTH_MODE === 'passkey' ||
    !process.env.K_SERVICE ||
    !config.GCP_PROJECT ||
    !config.MOBILE_API_TOKEN_SECRET_NAME
  )
    return config.MOBILE_API_TOKEN;
  const project = config.GCP_PROJECT;
  if (!forceRefresh && cached?.project === project && Date.now() - cached.at < CACHE_MS)
    return cached.token;
  if (pending) return pending;
  // Anonymous mismatches cannot trigger one Secret Manager read per request.
  // Cache expiry and explicit owner rotation still refresh normally. A rotated
  // legacy token can take at most CACHE_MS to be recognized by a warm instance.
  const coolingDown = lastAttempt?.project === project && Date.now() - lastAttempt.at < CACHE_MS;
  if (forceRefresh === 'mismatch' && coolingDown && cached?.project === project)
    return cached.token;
  if (forceRefresh !== true && coolingDown && lastAttempt?.failed)
    throw new Error('Mobile token verification temporarily unavailable');
  lastAttempt = { project, at: Date.now(), failed: false };
  pending = (async () => {
    const credentials = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
    );
    if (!credentials.ok) throw new Error('Mobile token credentials unavailable');
    const { access_token } = (await credentials.json()) as { access_token: string };
    const result = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets/${encodeURIComponent(config.MOBILE_API_TOKEN_SECRET_NAME)}/versions/latest:access`,
      { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(5_000) },
    );
    if (result.status === 404) {
      cached = { project, token: '', at: Date.now() };
      return '';
    }
    if (!result.ok) throw new Error('Mobile token unavailable');
    const body = (await result.json()) as { payload?: { data?: string } };
    if (!body.payload?.data) throw new Error('Mobile token payload unavailable');
    const token = Buffer.from(body.payload.data, 'base64').toString('utf8');
    if (!token) throw new Error('Mobile token is empty');
    cached = { project, token, at: Date.now() };
    return token;
  })();
  try {
    return await pending;
  } catch (error) {
    if (lastAttempt?.project === project) lastAttempt.failed = true;
    throw error;
  } finally {
    pending = undefined;
  }
}
