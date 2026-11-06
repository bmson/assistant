import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Context,
  captureLifecycle,
  creationTemplate,
  releaseIdentity,
} from './owner-web-release-lifecycle-model.js';
import { projectNativeWebSnapshot, TEMPLATE_FIELDS } from './owner-web-release-native-proof.js';
import { tagHash, WEB_SERVICE } from './owner-web-tag-retirement.js';
import { reconciliationDigest as digest } from './owner-web-traffic-reconciliation-model.js';

// biome-ignore lint/suspicious/noExplicitAny: The sanitized fixture retains an intentionally heterogeneous native JSON shape.
type Obj = Record<string, any>;
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/owner-web-native-current-profile.synthetic.json', import.meta.url),
    'utf8',
  ),
) as { fixtureKind: string; sourceCaptureMetadata: Obj; service: Obj; revision: Obj };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const canonicalUrl = 'https://assistant-web-83709630368.us-west1.run.app';
const serviceRootUrl = 'https://assistant-web-1234567890-uw.a.run.app';
const canonical = 'assistant-web-oomrelief-20261106a';
const image = `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'f'.repeat(64)}`;

function revisionTemplate(revision: Obj, name: string): Obj {
  const template = Object.fromEntries(
    TEMPLATE_FIELDS.filter((key) => key !== 'revision' && revision[key] !== undefined).map(
      (key) => [key, revision[key]],
    ),
  );
  return { ...template, revision: name };
}

function contextFor(s = fixture.service, r = fixture.revision): Context {
  const manifest = 'e'.repeat(64),
    source = 'a'.repeat(40),
    sourceProof = 'c'.repeat(40);
  const proof = {
    uid: tagHash(r.uid),
    image: r.containers[0].image,
    source: sourceProof,
    runId: '40403696377',
    attempt: '1',
    manifest,
    paused: false,
    templateSha256: digest(revisionTemplate(r, canonical)),
  };
  return {
    source,
    runId: '1',
    attempt: '1',
    manifest,
    image,
    canonical,
    retiredTags: [],
    releaseEnv: {
      ASSISTANT_RELEASE_API_CONTRACT: '1',
      ASSISTANT_RELEASE_AGENT_API_MIN: '1',
      ASSISTANT_RELEASE_AGENT_API_MAX: '1',
      ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
      ASSISTANT_RELEASE_SCHEMA_MIN: '133',
      ASSISTANT_RELEASE_SCHEMA_MAX: '133',
      ASSISTANT_RELEASE_SCHEMA_VERSION: '133',
      ASSISTANT_RELEASE_MANIFEST: manifest,
      ASSISTANT_RELEASE_WORKFLOW_RUN_ID: '1',
      ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: '1',
      ASSISTANT_RELEASE_SOURCE_SHA: source,
    },
    currentBinding: {
      proof,
      serviceSha256: digest(s),
      revisionSha256: digest(r),
      reviewedEvidenceSha256: digest(fixture.sourceCaptureMetadata),
      preclosed: true,
    },
  };
}

function prepareCurrentProfile() {
  const service = clone(fixture.service),
    revision = clone(fixture.revision),
    context = contextFor(service, revision);
  const serviceContainer = service.template.containers[0];
  const revisionContainer = revision.containers[0];
  expect(Object.hasOwn(serviceContainer, 'name')).toBe(false);
  expect(revisionContainer.name).toBe('web-1');
  const { name: _revisionName, ...withoutRevisionName } = revisionContainer;
  expect(withoutRevisionName).toEqual(serviceContainer);
  const withoutContainerName = clone(revisionTemplate(revision, canonical));
  (withoutContainerName.containers as Obj[])[0] = withoutRevisionName;
  expect(withoutContainerName).toEqual(service.template);
  return { service, revision, context };
}

function project(service: Obj, revision: Obj, context: Context) {
  return projectNativeWebSnapshot(service, { [canonical]: revision }, context);
}

