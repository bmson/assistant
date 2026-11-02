/** Fixed BASIC5 paired web lifecycle controller; caller supplies protected transport and operator hold verifier. */

import { nativeWebCreationFixtureClient } from './owner-web-release-creation-client.js';
import {
  acceptAgentReady,
  type Context,
  captureLifecycle,
  type Mode,
  type Snapshot,
  type State,
} from './owner-web-release-lifecycle-model.js';
import { projectNativeWebSnapshot } from './owner-web-release-native-proof.js';
import type { FixtureDependencies } from './owner-web-release-native-session.js';
import { nativeWebTrafficFixtureClient } from './owner-web-release-traffic-client.js';
import { protectedWebTagCredential } from './owner-web-tag-cloud.js';
import { HISTORICAL_WEB_TAGS } from './owner-web-tag-retirement.js';
import { reconciliationDigest } from './owner-web-traffic-reconciliation-model.js';

type Receipts = {
  initialize(state: State): string;
  readCurrent(): State;
  recordIntent(state: State): void;
  recordCheckpoint(state: State): void;
};
const PHASES: readonly Mode[] = [
  'createP',
  'attachP',
  'promoteP',
  'createR',
  'attachR',
  'promoteR',
  'closeP',
  'restoreC',
  'repauseP',
  'closeR',
];
const NATIVE_ROOT = 'https://run.googleapis.com/v2/';

/** Existing protected WIF identity plus the reviewed fixed-host native session. */
export async function protectedNativeReleaseDependencies(
  receipts: Receipts,
): Promise<FixtureDependencies> {
  const token = await protectedWebTagCredential();
  return {
    request: async (url, options) => {
      if (!url.startsWith(NATIVE_ROOT) || !/^[A-Za-z0-9._~-]{1,16384}$/.test(token))
        throw new Error('Native release transport held');
      try {
        return await fetch(url, {
          method: options.method,
          ...(options.body ? { body: options.body } : {}),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.headers ?? {}),
          },
          signal: options.signal,
          redirect: 'error',
        });
      } catch {
        throw new Error(
          options.method === 'PATCH' ? 'Native PATCH outcome uncertain' : 'Native read failed',
        );
      }
    },
    now: Date.now,
    sleep: (ms, signal) =>
      new Promise((resolveSleep, reject) => {
        const timer = setTimeout(resolveSleep, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('Native wait held'));
          },
          { once: true },
        );
      }),
    recordIntent: async (state) => receipts.recordIntent(state),
  };
}

/** Derive the fixed context from the verified release manifest, never caller-selected targets. */
export function pairedWebContext(input: {
  source: string;
  runId: string;
  attempt: string;
  manifestDigest: string;
  manifest: Record<string, unknown>;
}): Context {
  const component = input.manifest.components as Record<string, Record<string, unknown>>;
  const web = component?.web;
  if (!web || input.manifest.storageDriver !== 'firestore')
    throw new Error('Paired Firestore context required');
  const peer = web.peerApi as Record<string, unknown>;
  const schema = web.schema as Record<string, unknown>;
  const image = web.image;
  if (typeof image !== 'string') throw new Error('Invalid web image identity');
  const releaseEnv = {
    ASSISTANT_RELEASE_API_CONTRACT: String(web.apiContract),
    ASSISTANT_RELEASE_AGENT_API_MIN: String(peer?.min),
    ASSISTANT_RELEASE_AGENT_API_MAX: String(peer?.max),
    ASSISTANT_RELEASE_SCHEMA_DRIVER: 'firestore',
    ASSISTANT_RELEASE_SCHEMA_MIN: String(schema?.min),
    ASSISTANT_RELEASE_SCHEMA_MAX: String(schema?.max),
    ASSISTANT_RELEASE_SCHEMA_VERSION: String(input.manifest.schemaVersion),
    ASSISTANT_RELEASE_MANIFEST: input.manifestDigest,
    ASSISTANT_RELEASE_WORKFLOW_RUN_ID: input.runId,
    ASSISTANT_RELEASE_WORKFLOW_RUN_ATTEMPT: input.attempt,
    ASSISTANT_RELEASE_SOURCE_SHA: input.source,
  };
  const current = HISTORICAL_WEB_TAGS[1];
  const retired = HISTORICAL_WEB_TAGS[0];
  if (!current || !retired) throw new Error('Canonical web proof is unavailable');
  return {
    source: input.source,
    runId: input.runId,
    attempt: input.attempt,
    manifest: input.manifestDigest,
    image,
    canonical: current.revision,
    releaseEnv,
    // The one-off historical 01080 retirement is a prerequisite to this fixed
    // initial inventory; any remaining unsupported alias makes projection fail.
    retiredTags: [retired.tag],
  };
}

/** Initialize only from a fresh native read. Does not adopt a legacy capture receipt. */
export function initializePairedWebLifecycle(
  context: Context,
  rawService: unknown,
  nativeRevisions: Record<string, unknown>,
  receipts: Receipts,
) {
  const traffic = (rawService as { traffic?: unknown })?.traffic;
  if (!Array.isArray(traffic) || traffic.length < 1 || traffic.length > 8)
    throw new Error('Initial native traffic inventory is unsupported');
  const rows = traffic as Array<Record<string, unknown>>;
  if (
    rows.some(
      (row) => row.tag !== HISTORICAL_WEB_TAGS[1]?.tag || row.revision !== context.canonical,
    ) ||
    rows.filter((row) => Number(row.percent) === 100).length !== 1
  )
    throw new Error('Initial native inventory must contain only the proven canonical web tag');
  const snapshot: Snapshot = projectNativeWebSnapshot(rawService, nativeRevisions, context);
  const state = captureLifecycle(context, snapshot);
  receipts.initialize(state);
  return state;
}

/** One native lifecycle phase per invocation. Hold state is rechecked before every phase. */
export async function runPairedWebLifecyclePhase(
  mode: Mode,
  reviewedAt: string,
  deps: FixtureDependencies,
  receipts: Receipts,
  verifyOperatorHold: (state: State) => Promise<void>,
) {
  if (!PHASES.includes(mode)) throw new Error('Invalid paired lifecycle phase');
  const state = receipts.readCurrent();
  await verifyOperatorHold(state);
  if (mode === 'createP' || mode === 'createR')
    return nativeWebCreationFixtureClient(deps).execute(state, mode, reviewedAt);
  return nativeWebTrafficFixtureClient(deps).execute(state, mode, reviewedAt);
}

/** Check the post-agent web snapshot against the completed retirement before opening R. */
export function acceptPairedAgentReadiness(state: State, fresh: Snapshot, receipts: Receipts) {
  if (reconciliationDigest(fresh) !== reconciliationDigest(state.snapshot))
    throw new Error('Paired agent readiness web snapshot changed');
  const evidence = {
    beforeReceipt: state.receipt,
    agentProofSha256: reconciliationDigest({
      source: state.context.source,
      runId: state.context.runId,
      attempt: state.context.attempt,
      manifest: state.context.manifest,
      marker: 'existing-agent-ready-and-live-web-probes-passed',
    }),
    stableEtag: fresh.etag,
    stableGeneration: fresh.generation,
  };
  const next = acceptAgentReady(state, evidence);
  receipts.recordCheckpoint(next);
  return next;
}
