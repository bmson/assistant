import { describe, expect, it, vi } from 'vitest';
import {
  verifyOwnerOnlyDriveSharing,
  verifyOwnerOnlyDriveSharingWithDiagnostic,
} from './sharing-verification.js';

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
      'nextPageToken,permissions(type,emailAddress,deleted,view,permissionDetails(inherited,inheritedFrom))',
    );
    expect(permissionsUrl.searchParams.get('pageSize')).toBe('100');
    expect(permissionsUrl.searchParams.get('supportsAllDrives')).toBe('true');
    expect(permissionsUrl.searchParams.get('includePermissionsForView')).toBe('published');
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

  it('allows a known principal with inherited and direct grants', async () => {
    await expect(
      verifyOwnerOnlyDriveSharing(
        {
          api: vi.fn().mockResolvedValue({
            permissions: [
              { type: 'user', emailAddress: 'bot@example.com' },
              {
                type: 'user',
                emailAddress: 'owner@example.com',
                permissionDetails: [
                  { permissionType: 'member', inherited: true, inheritedFrom: 'drive-id' },
                  { permissionType: 'file', inherited: false },
                ],
              },
            ],
          }),
        } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('verified_owner_only');
  });

  it('still rejects an inherited grant to an unexpected principal', async () => {
    await expect(
      verifyOwnerOnlyDriveSharing(
        {
          api: vi.fn().mockResolvedValue({
            permissions: [
              { type: 'user', emailAddress: 'bot@example.com' },
              { type: 'user', emailAddress: 'owner@example.com' },
              {
                type: 'user',
                emailAddress: 'unexpected@example.com',
                permissionDetails: [{ permissionType: 'member', inherited: true }],
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

  it.each([
    { type: 'anyone', role: 'reader', view: 'published' },
    { type: 'group', emailAddress: 'team@example.com', role: 'reader', view: 'published' },
    { type: 'user', emailAddress: 'unexpected@example.com', role: 'reader', view: 'published' },
  ])('rejects published-view permissions: %j', async (publishedPermission) => {
    await expect(
      verifyOwnerOnlyDriveSharing(
        {
          api: vi.fn().mockResolvedValue({
            permissions: [
              { type: 'user', emailAddress: 'bot@example.com' },
              { type: 'user', emailAddress: 'owner@example.com' },
              publishedPermission,
            ],
          }),
        } as never,
        'DocumentId12345',
        'bot@example.com',
        'owner@example.com',
      ),
    ).resolves.toBe('not_owner_only');
  });

  it('does not treat a metadata-only view for an allowed principal as an extra audience', async () => {
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      {
        api: vi.fn().mockResolvedValue({
          permissions: [
            { type: 'user', emailAddress: 'bot@example.com' },
            { type: 'user', emailAddress: 'owner@example.com', view: 'metadata' },
          ],
        }),
      } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );

    expect(result).toMatchObject({
      status: 'verified_owner_only',
      reason: 'verified',
      permissionCount: 2,
      unexpectedPrincipal: false,
      malformedPermissionEntry: false,
    });
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

describe('privacy-safe owner-only diagnostics', () => {
  it('reports an unexpected active permission without retaining its identity', async () => {
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      {
        api: vi.fn().mockResolvedValue({
          permissions: [
            { type: 'user', emailAddress: 'bot@example.com' },
            { type: 'user', emailAddress: 'owner@example.com' },
            { type: 'user', emailAddress: 'unexpected-private@example.com' },
          ],
        }),
      } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );

    expect(result).toEqual({
      status: 'not_owner_only',
      reason: 'unexpected_principal',
      permissionCount: 3,
      pagesRead: 1,
      fullPageCompletion: true,
      unexpectedPrincipal: true,
      inheritedPermission: false,
      missingExpectedPrincipal: false,
      malformedPermissionEntry: false,
    });
    expect(JSON.stringify(result)).not.toContain('@');
  });

  it('preserves inherited-source diagnostics for an allowed principal without failing privacy', async () => {
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      {
        api: vi.fn().mockResolvedValue({
          permissions: [
            {
              type: 'user',
              emailAddress: 'bot@example.com',
              permissionDetails: [
                { permissionType: 'member', inherited: true, inheritedFrom: 'private-drive-id' },
                { permissionType: 'file', inherited: false },
              ],
            },
            {
              type: 'user',
              emailAddress: 'owner@example.com',
            },
          ],
        }),
      } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );

    expect(result).toMatchObject({
      status: 'verified_owner_only',
      reason: 'verified',
      permissionCount: 2,
      pagesRead: 1,
      fullPageCompletion: true,
      unexpectedPrincipal: false,
      inheritedPermission: true,
      missingExpectedPrincipal: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-drive-id');
  });

  it('records malformed responses and entries without exposing their contents', async () => {
    const response = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      { api: vi.fn().mockResolvedValue({ permissions: 'unavailable@example.com' }) } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );
    expect(response).toMatchObject({
      status: 'unverified',
      reason: 'malformed_permissions_response',
      permissionCount: 0,
      pagesRead: 1,
      fullPageCompletion: false,
    });

    const entry = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      { api: vi.fn().mockResolvedValue({ permissions: [null] }) } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );
    expect(entry).toMatchObject({
      status: 'not_owner_only',
      reason: 'malformed_permission_entry',
      permissionCount: 1,
      fullPageCompletion: true,
      unexpectedPrincipal: true,
      malformedPermissionEntry: true,
    });
  });

  it('treats malformed inheritance metadata as unverified inherited access', async () => {
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      {
        api: vi.fn().mockResolvedValue({
          permissions: [
            { type: 'user', emailAddress: 'bot@example.com' },
            {
              type: 'user',
              emailAddress: 'owner@example.com',
              permissionDetails: [{ inherited: 'false' }],
            },
          ],
        }),
      } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );
    expect(result).toMatchObject({
      status: 'not_owner_only',
      reason: 'malformed_permission_entry',
      fullPageCompletion: true,
      inheritedPermission: true,
      malformedPermissionEntry: true,
    });
  });

  it('fails closed on an unknown permission view', async () => {
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      {
        api: vi.fn().mockResolvedValue({
          permissions: [
            { type: 'user', emailAddress: 'bot@example.com', view: 'unrecognized' },
            { type: 'user', emailAddress: 'owner@example.com' },
          ],
        }),
      } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );

    expect(result).toMatchObject({
      status: 'not_owner_only',
      reason: 'malformed_permission_entry',
      unexpectedPrincipal: true,
      malformedPermissionEntry: true,
    });
  });

  it('keeps incomplete pagination distinct and leaves absence flags unknown', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
        ],
        nextPageToken: 'same-page',
      })
      .mockResolvedValueOnce({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
        ],
        nextPageToken: 'same-page',
      });
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      { api } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );

    expect(result).toEqual({
      status: 'unverified',
      reason: 'repeated_pagination_token',
      permissionCount: 4,
      pagesRead: 2,
      fullPageCompletion: false,
      unexpectedPrincipal: null,
      inheritedPermission: null,
      missingExpectedPrincipal: null,
      malformedPermissionEntry: false,
    });
  });

  it('preserves sanitized evidence from completed pages when a later provider request fails', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
          { type: 'user', emailAddress: 'unexpected-private@example.com' },
        ],
        nextPageToken: 'more',
      })
      .mockRejectedValueOnce(new Error('private provider details'));
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      { api } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );

    expect(result).toMatchObject({
      status: 'unverified',
      reason: 'provider_error',
      permissionCount: 3,
      pagesRead: 1,
      fullPageCompletion: false,
      unexpectedPrincipal: true,
      inheritedPermission: null,
      missingExpectedPrincipal: null,
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('reports when the pagination safety limit prevents a complete ACL scan', async () => {
    const api = vi.fn().mockImplementation((url: string) => {
      const pageToken = new URL(url).searchParams.get('pageToken');
      const page = pageToken ? Number(pageToken) : 0;
      return Promise.resolve({
        permissions: [
          { type: 'user', emailAddress: 'bot@example.com' },
          { type: 'user', emailAddress: 'owner@example.com' },
        ],
        nextPageToken: String(page + 1),
      });
    });
    const result = await verifyOwnerOnlyDriveSharingWithDiagnostic(
      { api } as never,
      'DocumentId12345',
      'bot@example.com',
      'owner@example.com',
    );
    expect(result).toMatchObject({
      status: 'unverified',
      reason: 'pagination_limit_reached',
      permissionCount: 20,
      pagesRead: 10,
      fullPageCompletion: false,
      missingExpectedPrincipal: null,
    });
    expect(api).toHaveBeenCalledTimes(10);
  });
});
