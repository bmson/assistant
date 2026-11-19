import { expect, it } from 'vitest';
import { parseEstimatedCostRuntimeProviderSource } from './estimated-cost-approval.js';

it('accepts only a complete, pinned, nonsecret provider source', () => {
  const source = {
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    installationId: 'assistant',
    projectId: 'project-one',
    secretVersion: 'projects/project-one/secrets/provider/versions/31',
    sourceRelease: 'a'.repeat(40),
  };
  const expected = {
    installationId: source.installationId,
    projectId: source.projectId,
    sourceRelease: source.sourceRelease,
  };
  expect(parseEstimatedCostRuntimeProviderSource('', expected)).toBeUndefined();
  for (const invalid of ['null', '[]', '{', ' '])
    expect(() => parseEstimatedCostRuntimeProviderSource(invalid, expected)).toThrow();
  expect(parseEstimatedCostRuntimeProviderSource(JSON.stringify(source), expected)).toEqual(source);
  expect(() =>
    parseEstimatedCostRuntimeProviderSource(JSON.stringify(source), {
      ...expected,
      sourceRelease: undefined,
    }),
  ).toThrow('scope mismatch');
  for (const invalid of [
    { ...source, secretVersion: 'projects/project-one/secrets/provider/versions/latest' },
    { ...source, secretVersion: 'projects/other/secrets/provider/versions/31' },
    { ...source, sourceRelease: 'a'.repeat(41) },
    { ...source, endpoint: 'https://example.invalid' },
    { ...source, extra: 'not-allowed' },
  ])
    expect(() =>
      parseEstimatedCostRuntimeProviderSource(JSON.stringify(invalid), expected),
    ).toThrow('Invalid estimated cost runtime provider source');
});
