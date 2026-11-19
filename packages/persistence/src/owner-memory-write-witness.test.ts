import { describe, expect, it } from 'vitest';
import {
  createOwnerMemoryWriteWitness,
  type OwnerMemoryWriteWitness,
  parseOwnerMemoryWriteWitness,
} from './owner-memory-write-witness.js';

const contentHash = 'a'.repeat(64);
const attributed: OwnerMemoryWriteWitness = {
  version: 1,
  writeVersion: '22222222-2222-4222-8222-222222222222',
  contentHash,
  attribution: {
    operationKey: 'b'.repeat(64),
    requestHash: 'c'.repeat(64),
    provenanceFingerprint: 'd'.repeat(64),
  },
};

describe('owner-memory write witness codec', () => {
  it('treats missing and null values as legacy unknown state', () => {
    expect(parseOwnerMemoryWriteWitness(undefined)).toBeNull();
    expect(parseOwnerMemoryWriteWitness(null)).toBeNull();
  });

  it('round-trips the exact version 1 shape, including parsed attribution', () => {
    expect(parseOwnerMemoryWriteWitness(attributed)).toEqual(attributed);
    expect(
      parseOwnerMemoryWriteWitness({
        version: 1,
        writeVersion: attributed.writeVersion,
        contentHash,
        attribution: null,
      }),
    ).toEqual({
      version: 1,
      writeVersion: attributed.writeVersion,
      contentHash,
      attribution: null,
    });
  });

  it('rejects malformed values, unknown versions, and extra keys at each level', () => {
    const base = {
      version: 1,
      writeVersion: attributed.writeVersion,
      contentHash,
      attribution: null,
    };
    const invalidValues: unknown[] = [
      false,
      [],
      { ...base, version: 2 },
      { ...base, extra: true },
      { ...base, [Symbol('extra')]: true },
      { ...base, contentHash: 'not-a-sha256' },
      { ...base, writeVersion: 'not-a-uuid' },
      { ...base, attribution: 'legacy' },
      { ...base, attribution: { ...attributed.attribution, extra: 'ignored?' } },
      { ...base, attribution: { ...attributed.attribution, requestHash: 'short' } },
      Object.assign(Object.create({ inherited: true }), base),
      {
        ...base,
        attribution: Object.assign(Object.create({ inherited: true }), attributed.attribution),
      },
    ];

    for (const value of invalidValues) {
      expect(() => parseOwnerMemoryWriteWitness(value)).toThrow();
    }
  });

  it('rejects accessor-backed fields before invoking top-level, nested, or constructor getters', () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const accessorValue = {
      ...attributed,
      attribution: null,
    };
    Object.defineProperty(accessorValue, 'version', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() => parseOwnerMemoryWriteWitness(accessorValue)).toThrow();

    const accessorContentHash = {
      ...attributed,
      attribution: null,
    };
    Object.defineProperty(accessorContentHash, 'contentHash', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return contentHash;
      },
    });
    expect(() => parseOwnerMemoryWriteWitness(accessorContentHash)).toThrow();

    const setterContentHash = {
      ...attributed,
      attribution: null,
    };
    Object.defineProperty(setterContentHash, 'contentHash', {
      enumerable: true,
      set: () => {
        setterCalls += 1;
      },
    });
    expect(() => parseOwnerMemoryWriteWitness(setterContentHash)).toThrow();

    const accessorAttribution = { ...attributed.attribution };
    Object.defineProperty(accessorAttribution, 'operationKey', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'b'.repeat(64);
      },
    });
    expect(() =>
      parseOwnerMemoryWriteWitness({ ...attributed, attribution: accessorAttribution }),
    ).toThrow();

    const accessorConstructorInput = {};
    Object.defineProperty(accessorConstructorInput, 'contentHash', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return contentHash;
      },
    });
    expect(() =>
      createOwnerMemoryWriteWitness(
        accessorConstructorInput as Parameters<typeof createOwnerMemoryWriteWitness>[0],
      ),
    ).toThrow();

    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
  });

  it('creates a fresh un-attributed identity for each generic write, even for identical content', () => {
    const first = createOwnerMemoryWriteWitness({ contentHash });
    const second = createOwnerMemoryWriteWitness({ contentHash });

    expect(first).toMatchObject({ version: 1, contentHash, attribution: null });
    expect(second).toMatchObject({ version: 1, contentHash, attribution: null });
    expect(first.writeVersion).not.toBe(second.writeVersion);
    expect(parseOwnerMemoryWriteWitness(first)).toEqual(first);
    expect(parseOwnerMemoryWriteWitness(second)).toEqual(second);
  });

  it('rejects caller-supplied attribution when constructing a generic write', () => {
    expect(() =>
      createOwnerMemoryWriteWitness({
        contentHash,
        attribution: attributed.attribution,
      } as unknown as Parameters<typeof createOwnerMemoryWriteWitness>[0]),
    ).toThrow();
  });

  it('validates the generic constructor content hash at runtime', () => {
    expect(() => createOwnerMemoryWriteWitness({ contentHash: 'bad' })).toThrow();
  });
});
