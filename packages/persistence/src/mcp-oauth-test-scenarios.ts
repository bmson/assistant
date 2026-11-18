import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  McpOAuthConnectionKey,
  McpOAuthPendingFlow,
  McpOAuthRepository,
  McpOAuthTokens,
} from './mcp-oauth.js';

export const mcpTestEndpoint = 'https://mcp.example.invalid/mcp';
const endpoint = mcpTestEndpoint;
const now = new Date('2026-11-18T12:00:00Z');
const ciphertext = 'v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.c2VhbGVk';
export const mcpTestManualBearer = 'existing-manual-bearer-ciphertext';
const tokens: McpOAuthTokens = {
  accessTokenEncrypted: ciphertext,
  refreshTokenEncrypted: ciphertext,
  accessTokenExpiresAt: '2026-11-18T12:10:00Z',
  scopes: ['read'],
};
const connected = {
  outcome: 'connected' as const,
  tokens,
  discovery: { serverName: 'Bound server', tools: [{ name: 'read' }] },
};

function pending(): McpOAuthPendingFlow {
  return {
    id: randomUUID(),
    client: 'ios',
    binding: {
      endpoint,
      resource: endpoint,
      issuer: 'https://issuer.example.invalid',
      authorizationEndpoint: 'https://issuer.example.invalid/authorize',
      tokenEndpoint: 'https://issuer.example.invalid/token',
      redirectUri: 'https://app.example.invalid/callback',
      clientId: 'public-client',
      tokenEndpointAuthMethod: 'none',
      authorizationResponseIssuerRequired: true,
    },
    stateHash: 'a'.repeat(64),
    expiresAt: '2026-11-18T12:05:00Z',
    clientSecretEncrypted: null,
    phase: 'pending',
    verifierEncrypted: ciphertext,
  };
}

interface Harness {
  key: McpOAuthConnectionKey;
  repo: McpOAuthRepository;
  reopened: McpOAuthRepository;
  setEnabled(enabled: boolean): Promise<void>;
  readManualBearer(): Promise<unknown>;
}

