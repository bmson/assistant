import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchOrdinaryReleasePacket,
  loadQualifiedWorkerRecovery,
} from './owner-api3-recovery-intake.js';
import { ORDINARY_IDENTITY } from './owner-api3-recovery-pins.js';

const token = 'synthetic-evidence-reader';
const body = 'synthetic generation';
const pin = {
  object: 'synthetic/packet.json',
  generation: '1234',
  sha256: createHash('sha256').update(body).digest('hex'),
};

describe('ordinary release evidence intake', () => {
  it('reads exact generation bytes over a fixed origin and checks their hash', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: { 'x-goog-generation': pin.generation, 'content-length': String(body.length) },
      }),
    );
    const bytes = await fetchOrdinaryReleasePacket(pin, 64, token, request);
    expect(bytes.toString()).toBe(body);
    const [value, init] = request.mock.calls[0] ?? [];
    const url = new URL(String(value));
    expect(url.origin).toBe('https://storage.googleapis.com');
    expect(url.pathname).toBe(
      '/download/storage/v1/b/bmson-assistant-reviewed-release-evidence/o/synthetic%2Fpacket.json',
    );
    expect([...url.searchParams]).toEqual([
      ['alt', 'media'],
      ['generation', '1234'],
      ['ifGenerationMatch', '1234'],
    ]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it.each([
    ['wrong bytes', () => new Response('wrong')],
    ['stream exceeds bound', () => new Response('x'.repeat(65))],
    ['partial', () => new Response(body, { status: 206 })],
    ['wrong generation', () => new Response(body, { headers: { 'x-goog-generation': '1235' } })],
    ['transformed', () => new Response(body, { headers: { 'content-encoding': 'gzip' } })],
    ['oversized header', () => new Response(body, { headers: { 'content-length': '70' } })],
    ['truncated', () => new Response(body, { headers: { 'content-length': '64' } })],
    ['missing', () => new Response(null, { status: 404 })],
  ] as const)('holds on %s', async (_name, reply) => {
    await expect(fetchOrdinaryReleasePacket(pin, 64, token, async () => reply())).rejects.toThrow();
  });
  it('requires both reviewed pins and a private local qualification to use recovery workers', () => {
    expect(loadQualifiedWorkerRecovery({})).toBeUndefined();
    expect(() =>
      loadQualifiedWorkerRecovery({ OWNER_API3_RECOVERY_SHA256: ORDINARY_IDENTITY.sha256 }),
    ).toThrow();
    expect(() =>
      loadQualifiedWorkerRecovery({
        RUNNER_TEMP: '/missing-ordinary-capsule',
        OWNER_API3_RECOVERY_GENERATION: ORDINARY_IDENTITY.generation,
        OWNER_API3_RECOVERY_SHA256: ORDINARY_IDENTITY.sha256,
      }),
    ).toThrow();
  });
});
