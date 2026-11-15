import { describe, expect, it } from 'vitest';
import {
  bootstrapDigest,
  matchesScalingConfigurationDigest,
  scalingConfigurationDigest,
  verifyCurrentService,
} from './owner-release-current-snapshot.js';
import {
  matchesNativeServiceDigest,
  nativeServiceDefaults,
} from './owner-release-native-service-defaults.js';
import {
  matchesNativeStableConfigurationDigest,
  nativeStableConfigurationDigest,
} from './owner-web-release-native-proof.js';

const digest = bootstrapDigest;
const service = () => ({
  name: 'projects/bmson-assistant/locations/us-west1/services/assistant-web',
  uid: 'service-uid',
  etag: 'etag-1',
  generation: '1',
  observedGeneration: '1',
  scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
  ingress: 'INGRESS_TRAFFIC_ALL',
  template: {
    containers: [
      {
        image: 'image@sha256:abc',
        env: [
          {
            name: 'SECRET_REF',
            valueSource: { secretKeyRef: { secret: 'synthetic', version: '1' } },
          },
        ],
      },
    ],
  },
  traffic: [
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: 'assistant-web-current',
      percent: 100,
    },
  ],
  trafficStatuses: [
    {
      type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
      revision: 'assistant-web-current',
      percent: 100,
    },
  ],
  terminalCondition: { state: 'CONDITION_SUCCEEDED' },
  latestCreatedRevision: 'assistant-web-current',
});

describe('strict native Service sshEnabled default compatibility', () => {
  it('matches old raw absent/false receipt hashes in both directions without rewriting evidence', () => {
    const absent = service(),
      explicit = { ...absent, sshEnabled: false };
    const before = JSON.stringify([absent, explicit]);
    expect(digest(absent)).not.toBe(digest(explicit));
    for (const expected of [digest(absent), digest(explicit)]) {
      expect(matchesNativeServiceDigest(absent, expected, digest)).toBe(true);
      expect(matchesNativeServiceDigest(explicit, expected, digest)).toBe(true);
    }
    expect(JSON.stringify([absent, explicit])).toBe(before);
    expect(nativeServiceDefaults(explicit)).not.toBe(explicit);
  });

  it('retains true as a distinct configuration and never defaults nested or other fields', () => {
    const raw = service(),
      expected = digest(raw);
    expect(matchesNativeServiceDigest({ ...raw, sshEnabled: true }, expected, digest)).toBe(false);
    expect(matchesNativeServiceDigest(raw, digest({ ...raw, sshEnabled: true }), digest)).toBe(
      false,
    );
    expect(nativeServiceDefaults({ ...raw, sshEnabled: true }).sshEnabled).toBe(true);
    for (const changed of [
      { ...raw, uid: 'different' },
      { ...raw, etag: 'different' },
      { ...raw, ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' },
      { ...raw, scaling: { scalingMode: 'AUTOMATIC' } },
      { ...raw, traffic: [{ ...raw.traffic[0], tag: 'unexpected' }] },
      { ...raw, template: { ...raw.template, sshEnabled: false } },
      { ...raw, invokerIamDisabled: false },
      { ...raw, terminalCondition: { state: 'CONDITION_FAILED' } },
    ])
      expect(matchesNativeServiceDigest(changed, expected, digest)).toBe(false);
  });

  it.each([null, 'false', 'true', 0, 1, {}, [], undefined])(
    'rejects a malformed present sshEnabled value (%j)',
    (value) => {
      const raw = { ...service(), sshEnabled: value };
      expect(() => nativeServiceDefaults(raw)).toThrow('Invalid native service defaults');
      expect(() => matchesNativeServiceDigest(raw, digest(raw), digest)).toThrow();
    },
  );

  it('keeps scaling/stable fingerprints invariant only for the service false default', () => {
    const raw = service(),
      explicit = { ...raw, sshEnabled: false };
    expect(scalingConfigurationDigest(raw)).toBe(scalingConfigurationDigest(explicit));
    expect(nativeStableConfigurationDigest(raw)).toBe(nativeStableConfigurationDigest(explicit));
    expect(scalingConfigurationDigest({ ...raw, sshEnabled: true })).not.toBe(
      scalingConfigurationDigest(raw),
    );
    expect(nativeStableConfigurationDigest({ ...raw, sshEnabled: true })).not.toBe(
      nativeStableConfigurationDigest(raw),
    );
    expect(
      nativeStableConfigurationDigest({ ...raw, ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' }),
    ).not.toBe(nativeStableConfigurationDigest(raw));
    const oldScalingConfig = {
      name: raw.name,
      uid: raw.uid,
      scaling: raw.scaling,
      ingress: raw.ingress,
      template: raw.template,
      traffic: raw.traffic,
      sshEnabled: false,
    };
    expect(matchesScalingConfigurationDigest(raw, digest(oldScalingConfig))).toBe(true);
    expect(
      matchesNativeStableConfigurationDigest(
        raw,
        digest({ scaling: raw.scaling, ingress: raw.ingress, sshEnabled: false }),
      ),
    ).toBe(true);
  });

  it('accepts raw current bindings across the default flap but keeps all admission/identity gates', () => {
    const raw = service();
    const binding = {
      service: raw.name,
      uid: raw.uid,
      revision: 'assistant-web-current',
      image: 'image',
      serviceSha256: digest({ ...raw, sshEnabled: false }),
      revisionSha256: 'a'.repeat(64),
      proof: {
        uid: 'a'.repeat(64),
        image: 'image',
        source: 'a'.repeat(40),
        runId: '1',
        attempt: '1',
        manifest: 'a'.repeat(64),
        paused: false,
        templateSha256: 'a'.repeat(64),
      },
    };
    expect(() => verifyCurrentService(binding, raw)).not.toThrow();
    expect(() =>
      verifyCurrentService(
        { ...binding, serviceSha256: digest(raw) },
        { ...raw, sshEnabled: false },
      ),
    ).not.toThrow();
    for (const changed of [
      { ...raw, sshEnabled: true },
      { ...raw, uid: 'other' },
      { ...raw, scaling: { scalingMode: 'AUTOMATIC' } },
      { ...raw, trafficStatuses: [{ ...raw.trafficStatuses[0], tag: 'extra' }] },
    ])
      expect(() => verifyCurrentService(binding, changed)).toThrow();
  });
});
