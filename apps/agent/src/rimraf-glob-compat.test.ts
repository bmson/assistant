import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

describe('Firestore cleanup dependency compatibility', () => {
  it('keeps the retired rimraf cleanup dependency out of the Firestore SDK', () => {
    const require = createRequire(import.meta.url);
    const firestoreRequire = createRequire(require.resolve('@google-cloud/firestore/package.json'));
    const firestoreApiRequire = createRequire(
      firestoreRequire.resolve('@google-cloud/firestore-api/package.json'),
    );
    const googleGaxRequire = createRequire(firestoreApiRequire.resolve('google-gax'));
    expect(() => googleGaxRequire.resolve('rimraf/package.json')).toThrow(
      expect.objectContaining({ code: 'MODULE_NOT_FOUND' }),
    );
  });
});
