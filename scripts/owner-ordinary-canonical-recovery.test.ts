import { expect, it, vi } from 'vitest';
import { loadOrdinaryCanonicalRecovery } from './owner-ordinary-canonical-recovery.js';
import { loadRetainedServingImageEvidence } from './owner-serving-image-evidence.js';

vi.mock('./owner-serving-image-evidence.js', () => ({ loadRetainedServingImageEvidence: vi.fn() }));

it('requires the reviewed serving identity and its exact web image', () => {
  const load = vi.mocked(loadRetainedServingImageEvidence);
  load.mockReturnValue(undefined);
  expect(loadOrdinaryCanonicalRecovery({})).toBeUndefined();
  const registerServingImage = vi.fn(() => false);
  load.mockReturnValue({ generation: 'test', sha256: 'test', registerServingImage });
  expect(() => loadOrdinaryCanonicalRecovery({})).toThrow();
  registerServingImage.mockReturnValue(true);
  const proof = loadOrdinaryCanonicalRecovery({});
  expect(proof?.retiredAliases.candidate.tag).toBe(proof?.candidateTag);
  expect(proof?.retiredAliases.resume.tag).toBe('resume-44679671412-1');
  expect(proof?.canonicalRevision).toBe('assistant-web-r-44679671412-1-d6954975');
  expect(registerServingImage).toHaveBeenLastCalledWith(proof?.canonicalImage);
  expect(proof?.evidenceSha256).toHaveLength(64);
});
