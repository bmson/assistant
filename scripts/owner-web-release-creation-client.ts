/** Unwired creation-only client. Mandatory fixture transport; no credential or runtime adapter. */
import type { State } from './owner-web-release-lifecycle-model.js';
import {
  type FixtureDependencies,
  nativeFixtureSession,
} from './owner-web-release-native-session.js';
export function nativeWebCreationFixtureClient(deps: FixtureDependencies) {
  const session = nativeFixtureSession(deps, ['createP', 'createR']);
  return {
    ...session,
    execute: (state: State, mode: 'createP' | 'createR', reviewedAt: string) =>
      session.execute(state, mode, reviewedAt),
  };
}
