import { describe, expect, it, vi } from 'vitest';
import {
  estimatedCostMetadataRead,
  estimatedCostMetadataUrl,
} from './estimated-cost-release-native-read.js';

const run = 'https://run.googleapis.com/v2/projects/bmson-assistant/locations/us-west1';
const secret =
  'https://secretmanager.googleapis.com/v1/projects/bmson-assistant/secrets/existing/versions/31';

describe('estimated cost fixed metadata transport', () => {
  it('accepts only the native release resources and metadata, without secret access', () => {
    for (const url of [
      `${run}/services/assistant-web`,
      `${run}/services/assistant-agent/revisions/assistant-agent-current`,
      `${run}/jobs/assistant-code`,
      `${run}/jobs/assistant-browser/executions?pageSize=100&pageToken=next`,
      'https://cloudtasks.googleapis.com/v2/projects/bmson-assistant/locations/us-west1/queues/agent-steps/tasks?pageSize=100&responseView=BASIC',
      'https://cloudscheduler.googleapis.com/v1/projects/bmson-assistant/locations/us-west1/jobs/assistant-sweep',
      'https://pubsub.googleapis.com/v1/projects/bmson-assistant/subscriptions/gmail-events-push',
      'https://cloudresourcemanager.googleapis.com/v3/projects/bmson-assistant',
      secret,
    ])
      expect(estimatedCostMetadataUrl(url)).toBe(url);
    for (const url of [
      `${secret}:access`,
      secret.replace('/31', '/latest'),
      secret.replace('bmson-assistant', 'other-project'),
      `${run}/jobs/assistant-code/executions?filter=active`,
      `${run}/jobs/assistant-code/executions?pageSize=1`,
      `${run}/jobs/assistant-code/executions?pageSize=100&pageSize=100`,
      `${run}/services/assistant-web?alt=json`,
      `${run}/services/other`,
      `${run}/services/assistant-web#fragment`,
      `${run.replace('https:', 'http:')}/services/assistant-web`,
      `${run.replace('run.googleapis.com', 'run.googleapis.com.evil.test')}/services/assistant-web`,
      'https://cloudbilling.googleapis.com/v1/billingAccounts',
    ])
      expect(() => estimatedCostMetadataUrl(url)).toThrow();
  });

  it('sends only bounded, authenticated GETs and refuses redirects or failed reads', async () => {
    const token = 'synthetic-metadata-token';
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      });
      return Response.json({ state: 'ENABLED' });
    });
    const read = estimatedCostMetadataRead(token, 2000, fetcher as typeof fetch, () => 1000);
    await expect(read(secret)).resolves.toEqual({ state: 'ENABLED' });
    await expect(read(`${secret}:access`)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const failed = estimatedCostMetadataRead(
      token,
      2000,
      async () => new Response(null, { status: 403 }),
      () => 1000,
    );
    await expect(failed(secret)).rejects.toThrow('unavailable');
    const expired = estimatedCostMetadataRead(token, 1000, fetcher as typeof fetch, () => 1000);
    await expect(expired(secret)).rejects.toThrow('bound');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
