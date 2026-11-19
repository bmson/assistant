import type { Config } from '@assistant/config';
import { describe, expect, it, vi } from 'vitest';
import { createCloudRunAgentReadinessSource } from './agent-readiness-source.js';

const config = {
  AGENT_URL: 'https://assistant-agent-abc.us-west1.a.run.app',
  FIRESTORE_AGENT_ID: 'owner-agent',
} satisfies Pick<Config, 'AGENT_URL' | 'FIRESTORE_AGENT_ID'>;

describe('private Cloud Run agent readiness source', () => {
  it('mints an audience-bound metadata ID token and sends it only to /ready', async () => {
    const payload = {
      ready: true,
      database: 'firestore',
      modules: [{ module: 'google', enabled: true, ready: true, detail: 'ready' }],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.hostname === 'metadata.google.internal'
        ? new Response('header.payload.signature')
        : Response.json(payload);
    }) as unknown as typeof fetch;

    const source = createCloudRunAgentReadinessSource(config, fetcher);
    expect(await source.read('owner-agent')).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [metadataUrl, metadataOptions] = vi.mocked(fetcher).mock.calls[0] ?? [];
    expect(new URL(String(metadataUrl)).searchParams.get('audience')).toBe(config.AGENT_URL);
    expect(metadataOptions).toMatchObject({
      method: 'GET',
      headers: { 'Metadata-Flavor': 'Google' },
      cache: 'no-store',
      redirect: 'error',
    });
    const [readinessUrl, readinessOptions] = vi.mocked(fetcher).mock.calls[1] ?? [];
    expect(String(readinessUrl)).toBe(`${config.AGENT_URL}/ready`);
    expect(readinessOptions).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer header.payload.signature' },
      cache: 'no-store',
      redirect: 'error',
    });
  });

  it('keeps the canonical token audience for the exact paused agent tag', async () => {
    const agent = { ...config, AGENT_URL: 'https://assistant-agent-abc-uw.a.run.app' };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      return new URL(String(input)).hostname === 'metadata.google.internal'
        ? new Response('header.payload.signature')
        : Response.json({ ready: true });
    }) as unknown as typeof fetch;
    await expect(
      createCloudRunAgentReadinessSource(agent, fetcher, 'candidate-123-1').read('owner-agent'),
    ).resolves.toEqual({ ready: true });
    expect(
      new URL(String(vi.mocked(fetcher).mock.calls[0]?.[0])).searchParams.get('audience'),
    ).toBe(agent.AGENT_URL);
    expect(String(vi.mocked(fetcher).mock.calls[1]?.[0])).toBe(
      'https://candidate-123-1---assistant-agent-abc-uw.a.run.app/ready',
    );
    vi.mocked(fetcher).mockClear();
    await expect(
      createCloudRunAgentReadinessSource(agent, fetcher, 'https://foreign.example').read(
        'owner-agent',
      ),
    ).rejects.toThrow('target is unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a foreign owner or non-Cloud Run destination before fetching a token', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      createCloudRunAgentReadinessSource(config, fetcher).read('foreign'),
    ).rejects.toThrow('owner does not match');
    for (const agentUrl of [
      'http://assistant-agent-abc.us-west1.a.run.app',
      'https://example.com',
      'https://assistant-agent-abc.us-west1.a.run.app/other',
      'https://assistant-agent-abc.us-west1.a.run.app?to=other',
    ]) {
      await expect(
        createCloudRunAgentReadinessSource({ ...config, AGENT_URL: agentUrl }, fetcher).read(
          'owner-agent',
        ),
      ).rejects.toThrow('AGENT_URL must be');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed on metadata, token, or agent authorization errors', async () => {
    const deniedMetadata = vi.fn(
      async () => new Response('denied', { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(
      createCloudRunAgentReadinessSource(config, deniedMetadata).read('owner-agent'),
    ).rejects.toThrow('identity token unavailable');
    expect(deniedMetadata).toHaveBeenCalledTimes(1);

    const malformedToken = vi.fn(
      async () => new Response('not-a-token'),
    ) as unknown as typeof fetch;
    await expect(
      createCloudRunAgentReadinessSource(config, malformedToken).read('owner-agent'),
    ).rejects.toThrow('identity token is malformed');
    expect(malformedToken).toHaveBeenCalledTimes(1);

    const deniedAgent = vi
      .fn()
      .mockResolvedValueOnce(new Response('header.payload.signature'))
      .mockResolvedValueOnce(new Response('denied', { status: 403 })) as unknown as typeof fetch;
    await expect(
      createCloudRunAgentReadinessSource(config, deniedAgent).read('owner-agent'),
    ).rejects.toThrow('Agent readiness returned 403');
    expect(deniedAgent).toHaveBeenCalledTimes(2);
  });
});
