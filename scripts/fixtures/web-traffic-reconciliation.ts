import { HISTORICAL_WEB_TAGS, WEB_SERVICE } from '../owner-web-tag-retirement.js';
export const secret = 'PRIVATE_NATIVE_ENV_STDERR_CREDENTIAL_PAYLOAD';
export function fixedTrafficFixture() {
  const old = HISTORICAL_WEB_TAGS[0],
    current = HISTORICAL_WEB_TAGS[1];
  if (!old || !current) throw new Error('Missing reviewed pins');
  const nativeRevision = (p: typeof old) => ({
    name: `${WEB_SERVICE}/revisions/${p.revision}`,
    uid: `uid-${p.revision}`,
    serviceAccount: 'runtime@bmson-assistant.iam.gserviceaccount.com',
    timeout: '300s',
    containers: [
      {
        image: p.image,
        env: [
          { name: 'ASSISTANT_RELEASE_WRITES_PAUSED', value: 'false' },
          { name: 'PRIVATE', value: secret },
        ],
      },
    ],
  });
  const native = {
    [old.revision]: nativeRevision(old),
    [current.revision]: nativeRevision(current),
  };
  const row = (p: typeof old, percent?: number) => ({
    type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
    revision: p.revision,
    tag: p.tag,
    ...(percent === undefined ? {} : { percent }),
  });
  const uri = (p: typeof old) => `https://${p.tag}---assistant-web-3gimfiaifa-uw.a.run.app`;
  const before = {
    name: WEB_SERVICE,
    uid: 'same-service-uid',
    etag: 'before-etag',
    generation: '7',
    observedGeneration: '7',
    terminalCondition: { state: 'CONDITION_SUCCEEDED' },
    uri: 'https://assistant-web-3gimfiaifa-uw.a.run.app',
    urls: ['https://assistant-web-3gimfiaifa-uw.a.run.app'],
    template: {
      serviceAccount: native[current.revision]?.serviceAccount,
      containers: [{ image: current.image, env: [{ name: 'PRIVATE', value: secret }] }],
    },
    labels: { scope: 'unchanged' },
    latestReadyRevision: current.revision,
    latestCreatedRevision: current.revision,
    traffic: [
      { type: row(current).type, revision: current.revision, percent: 100 },
      row(current),
      row(old),
    ],
    trafficStatuses: [
      { ...row(current, 100), uri: uri(current) },
      { ...row(old), uri: uri(old) },
    ],
  };

  const after = {
    ...structuredClone(before),
    etag: 'after-etag',
    generation: '8',
    observedGeneration: '8',
    traffic: [row(current, 100), row(old, 0)],
  };
  return { before, after, native, old, current };
}