export function mcpOAuthStorageScenarios(harness: () => Harness) {
  it('claims a callback once and persists a terminal result without a grant', async () => {
    const { key, repo, reopened } = harness();
    const flow = pending();
    await expect(
      repo.begin(key, { ...flow, verifierEncrypted: 'raw-secret' }, now),
    ).rejects.toThrow('Invalid stored MCP OAuth state');
    expect(await repo.begin(key, flow, now)).toBe(true);
    expect(await reopened.get({ ...key, ownerId: randomUUID() }, endpoint)).toBeNull();
    expect(await reopened.get(key, 'https://other.example.invalid/mcp')).toBeNull();
    expect(await reopened.consume(key, endpoint, flow.id, 'b'.repeat(64), now)).toBeNull();
    const claims = await Promise.all([
      repo.consume(key, endpoint, flow.id, flow.stateHash, now),
      reopened.consume(key, endpoint, flow.id, flow.stateHash, now),
    ]);
    expect(claims.filter(Boolean)).toEqual([flow]);
    expect((await repo.get(key, endpoint))?.flow).not.toHaveProperty('verifierEncrypted');
    expect(await reopened.finish(key, endpoint, flow.id, { outcome: 'denied' }, now)).toBe(true);
    expect(await repo.poll(key, endpoint, flow.id, 'ios', now)).toBe('denied');
    expect(await repo.poll(key, endpoint, flow.id, 'web', now)).toBeNull();
    expect((await repo.get(key, endpoint))?.grant).toBeNull();
    expect(await repo.finish(key, endpoint, flow.id, connected, now)).toBe(false);
    const expiring = pending();
    expect(await repo.begin(key, expiring, now)).toBe(true);
    expect(await repo.poll(key, endpoint, expiring.id, 'ios', new Date(expiring.expiresAt))).toBe(
      'expired',
    );
    expect(await reopened.consume(key, endpoint, expiring.id, expiring.stateHash, now)).toBeNull();
  });

  it('preserves the manual credential and working grant across failed reconnect and pause', async () => {
    const { key, repo, reopened, setEnabled, readManualBearer } = harness();
    const flow = pending();
    expect(await repo.begin(key, flow, now)).toBe(true);
    expect(await repo.consume(key, endpoint, flow.id, flow.stateHash, now)).toEqual(flow);
    expect(await repo.finish(key, endpoint, flow.id, connected, now)).toBe(true);
    const denied = pending();
    await repo.begin(key, denied, now);
    await repo.consume(key, endpoint, denied.id, denied.stateHash, now);
    await repo.finish(key, endpoint, denied.id, { outcome: 'denied' }, now);
    const reconnect = pending();
    await repo.begin(key, reconnect, now);
    await repo.consume(key, endpoint, reconnect.id, reconnect.stateHash, now);
    await setEnabled(false);
    expect(await reopened.get(key, endpoint)).toBeNull();
    expect(await reopened.poll(key, endpoint, reconnect.id, 'ios', now)).toBe('superseded');
    await setEnabled(true);
    expect(await repo.finish(key, endpoint, reconnect.id, connected, now)).toBe(false);
    expect((await reopened.get(key, endpoint))?.grant).toMatchObject({
      generation: flow.id,
      discovery: connected.discovery,
      tokens,
    });
    await setEnabled(false);
    expect(await repo.disconnect(key, endpoint)).toBe(true);
    await setEnabled(true);
    expect((await reopened.get(key, endpoint))?.grant).toBeNull();
    expect(await readManualBearer()).toBe(mcpTestManualBearer);
  });

  it('serializes refresh and rejects stale completion after pause and disconnect', async () => {
    const { key, repo, reopened, setEnabled } = harness();
    const flow = pending();
    await repo.begin(key, flow, now);
    await repo.consume(key, endpoint, flow.id, flow.stateHash, now);
    await repo.finish(key, endpoint, flow.id, connected, now);
    const claim = () => repo.acquireRefresh(key, endpoint, flow.id, 0, randomUUID(), now);
    expect((await Promise.all([claim(), claim()])).map((result) => result?.kind).sort()).toEqual([
      'claimed',
      'wait',
    ]);
    const initial = (await reopened.get(key, endpoint))?.grant;
    if (!initial?.refresh) throw new Error('Expected persisted refresh claim');
    const refresh = initial.refresh;
    expect(
      await reopened.completeRefresh(
        key,
        endpoint,
        flow.id,
        0,
        refresh.id,
        { ...tokens, refreshTokenEncrypted: null },
        now,
      ),
    ).toBe(true);
    const current = (await reopened.get(key, endpoint))?.grant;
    expect(current).toMatchObject({ revision: 1, tokens, refresh: null });
    const leaseId = randomUUID();
    expect((await repo.acquireRefresh(key, endpoint, flow.id, 1, leaseId, now))?.kind).toBe(
      'claimed',
    );
    const expired = new Date(now.getTime() + 60_000);
    expect(await repo.acquireRefresh(key, endpoint, flow.id, 1, randomUUID(), expired)).toEqual({
      kind: 'reconnect_required',
    });
    expect(await repo.completeRefresh(key, endpoint, flow.id, 1, leaseId, tokens, expired)).toBe(
      false,
    );
    await setEnabled(false);
    await setEnabled(true);
    expect(await repo.completeRefresh(key, endpoint, flow.id, 1, leaseId, tokens, expired)).toBe(
      false,
    );
    expect((await reopened.get(key, endpoint))?.grant).toMatchObject({
      reconnectRequired: true,
      refresh: null,
    });
    const late = pending();
    await repo.begin(key, late, expired);
    await repo.consume(key, endpoint, late.id, late.stateHash, expired);
    await reopened.disconnect(key, endpoint);
    expect(await repo.finish(key, endpoint, late.id, connected, expired)).toBe(false);
    expect((await reopened.get(key, endpoint))?.grant).toBeNull();
  });
}
