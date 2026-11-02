/** Uses this package's already declared jose dependency. No remote key loader or token acquisition. */
import { createLocalJWKSet, jwtVerify } from 'jose';
export async function verifyNativeQualificationJwt(
  token: string,
  jwks: unknown,
  audience: string,
  now: number,
): Promise<Record<string, unknown>> {
  try {
    if (
      !Number.isFinite(now) ||
      typeof token !== 'string' ||
      token.length > 16384 ||
      !jwks ||
      typeof jwks !== 'object' ||
      !Array.isArray((jwks as { keys?: unknown }).keys)
    )
      throw new Error();
    const keys = (jwks as { keys: Record<string, unknown>[] }).keys;
    if (keys.length < 1 || keys.length > 8 || new Set(keys.map((k) => k.kid)).size !== keys.length)
      throw new Error();
    for (const k of keys)
      if (
        k.kty !== 'RSA' ||
        k.alg !== 'RS256' ||
        k.use !== 'sig' ||
        typeof k.kid !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(k.kid) ||
        typeof k.n !== 'string' ||
        !/^[A-Za-z0-9_-]{128,8192}$/.test(k.n) ||
        typeof k.e !== 'string' ||
        !/^[A-Za-z0-9_-]{1,16}$/.test(k.e) ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi'].some((f) => Object.hasOwn(k, f))
      )
        throw new Error();
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
      {
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'nbf'],
        issuer: 'https://token.actions.githubusercontent.com',
        audience,
        currentDate: new Date(now),
        clockTolerance: 0,
      },
    );
    const { iat, nbf, exp } = payload;
    if (
      typeof iat !== 'number' ||
      !Number.isSafeInteger(iat) ||
      iat < 0 ||
      typeof nbf !== 'number' ||
      !Number.isSafeInteger(nbf) ||
      nbf < 0 ||
      typeof exp !== 'number' ||
      !Number.isSafeInteger(exp) ||
      iat * 1000 > now ||
      nbf * 1000 > now ||
      exp * 1000 <= now ||
      exp <= iat ||
      exp - iat > 600
    )
      throw new Error();
    return payload;
  } catch {
    throw new Error('Qualification identity held');
  }
}
