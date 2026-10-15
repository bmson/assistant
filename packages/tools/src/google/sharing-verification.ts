import type { GoogleClient } from './client.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';

export type OwnerOnlyVerification = 'verified_owner_only' | 'not_owner_only' | 'unverified';

/**
 * Proves the active direct Drive permissions contain only the assistant and
 * configured owner. Unknown principal types, missing identity data, inherited
 * group/domain access, or API failure are deliberately not treated as private.
 */
export async function verifyOwnerOnlyDriveSharing(
  client: GoogleClient,
  fileId: string,
  botEmail: string,
  ownerEmail: string,
): Promise<OwnerOnlyVerification> {
  try {
    const permissions: Array<{
      type?: string;
      emailAddress?: string;
      deleted?: boolean;
      permissionDetails?: Array<{ inherited?: boolean; inheritedFrom?: string }>;
    }> = [];
    let pageToken: string | undefined;
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`${DRIVE}/${encodeURIComponent(fileId)}/permissions`);
      url.searchParams.set(
        'fields',
        'nextPageToken,permissions(type,emailAddress,deleted,permissionDetails(inherited,inheritedFrom))',
      );
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('supportsAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await client.api<{
        permissions?: Array<{
          type?: string;
          emailAddress?: string;
          deleted?: boolean;
          permissionDetails?: Array<{ inherited?: boolean; inheritedFrom?: string }>;
        }>;
        nextPageToken?: string;
      }>(url.toString());
      if (!Array.isArray(response.permissions)) return 'unverified';
      permissions.push(...response.permissions);
      pageToken = response.nextPageToken;
      if (!pageToken) {
        complete = true;
        break;
      }
    }
    if (!complete) return 'unverified';
    const allowed = new Set(
      [botEmail, ownerEmail].map((email) => email.trim().toLocaleLowerCase()).filter(Boolean),
    );
    if (allowed.size !== 2) return 'unverified';
    const observed = new Set<string>();
    let hasUnexpectedPrincipal = false;
    for (const permission of permissions) {
      if (permission.deleted === true) continue;
      const email = permission.emailAddress?.trim().toLocaleLowerCase();
      const inherited = permission.permissionDetails?.some(
        (detail) => detail.inherited === true || Boolean(detail.inheritedFrom),
      );
      if (inherited || permission.type !== 'user' || !email || !allowed.has(email)) {
        hasUnexpectedPrincipal = true;
        continue;
      }
      observed.add(email);
    }
    if (hasUnexpectedPrincipal) return 'not_owner_only';
    return [...allowed].every((email) => observed.has(email))
      ? 'verified_owner_only'
      : 'unverified';
  } catch {
    return 'unverified';
  }
}
