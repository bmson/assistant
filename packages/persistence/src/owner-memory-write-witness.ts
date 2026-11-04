import { randomUUID } from 'node:crypto';

/**
 * Durable identity for one owner-memory write. Attribution is parsed for storage
 * compatibility, but this module intentionally exposes no way to mint it.
 */
export interface OwnerMemoryWriteWitness {
  version: 1;
  writeVersion: string;
  contentHash: string;
  attribution: OwnerMemoryWriteWitnessAttribution | null;
}

export interface OwnerMemoryWriteWitnessAttribution {
  operationKey: string;
  requestHash: string;
  provenanceFingerprint: string;
}

export interface NewOwnerMemoryWriteWitnessInput {
  contentHash: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Starts a generic owner-memory write with a fresh identity and no attribution.
 * The exact input shape is checked at runtime so untrusted callers cannot pass
 * attribution through an extra property.
 */
export function createOwnerMemoryWriteWitness(
  input: NewOwnerMemoryWriteWitnessInput,
): OwnerMemoryWriteWitness {
  assertExactKeys(input, ['contentHash'], 'new owner-memory write witness input');
  assertSha256(input.contentHash, 'contentHash');

  return {
    version: 1,
    writeVersion: randomUUID(),
    contentHash: input.contentHash,
    attribution: null,
  };
}

/**
 * Parses the strict version 1 storage representation. Missing and null values
 * are legacy records with unknown witness state; malformed values fail closed.
 */
export function parseOwnerMemoryWriteWitness(value: unknown): OwnerMemoryWriteWitness | null {
  if (value === undefined || value === null) return null;

  assertObject(value, 'owner-memory write witness');
  assertExactKeys(
    value,
    ['version', 'writeVersion', 'contentHash', 'attribution'],
    'owner-memory write witness',
  );

  if (value.version !== 1) {
    throw new TypeError('Unsupported owner-memory write witness version');
  }
  if (typeof value.writeVersion !== 'string' || !UUID_PATTERN.test(value.writeVersion)) {
    throw new TypeError('Invalid owner-memory write witness writeVersion');
  }
  assertSha256(value.contentHash, 'contentHash');

  let attribution: OwnerMemoryWriteWitnessAttribution | null;
  if (value.attribution === null) {
    attribution = null;
  } else {
    assertObject(value.attribution, 'owner-memory write witness attribution');
    assertExactKeys(
      value.attribution,
      ['operationKey', 'requestHash', 'provenanceFingerprint'],
      'owner-memory write witness attribution',
    );
    assertSha256(value.attribution.operationKey, 'attribution.operationKey');
    assertSha256(value.attribution.requestHash, 'attribution.requestHash');
    assertSha256(value.attribution.provenanceFingerprint, 'attribution.provenanceFingerprint');
    attribution = {
      operationKey: value.attribution.operationKey,
      requestHash: value.attribution.requestHash,
      provenanceFingerprint: value.attribution.provenanceFingerprint,
    };
  }

  return {
    version: 1,
    writeVersion: value.writeVersion,
    contentHash: value.contentHash,
    attribution,
  };
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Invalid ${label} prototype`);
  }
}

function assertExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertObject(value, label);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError(`Invalid ${label} keys`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`Invalid ${label} property ${key}`);
    }
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`Invalid owner-memory write witness ${label}`);
  }
}
