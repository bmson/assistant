import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type GoogleCalendarOAuthConfig,
  googleCalendarTokenRequest,
} from '@assistant/core/google-calendar-oauth';
import { decryptStoredCredential, encryptStoredCredential } from '@assistant/core/mcp-secrets';
import { type HouseholdHandoffRepository, handoffPlan } from '@assistant/persistence';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const attempt = z
  .object({
    agentId: z.string().uuid(),
    revision: z.string().uuid(),
    state: token,
    nonce: token,
    verifier: token,
    expires: z.number(),
    origin: z.string().trim().min(3).max(180).nullable(),
  })
  .strict();
const setup = handoffPlan.omit({ id: true, sharing: true });
const attemptCookie = 'd3_share_attempt';

export function createHouseholdHandoffSettings(deps: {
  repository: HouseholdHandoffRepository;
  config: GoogleCalendarOAuthConfig;
  sealKey: string;
  now?: () => Date;
  fetcher?: typeof fetch;
  verifyIdentity?: (
    token: string,
    audience: string,
  ) => Promise<{
    sub?: string;
    email?: string;
    email_verified?: boolean;
    nonce?: unknown;
  }>;
}) {
  const now = deps.now ?? (() => new Date());
  const path = new URL(deps.config.callbackUrl).pathname;
  const secret = (agentId: string, planId: string) =>
    createHmac('sha256', deps.sealKey)
      .update(JSON.stringify(['d3-invite-v1', agentId, planId]))
      .digest();
  const invite = async (owner: string, value: string) => {
    const record = await deps.repository.read(z.string().uuid().parse(owner));
    if (
      !token.safeParse(value).success ||
      !record?.plan ||
      !timingSafeEqual(Buffer.from(value, 'base64url'), secret(owner, record.plan.id))
    ) {
      throw new Error('This sharing link is unavailable.');
    }
    return { record, plan: record.plan };
  };
  return {
    async save(owner: string, expected: string | null, value: unknown) {
      const selected = setup.parse(value);
      if (
        Date.parse(selected.availabilityStart) >= Date.parse(selected.availabilityEnd) ||
        Date.parse(selected.availabilityEnd) <= +now() ||
        Date.parse(selected.availabilityEnd) - Date.parse(selected.availabilityStart) >
          12 * 3600_000 ||
        selected.ownerContactId === selected.recipientId ||
        selected.keeps.eventId === selected.currentlyCovers.eventId ||
        selected.keeps.subjectId === selected.currentlyCovers.subjectId
      )
        throw new Error('Choose two appointments and a current availability window.');
      const record = {
        agentId: owner,
        revision: randomUUID(),
        plan: { ...selected, id: randomUUID(), sharing: null },
      };
      if (!(await deps.repository.change(expected, record)))
        throw new Error('This plan changed. Reopen Settings.');
      return record;
    },
    async remove(owner: string, expected: string) {
      if (
        !(await deps.repository.change(expected, {
          agentId: owner,
          revision: randomUUID(),
          plan: null,
        }))
      )
        throw new Error('This plan changed. Reopen Settings.');
    },
    link(owner: string, planId: string) {
      const url = new URL(deps.config.callbackUrl);
      url.searchParams.set('handoffOwner', owner);
      url.searchParams.set('invite', secret(owner, planId).toString('base64url'));
      return url.href;
    },
    async inspect(owner: string, key: string) {
      const { plan } = await invite(owner, key);
      return {
        active: !!plan.sharing,
        startsAt: plan.availabilityStart,
        expiresAt: plan.availabilityEnd,
      };
    },
    async begin(owner: string, key: string, input: unknown) {
      const { record, plan } = await invite(owner, key);
      const origin = z.string().trim().min(3).max(180).nullable().parse(input);
      if (origin !== null && Date.parse(plan.availabilityEnd) <= +now())
        throw new Error('This plan expired.');
      const pending = attempt.parse({
        agentId: record.agentId,
        revision: record.revision,
        origin,
        state: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'),
        verifier: randomBytes(32).toString('base64url'),
        expires: +now() + 300_000,
      });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: deps.config.clientId,
        redirect_uri: deps.config.callbackUrl,
        response_type: 'code',
        scope: 'openid email',
        prompt: 'select_account',
        state: `d3.${pending.state}`,
        nonce: pending.nonce,
        code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return {
        url: url.href,
        cookie: `${attemptCookie}=${encryptStoredCredential(JSON.stringify(pending))}; Path=${path}; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
      };
    },
    async finish(input: { state: string; code: string; cookieHeader: string }) {
      const raw = input.cookieHeader
        .split(';')
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${attemptCookie}=`));
      if (!raw) throw new Error('Start sharing again in this browser.');
      const pending = attempt.parse(
        JSON.parse(decryptStoredCredential(raw.slice(attemptCookie.length + 1))),
      );
      if (input.state !== `d3.${pending.state}` || pending.expires <= +now())
        throw new Error('This request expired.');
      const record = await deps.repository.read(pending.agentId);
      const plan = record?.plan;
      if (!plan || record.revision !== pending.revision) throw new Error('This plan changed.');
      const result = await googleCalendarTokenRequest(
        new URLSearchParams({
          client_id: deps.config.clientId,
          client_secret: deps.config.clientSecret,
          redirect_uri: deps.config.callbackUrl,
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: pending.verifier,
        }),
        deps.fetcher,
      );
      if (typeof result.id_token !== 'string') throw new Error('Account identity was missing.');
      const identity = deps.verifyIdentity
        ? await deps.verifyIdentity(result.id_token, deps.config.clientId)
        : (
            await new OAuth2Client().verifyIdToken({
              idToken: result.id_token,
              audience: deps.config.clientId,
            })
          ).getPayload();
      if (
        !identity?.sub ||
        identity.email_verified !== true ||
        identity.email?.toLowerCase() !== plan.recipientEmail.toLowerCase() ||
        !('nonce' in identity) ||
        identity.nonce !== pending.nonce ||
        (plan.sharing && plan.sharing.googleSubject !== identity.sub)
      )
        throw new Error('Sign in as the adult invited to this plan.');
      if (pending.origin !== null && Date.parse(plan.availabilityEnd) <= +now())
        throw new Error('This plan expired.');
      if (
        !(await deps.repository.change(record.revision, {
          agentId: record.agentId,
          revision: randomUUID(),
          plan: {
            ...plan,
            sharing:
              pending.origin === null
                ? null
                : { googleSubject: identity.sub, tripOrigin: pending.origin },
          },
        }))
      )
        throw new Error('This plan changed.');
      return {
        active: pending.origin !== null,
        clearCookie: `${attemptCookie}=; Path=${path}; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
      };
    },
  };
}