describe('sanitized native current web profile compatibility', () => {
  it('labels fixture as synthetic and retains the two source URL hashes in response order', () => {
    expect(fixture.fixtureKind).toBe('SYNTHETIC_SANITIZED_NATIVE_PROFILE_SHAPE_ONLY');
    expect(fixture.sourceCaptureMetadata.sourceUrlsSha256InResponseOrder).toEqual([
      '6655d0b247155dc70e2a6139a09573bef9ab9acd750d0fe3f566a1397c3bdc0c',
      '34377609673417651f17a0fdac39e319152a779332e99fe439d7bf6e2662e86c',
    ]);
    expect(fixture.service.urls).toEqual([canonicalUrl, serviceRootUrl]);
    expect(fixture.revision.service).toBe('assistant-web');
    expect(fixture.revision.name).toBe(`${WEB_SERVICE}/revisions/${canonical}`);
  });

  it('projects and captures the reviewed current service URLs and defaulted container name', () => {
    const { service, revision, context } = prepareCurrentProfile(),
      beforeService = clone(service),
      beforeRevision = clone(revision),
      beforeContext = clone(context),
      projected = project(service, revision, context),
      projectedTemplate = projected.template as Obj,
      lifecycle = captureLifecycle(context, projected);

    expect(projected.urls).toEqual([tagHash(canonicalUrl), tagHash(serviceRootUrl)]);
    expect(projectedTemplate.containers[0].name).toBe('web-1');
    expect(digest(projectedTemplate)).toBe(projected.revisions[canonical]?.templateSha256);
    expect(lifecycle.phase).toBe('captured');
    expect(service).toEqual(beforeService);
    expect(revision).toEqual(beforeRevision);
    expect(context).toEqual(beforeContext);
  });

  it('preserves reviewed explicit web-1 and every unrelated field in both creation templates', () => {
    const { service, revision, context } = prepareCurrentProfile(),
      projected = project(service, revision, context);
    const projectedTemplate = projected.template as Obj;
    projectedTemplate.containers[0].name = 'web-1';
    const before = clone(projectedTemplate);
    const withoutAllowedCreationChanges = (value: Obj) => {
      const normalized = clone(value);
      delete normalized.revision;
      const container = normalized.containers[0];
      container.image = '<release-image>';
      container.env = container.env.filter(
        (entry: Obj) => !entry.name.startsWith('ASSISTANT_RELEASE_'),
      );
      return normalized;
    };
    for (const role of ['P', 'R'] as const) {
      const created = creationTemplate(projectedTemplate, context, role) as Obj;
      expect(created.revision).toBe(releaseIdentity(context, role).revision);
      expect(created.containers[0].name).toBe('web-1');
      expect(created.containers[0].image).toBe(context.image);
      expect(withoutAllowedCreationChanges(created)).toEqual(withoutAllowedCreationChanges(before));
      expect(created.containers[0].resources).toEqual(before.containers[0].resources);
      expect(created.containers[0].ports).toEqual(before.containers[0].ports);
      expect(created.containers[0].startupProbe).toEqual(before.containers[0].startupProbe);
      expect(created.scaling).toEqual(before.scaling);
      expect(created.serviceAccount).toBe(before.serviceAccount);
      expect(created.maxInstanceRequestConcurrency).toBe(before.maxInstanceRequestConcurrency);
      expect(created.client).toBe(before.client);
      expect(created.clientVersion).toBe(before.clientVersion);
      expect(created.containers[0].env.find((e: Obj) => e.name === 'SYNTHETIC_SECRET_REF')).toEqual(
        before.containers[0].env.find((e: Obj) => e.name === 'SYNTHETIC_SECRET_REF'),
      );
    }
  });

  type ProfilePair = { service: Obj; revision: Obj };
  const profileMutations: Array<[string, (pair: ProfilePair) => void]> = [
    [
      'cross-project service',
      (p) => {
        p.service.name = p.service.name.replace('bmson-assistant', 'other-project');
      },
    ],
    [
      'cross-region service',
      (p) => {
        p.service.name = p.service.name.replace('us-west1', 'us-east1');
      },
    ],
    [
      'wrong service',
      (p) => {
        p.service.name = `${WEB_SERVICE}-other`;
      },
    ],
    [
      'wrong canonical URL project number',
      (p) => {
        p.service.urls[0] = canonicalUrl.replace('83709630368', '83709630369');
      },
    ],
    [
      'wrong canonical URL region',
      (p) => {
        p.service.urls[0] = canonicalUrl.replace('us-west1', 'us-east1');
      },
    ],
    [
      'wrong canonical URL service',
      (p) => {
        p.service.urls[0] = canonicalUrl.replace('assistant-web', 'other-service');
      },
    ],
    [
      'modern service URL',
      (p) => {
        p.service.urls[0] = 'https://assistant-web-83709630368.run.app';
      },
    ],
    [
      'URL credentials',
      (p) => {
        p.service.urls[0] = 'https://user:pass@assistant-web-83709630368.us-west1.run.app';
      },
    ],
    [
      'URL path',
      (p) => {
        p.service.urls[0] = `${canonicalUrl}/path`;
      },
    ],
    [
      'URL query',
      (p) => {
        p.service.urls[0] = `${canonicalUrl}?q=x`;
      },
    ],
    [
      'URL port',
      (p) => {
        p.service.urls[0] = 'https://assistant-web-83709630368.us-west1.run.app:443';
      },
    ],
    [
      'unknown alias URL',
      (p) => {
        p.service.urls[0] = 'https://unknown.synthetic.invalid';
      },
    ],
    [
      'wrong revision resource name',
      (p) => {
        p.revision.name = `${WEB_SERVICE}-other/revisions/${canonical}`;
      },
    ],
    [
      'wrong revision project with short service',
      (p) => {
        p.revision.name = `projects/other-project/locations/us-west1/services/assistant-web/revisions/${canonical}`;
      },
    ],
    [
      'wrong revision region with short service',
      (p) => {
        p.revision.name = `projects/bmson-assistant/locations/us-east1/services/assistant-web/revisions/${canonical}`;
      },
    ],
    [
      'wrong revision service identity',
      (p) => {
        p.revision.service = 'other-service';
      },
    ],
    [
      'failed service terminal condition',
      (p) => {
        p.service.terminalCondition.state = 'CONDITION_FAILED';
      },
    ],
    [
      'service reconciling',
      (p) => {
        p.service.reconciling = true;
      },
    ],
    [
      'failed revision readiness',
      (p) => {
        p.revision.conditions[0].state = 'CONDITION_FAILED';
      },
    ],
    [
      'revision reconciling',
      (p) => {
        p.revision.reconciling = true;
      },
    ],
    [
      'explicit mismatched service container name',
      (p) => {
        p.service.template.containers[0].name = 'worker';
      },
    ],
    [
      'multiple service containers',
      (p) => {
        p.service.template.containers.push(clone(p.service.template.containers[0]));
      },
    ],
    [
      'service resource drift',
      (p) => {
        p.service.template.containers[0].resources.limits.cpu = '2';
      },
    ],
    [
      'revision resource drift',
      (p) => {
        p.revision.containers[0].resources.limits.memory = '1Gi';
      },
    ],
    [
      'service environment drift',
      (p) => {
        p.service.template.containers[0].env[0].value = '2';
      },
    ],
    [
      'revision environment drift',
      (p) => {
        p.revision.containers[0].env[0].value = '2';
      },
    ],
    [
      'dependency drift',
      (p) => {
        p.service.template.containers[0].ports[0].containerPort = 8081;
      },
    ],
    [
      'other template config drift',
      (p) => {
        p.service.template.maxInstanceRequestConcurrency = 81;
      },
    ],
  ];
  it.each(profileMutations)('rejects unreviewed native profile drift: %s', (_kind, mutate) => {
    const { service, revision, context } = prepareCurrentProfile();
    mutate({ service, revision });
    expect(() => project(service, revision, context)).toThrow('Native release validation held');
  });

  const urlMutations: Array<[string, (service: Obj) => void]> = [
    [
      'third valid legacy alias',
      (s) => {
        s.urls.push('https://assistant-web-unreviewed-uw.a.run.app');
      },
    ],
    [
      'duplicate canonical URL',
      (s) => {
        s.urls.push(canonicalUrl);
      },
    ],
    [
      'missing legacy root URL',
      (s) => {
        s.urls = [canonicalUrl];
      },
    ],
  ];
  it.each(urlMutations)('capture rejects URL-set drift: %s', (_kind, mutate) => {
    const { service, revision, context } = prepareCurrentProfile();
    mutate(service);
    expect(() => captureLifecycle(context, project(service, revision, context))).toThrow();
  });

  it('captures a legacy-only URL set when it is exactly the service root', () => {
    const { service, revision, context } = prepareCurrentProfile();
    service.urls = [serviceRootUrl];
    expect(captureLifecycle(context, project(service, revision, context)).phase).toBe('captured');
  });

  it.each(['P', 'R'] as const)(
    'rejects provider-default container-name normalization for new %s service revisions',
    (role) => {
      const { service, revision, context } = prepareCurrentProfile(),
        current = project(service, revision, context),
        planned = creationTemplate(current.template, context, role),
        candidate = releaseIdentity(context, role),
        next = clone(service),
        candidateRevision = clone(revision);
      planned.revision = candidate.revision;
      candidateRevision.name = `${WEB_SERVICE}/revisions/${candidate.revision}`;
      candidateRevision.service = 'assistant-web';
      candidateRevision.scaling = clone(planned.scaling);
      candidateRevision.timeout = planned.timeout;
      candidateRevision.serviceAccount = planned.serviceAccount;
      candidateRevision.containers = clone(planned.containers);
      candidateRevision.maxInstanceRequestConcurrency = planned.maxInstanceRequestConcurrency;
      candidateRevision.client = planned.client;
      candidateRevision.clientVersion = planned.clientVersion;

      next.latestReadyRevision = next.latestCreatedRevision = candidate.revision;
      next.template = clone(planned);
      next.traffic[0].revision = `${WEB_SERVICE}/revisions/${candidate.revision}`;
      next.trafficStatuses[0].revision = `${WEB_SERVICE}/revisions/${candidate.revision}`;
      const native = { [canonical]: revision, [candidate.revision]: candidateRevision };
      const valid = projectNativeWebSnapshot(clone(next), native, context);
      expect(valid.revisions[candidate.revision]?.templateSha256).toBe(digest(planned));

      delete next.template.containers[0].name;
      expect(() => projectNativeWebSnapshot(next, native, context)).toThrow(
        'Native release validation held',
      );
    },
  );
});
