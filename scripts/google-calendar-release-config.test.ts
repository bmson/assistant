import { describe, expect, it } from 'vitest';
import { pairedWebContext } from './owner-web-release-native-controller.js';

const input = {
  source: 'a'.repeat(40),
  runId: '123456',
  attempt: '1',
  manifestDigest: 'b'.repeat(64),
  manifest: {
    storageDriver: 'firestore',
    schemaVersion: 1,
    components: {
      web: {
        image: `us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:${'c'.repeat(64)}`,
        apiContract: 1,
        peerApi: { min: 1, max: 1 },
        schema: { min: 1, max: 1 },
      },
    },
  },
};

describe('protected Calendar release configuration', () => {
  it('leaves default context unchanged and binds only the explicit callback when enabled', () => {
    const disabled = pairedWebContext(input);
    expect(pairedWebContext({ ...input, googleCalendarOAuthCallbackUrl: '' })).toEqual(disabled);
    const callback = 'https://bot.bmson.com/api/oauth/google-calendar/callback';
    const enabled = pairedWebContext({ ...input, googleCalendarOAuthCallbackUrl: callback });
    const { GOOGLE_CALENDAR_OAUTH_CALLBACK_URL, ...releaseEnv } = enabled.releaseEnv;
    expect(GOOGLE_CALENDAR_OAUTH_CALLBACK_URL).toBe(callback);
    expect({ ...enabled, releaseEnv }).toEqual(disabled);
  });
  it('rejects malformed callback configuration at context construction', () => {
    expect(() =>
      pairedWebContext({ ...input, googleCalendarOAuthCallbackUrl: 'https://bot.bmson.com/wrong' }),
    ).toThrow(/exact HTTPS/);
  });
});
