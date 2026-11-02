/** Unwired traffic-only client. Enum bounds do not broaden the existing retirement transport. */
import type { Mode, State } from './owner-web-release-lifecycle-model.js';
import {
  type FixtureDependencies,
  nativeFixtureSession,
} from './owner-web-release-native-session.js';
export type NativeTrafficMode = Exclude<Mode, 'createP' | 'createR'>;
export function nativeWebTrafficFixtureClient(deps: FixtureDependencies) {
  const session = nativeFixtureSession(deps, [
    'attachP',
    'promoteP',
    'attachR',
    'promoteR',
    'closeP',
    'restoreC',
    'repauseP',
    'closeR',
  ]);
  return {
    ...session,
    execute: (state: State, mode: NativeTrafficMode, reviewedAt: string) =>
      session.execute(state, mode, reviewedAt),
  };
}
