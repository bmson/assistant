import { describe, expect, it, vi } from 'vitest';
import { ownerEditorEmulatorAuth } from './owner-editor-emulator-auth.js';

describe('test-only Firestore emulator owner sentinel', () => {
  it('provides the emulator-recognized Bearer owner header without fetching or refreshing credentials', async () => {
    const client = ownerEditorEmulatorAuth('127.0.0.1:8798');
    const request = vi.spyOn(client.transporter, 'request').mockImplementation(() => {
      throw new Error('Test auth must never make a provider request');
    });
    expect((await client.getRequestHeaders()).get('authorization')).toBe('Bearer owner');
    expect((await client.getAccessToken()).token).toBe('owner');
    expect(client.credentials.refresh_token).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['firestore.googleapis.com:443', '169.254.169.254:80', '', 'localhost'])(
    'rejects non-loopback or missing-port host %s',
    (host) => {
      expect(() => ownerEditorEmulatorAuth(host)).toThrow('Local emulator required');
    },
  );
});
