import { describe, expect, it, vi } from 'vitest';
import { verifyOwnerOnlyDriveSharing } from './sharing-verification.js';

describe('verifyOwnerOnlyDriveSharing', () => {
  it('accepts only the assistant and configured owner', async () => {
    const client = {
      api: vi.fn().mockResolvedValue({
        permissions: [
          { type: 'user', emailAddress: 'BOT@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
          { type: 'user', emailAddress: 'removed@example.com', deleted: true },
        ],
      }),
    };
    await expect(
      verifyOwnerOnlyDriveSharing(
        client as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('verified_owner_only');
    const permissionsUrl = new URL(String(client.api.mock.calls[0]?.[0]));
    expect(permissionsUrl.pathname).toBe('/drive/v3/files/DocumentId12345/permissions');
    expect(permissionsUrl.searchParams.get('fields')).toBe(
      'nextPageToken,permissions(type,emailAddress,deleted,permissionDetails(inherited,inheritedFrom))',
    );
    expect(permissionsUrl.searchParams.get('pageSize')).toBe('100');
    expect(permissionsUrl.searchParams.get('supportsAllDrives')).toBe('true');
  });

  it.each([
    [{ type: 'user', emailAddress: 'other@example.com' }],
    [{ type: 'anyone', role: 'reader' }],
    [{ type: 'domain', domain: 'example.com', role: 'reader' }],
    [{ type: 'user' }],
  ])('does not treat unknown or broader permissions as owner-only: %j', async (permission) => {
    await expect(
      verifyOwnerOnlyDriveSharing(
        { api: vi.fn().mockResolvedValue({ permissions: [permission] }) } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('not_owner_only');
  });

  it('rejects permission inherited from a shared drive', async () => {
    await expect(
      verifyOwnerOnlyDriveSharing(
        {
          api: vi.fn().mockResolvedValue({
            permissions: [
              {
                type: 'user',
                emailAddress: 'bot@example.com',
                permissionDetails: [{ inherited: false }],
              },
              {
                type: 'user',
                emailAddress: 'owner@example.com',
                permissionDetails: [{ inherited: true, inheritedFrom: 'drive-folder-id' }],
              },
            ],
          }),
        } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('not_owner_only');
  });

  it('fails closed when identities or provider coverage are missing', async () => {
    await expect(
      verifyOwnerOnlyDriveSharing(
        { api: vi.fn().mockResolvedValue({}) } as never,
        'DocumentId12345',
        '',
        'owner@example.com',
      ),
    ).resolves.toBe('unverified');
    await expect(
      verifyOwnerOnlyDriveSharing(
        {
          api: vi.fn().mockResolvedValue({
            permissions: [{ type: 'user', emailAddress: 'bot@example.com' }],
          }),
        } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('unverified');
    await expect(
      verifyOwnerOnlyDriveSharing(
        { api: vi.fn().mockRejectedValue(new Error('forbidden')) } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('unverified');
    const paged = vi
      .fn()
      .mockResolvedValueOnce({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
        ],
        nextPageToken: 'more',
      })
      .mockResolvedValueOnce({
        permissions: [{ type: 'group', emailAddress: 'team@example.com' }],
      });
    await expect(
      verifyOwnerOnlyDriveSharing(
        { api: paged } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('not_owner_only');
    expect(paged).toHaveBeenCalledTimes(2);
  });

  it('fails closed when provider pagination repeats a token', async () => {
    const api = vi.fn().mockResolvedValue({
      permissions: [
        { type: 'user', emailAddress: 'bot@example.com' },
        { type: 'user', emailAddress: 'owner@example.com' },
      ],
      nextPageToken: 'same-page',
    });
    await expect(
      verifyOwnerOnlyDriveSharing(
        { api } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('unverified');
    expect(api).toHaveBeenCalledTimes(2);
  });
});
