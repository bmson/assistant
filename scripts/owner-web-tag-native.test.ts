import { describe, expect, it, vi } from 'vitest';
import { nativeRetirementClient, operationName } from './owner-web-tag-native.js';
import { type RetirementPlan, WEB_SERVICE } from './owner-web-tag-retirement.js';

const name = 'projects/bmson-assistant/locations/us-west1/operations/owned-one';
const patch: NonNullable<RetirementPlan['patch']> = {
  name: WEB_SERVICE,
  etag: 'fresh-etag',
  traffic: [
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: 'assistant-web-current',
      tag: 'resume-123-1',
      percent: 100,
    },
  ],
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe('fixed native traffic transport', () => {
  it('sends traffic-only etag CAS once with no redirects and no provider error disclosure', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ secret: 'private-provider-body' }, 409));
    const client = nativeRetirementClient('private-token', request);
    await expect(client.patchTraffic(patch)).rejects.toThrow('Native PATCH rejected; do not retry');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0] ?? [];
    expect(url).toBe(`https://run.googleapis.com/v2/${WEB_SERVICE}?updateMask=traffic`);
    expect(options).toMatchObject({
      method: 'PATCH',
      redirect: 'error',
      body: JSON.stringify(patch),
    });
  });
  it('does not retry or leak an uncertain network exception', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token private-env'));
    await expect(
      nativeRetirementClient('private-token', request).patchTraffic(patch),
    ).rejects.toThrow('Native PATCH outcome uncertain; do not retry');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...patch, name: 'projects/operator/services/elsewhere' },
    { ...patch, etag: '' },
    { ...patch, template: {} },
    { ...patch, traffic: [{ ...patch.traffic[0], percent: 0 }] },
    { ...patch, traffic: [{ ...patch.traffic[0], revision: '../other' }] },
    { ...patch, traffic: [{ ...patch.traffic[0], tag: 'operator' }] },
  ])('rejects malformed patch before request %j', async (bad) => {
    const request = vi.fn<typeof fetch>();
    expect(() =>
      nativeRetirementClient('token', request).patchTraffic(bad as typeof patch),
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    'https://operator/operations/a',
    'projects/elsewhere/locations/us-west1/operations/a',
    'projects/bmson-assistant/locations/europe/operations/a',
    `${name}/../other`,
  ])('rejects operation escape %s', (bad) => {
    expect(() => operationName({ name: bad })).toThrow('Untrusted native operation');
  });
  it('polls only fixed operation and checks exact returned name', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ name, done: true, response: {} }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await nativeRetirementClient('token', request, sleep).waitOperation({ name });
    expect(request.mock.calls[0]?.[0]).toBe(`https://run.googleapis.com/v2/${name}`);
    expect(sleep).toHaveBeenCalledWith(3000);
    request.mockResolvedValue(response({ name: `${name}wrong`, done: true, response: {} }));
    await expect(
      nativeRetirementClient('token', request, sleep).waitOperation({ name }),
    ).rejects.toThrow('Native operation changed');
  });
  it('fails on operation error without exposing error details', async () => {
    await expect(
      nativeRetirementClient('token').waitOperation({
        name,
        done: true,
        error: { message: 'private' },
      }),
    ).rejects.toThrow('Native operation failed');
  });
  it('bounds operation polling without issuing PATCH again', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response({ name }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      nativeRetirementClient('token', request, sleep).waitOperation({ name }),
    ).rejects.toThrow('Native operation unsettled');
    expect(request).toHaveBeenCalledTimes(60);
    expect(request.mock.calls.every(([, opts]) => opts?.method === 'GET')).toBe(true);
  });
  it('includes network time in the operation deadline', async () => {
    let clock = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      clock += 15_000;
      return response({ name });
    });
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms;
    });
    await expect(
      nativeRetirementClient('token', request, sleep, () => clock).waitOperation({ name }),
    ).rejects.toThrow('Native operation unsettled');
    expect(clock).toBeLessThanOrEqual(180_000);
    expect(request).toHaveBeenCalledTimes(10);
  });
  it('bounds response bytes and rejects redirects or wrong revision paths', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    const client = nativeRetirementClient('token', request);
    await expect(client.readService()).rejects.toThrow('Native response unreadable');
    expect(() => client.readRevision('../other')).toThrow('Untrusted native revision');
    request.mockResolvedValue(response({}, 302));
    await expect(client.readService()).rejects.toThrow('Native read rejected');
  });
  it('always waits full600 in bounded chunks', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await nativeRetirementClient('token', fetch, sleep).drain(600);
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(sleep.mock.calls.every(([ms]) => ms === 30_000)).toBe(true);
  });
});
