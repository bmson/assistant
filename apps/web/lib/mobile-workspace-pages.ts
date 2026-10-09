export const MOBILE_WORKSPACE_PAGE_LIMIT = 100;
export type MobileWorkspacePageSection =
  | 'chats'
  | 'skills'
  | 'anomalies'
  | 'improvements'
  | 'import-sources'
  | 'import-files';

export type MobileWorkspaceCursor = {
  version: 1;
  section: MobileWorkspacePageSection;
  ownerId: string;
  afterId: string;
  updatedAt?: string;
  archived?: boolean;
};

type PageCursor = MobileWorkspaceCursor;

export function encodeMobileWorkspaceCursor(cursor: MobileWorkspaceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMobileWorkspaceCursor(
  value: string,
  expected: { section: MobileWorkspacePageSection; ownerId: string; archived?: boolean },
): PageCursor {
  if (value.length > 8_192) throw new Error('Invalid workspace continuation');
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid workspace continuation');
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    (cursor as PageCursor).version !== 1 ||
    (cursor as PageCursor).section !== expected.section ||
    (cursor as PageCursor).ownerId !== expected.ownerId ||
    typeof (cursor as PageCursor).afterId !== 'string' ||
    (cursor as PageCursor).afterId.length === 0 ||
    (cursor as PageCursor).afterId.length >
      (expected.section === 'import-sources' || expected.section === 'import-files'
        ? 6_000
        : 4_096) ||
    (!['import-sources', 'import-files'].includes(expected.section) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        (cursor as PageCursor).afterId,
      ))
  )
    throw new Error('Workspace continuation does not match this owner and section');
  const parsed = cursor as PageCursor;
  if (expected.section === 'chats') {
    if (
      typeof parsed.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.updatedAt)) ||
      new Date(parsed.updatedAt).toISOString() !== parsed.updatedAt ||
      parsed.archived !== expected.archived
    )
      throw new Error('Invalid chat continuation');
  } else if (parsed.updatedAt !== undefined || parsed.archived !== undefined) {
    throw new Error('Invalid workspace continuation');
  }
  return parsed;
}

export function parseMobileWorkspacePageLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^(?:[1-9]\d?|100)$/.test(value)) throw new Error('Workspace page size must be 1–100');
  return Number(value);
}
