import type { GoogleClient } from './client.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';

export type OwnerOnlyVerification = 'verified_owner_only' | 'not_owner_only' | 'unverified';

export type OwnerOnlyVerificationReason =
  | 'verified'
  | 'unexpected_principal'
  | 'inherited_permission'
  | 'permission_missing'
  | 'expected_identity_invalid'
  | 'malformed_permissions_response'
  | 'malformed_permission_entry'
  | 'invalid_pagination_token'
  | 'repeated_pagination_token'
  | 'pagination_limit_reached'
  | 'provider_error';

/** Contains no principal identifiers or provider error strings. */
export interface OwnerOnlyVerificationDiagnostic {
  status: OwnerOnlyVerification;
  reason: OwnerOnlyVerificationReason;
  permissionCount: number;
  pagesRead: number;
  fullPageCompletion: boolean;
  unexpectedPrincipal: boolean | null;
  inheritedPermission: boolean | null;
  missingExpectedPrincipal: boolean | null;
  malformedPermissionEntry: boolean;
}

interface DrivePermission {
  type?: unknown;
  emailAddress?: unknown;
  deleted?: unknown;
  permissionDetails?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPermission(value: unknown): value is DrivePermission {
  return isRecord(value);
}

function permissionInheritance(permission: DrivePermission): {
  inherited: boolean;
  malformed: boolean;
} {
  if (permission.permissionDetails === undefined) return { inherited: false, malformed: false };
  if (!Array.isArray(permission.permissionDetails)) return { inherited: true, malformed: true };
  let inherited = false;
  let malformed = false;
  for (const raw of permission.permissionDetails) {
    if (!isRecord(raw)) {
      inherited = true;
      malformed = true;
      continue;
    }
    if (raw.inherited !== undefined && typeof raw.inherited !== 'boolean') {
      inherited = true;
      malformed = true;
    } else if (raw.inherited === true) {
      inherited = true;
    }
    if (raw.inheritedFrom !== undefined && typeof raw.inheritedFrom !== 'string') {
      inherited = true;
      malformed = true;
    } else if (typeof raw.inheritedFrom === 'string' && raw.inheritedFrom.length > 0) {
      inherited = true;
    }
  }
  return { inherited, malformed };
}

function diagnostic(
  status: OwnerOnlyVerification,
  reason: OwnerOnlyVerificationReason,
  permissionCount: number,
  pagesRead: number,
  fullPageCompletion: boolean,
  flags: {
    unexpectedPrincipal?: boolean | null;
    inheritedPermission?: boolean | null;
    missingExpectedPrincipal?: boolean | null;
    malformedPermissionEntry?: boolean;
  } = {},
): OwnerOnlyVerificationDiagnostic {
  return {
    status,
    reason,
    permissionCount,
    pagesRead,
    fullPageCompletion,
    unexpectedPrincipal: flags.unexpectedPrincipal ?? null,
    inheritedPermission: flags.inheritedPermission ?? null,
    missingExpectedPrincipal: flags.missingExpectedPrincipal ?? null,
    malformedPermissionEntry: flags.malformedPermissionEntry ?? false,
  };
}

/**
 * Returns the unchanged owner-only decision plus privacy-safe diagnostics.
 * Principal values and provider error strings are intentionally discarded.
 */
export async function verifyOwnerOnlyDriveSharingWithDiagnostic(
  client: GoogleClient,
  fileId: string,
  botEmail: string,
  ownerEmail: string,
): Promise<OwnerOnlyVerificationDiagnostic> {
  const permissions: unknown[] = [];
  let pagesRead = 0;
  let incompleteReason: OwnerOnlyVerificationReason | undefined;
  const visitedTokens = new Set<string>();
  let pageToken: string | undefined;

  try {
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`${DRIVE}/${encodeURIComponent(fileId)}/permissions`);
      url.searchParams.set(
        'fields',
        'nextPageToken,permissions(type,emailAddress,deleted,permissionDetails(inherited,inheritedFrom))',
      );
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('supportsAllDrives', 'true');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response: unknown = await client.api<unknown>(url.toString());
      pagesRead += 1;
      if (!isRecord(response) || !Array.isArray(response.permissions)) {
        incompleteReason = 'malformed_permissions_response';
        break;
      }
      permissions.push(...response.permissions);
      if (response.nextPageToken !== undefined) {
        if (typeof response.nextPageToken !== 'string' || !response.nextPageToken) {
          incompleteReason = 'invalid_pagination_token';
          break;
        }
        if (visitedTokens.has(response.nextPageToken)) {
          incompleteReason = 'repeated_pagination_token';
          break;
        }
        pageToken = response.nextPageToken;
        visitedTokens.add(pageToken);
        if (page === 9) incompleteReason = 'pagination_limit_reached';
      } else {
        pageToken = undefined;
        break;
      }
    }
  } catch {
    incompleteReason = 'provider_error';
  }

  const allowed = new Set(
    [botEmail, ownerEmail].map((email) => email.trim().toLocaleLowerCase()).filter(Boolean),
  );
  const permissionRows: DrivePermission[] = [];
  let malformedPermissionEntry = false;
  for (const permission of permissions) {
    if (!isPermission(permission)) {
      malformedPermissionEntry = true;
      continue;
    }
    permissionRows.push(permission);
  }

  let hasUnexpectedPrincipal = false;
  let hasInheritedPermission = false;
  const observed = new Set<string>();
  for (const permission of permissionRows) {
    if (permission.deleted === true) continue;
    const email =
      typeof permission.emailAddress === 'string'
        ? permission.emailAddress.trim().toLocaleLowerCase()
        : '';
    const inheritance = permissionInheritance(permission);
    const inherited = inheritance.inherited;
    hasInheritedPermission ||= inherited;
    malformedPermissionEntry ||= inheritance.malformed;
    if (
      permission.type !== 'user' ||
      !email ||
      !allowed.has(email) ||
      (permission.deleted !== undefined && typeof permission.deleted !== 'boolean')
    ) {
      hasUnexpectedPrincipal = true;
      continue;
    }
    if (!inherited) observed.add(email);
  }
  if (malformedPermissionEntry) hasUnexpectedPrincipal = true;

  if (incompleteReason) {
    return diagnostic('unverified', incompleteReason, permissions.length, pagesRead, false, {
      unexpectedPrincipal: hasUnexpectedPrincipal ? true : null,
      inheritedPermission: hasInheritedPermission ? true : null,
      malformedPermissionEntry,
    });
  }
  if (allowed.size !== 2) {
    return diagnostic(
      'unverified',
      'expected_identity_invalid',
      permissions.length,
      pagesRead,
      true,
      {
        unexpectedPrincipal: hasUnexpectedPrincipal,
        inheritedPermission: hasInheritedPermission,
        malformedPermissionEntry,
      },
    );
  }

  const missingExpectedPrincipal = [...allowed].some((email) => !observed.has(email));
  if (hasInheritedPermission || hasUnexpectedPrincipal) {
    return diagnostic(
      'not_owner_only',
      hasInheritedPermission
        ? 'inherited_permission'
        : malformedPermissionEntry
          ? 'malformed_permission_entry'
          : 'unexpected_principal',
      permissions.length,
      pagesRead,
      true,
      {
        unexpectedPrincipal: hasUnexpectedPrincipal,
        inheritedPermission: hasInheritedPermission,
        missingExpectedPrincipal,
        malformedPermissionEntry,
      },
    );
  }
  if (missingExpectedPrincipal) {
    return diagnostic('unverified', 'permission_missing', permissions.length, pagesRead, true, {
      unexpectedPrincipal: false,
      inheritedPermission: false,
      missingExpectedPrincipal: true,
    });
  }
  return diagnostic('verified_owner_only', 'verified', permissions.length, pagesRead, true, {
    unexpectedPrincipal: false,
    inheritedPermission: false,
    missingExpectedPrincipal: false,
  });
}

/** Backwards-compatible enum-only API for callers that do not need diagnostics. */
export async function verifyOwnerOnlyDriveSharing(
  client: GoogleClient,
  fileId: string,
  botEmail: string,
  ownerEmail: string,
): Promise<OwnerOnlyVerification> {
  return (await verifyOwnerOnlyDriveSharingWithDiagnostic(client, fileId, botEmail, ownerEmail))
    .status;
}
