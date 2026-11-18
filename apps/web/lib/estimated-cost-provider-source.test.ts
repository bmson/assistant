import { loadConfig, resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it } from 'vitest';
import { estimatedCostProviderSource } from './estimated-cost-provider-source';

const release = 'a'.repeat(40);
const source = {
  provider: 'openrouter',
  endpoint: 'https://openrouter.ai/api/v1',
  installationId: 'test-installation',
  projectId: 'test-project',
  secretVersion: 'projects/test-project/secrets/openrouter-api-key/versions/31',
  sourceRelease: release,
};
const config = (enabled: boolean, manifest = JSON.stringify(source)) =>
  loadConfig({
    NODE_ENV: 'test',
    ESTIMATED_COST_APPROVAL_ENABLED: String(enabled),
    ESTIMATED_COST_PROVIDER_SOURCE_JSON: manifest,
    ASSISTANT_WORKSPACE_ID: source.installationId,
    GCP_PROJECT: source.projectId,
  });

describe('web estimated cost provider composition', () => {
  afterEach(resetConfigForTest);

  it('leaves the ordinary disabled runtime independent of an unused manifest', () => {
    expect(estimatedCostProviderSource(config(false, 'unqualified'), undefined)).toBeUndefined();
  });

  it('qualifies a manifest only against this image and installation', () => {
    const qualified = estimatedCostProviderSource(config(true), release);
    expect(qualified).toEqual(source);
    expect(Object.isFrozen(qualified)).toBe(true);
  });

  it.each([undefined, 'b'.repeat(40)])('rejects missing or changed image identity %s', (sha) => {
    expect(() => estimatedCostProviderSource(config(true), sha)).toThrow(/scope mismatch/);
  });

  it('keeps configured-connection deployments usable without an environment fallback', () => {
    expect(estimatedCostProviderSource(config(true, ''), release)).toBeUndefined();
  });
});
