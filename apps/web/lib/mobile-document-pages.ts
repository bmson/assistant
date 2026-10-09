export const MOBILE_DOCUMENT_PAGE_SIZE = 50;

export type MobileDocumentCursor = {
  version: 1;
  ownerId: string;
  id: string;
  createdAt: string;
};

export function encodeMobileDocumentCursor(cursor: MobileDocumentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMobileDocumentCursor(value: string, ownerId: string): MobileDocumentCursor {
  if (value.length > 1_024) throw new Error('Invalid document continuation');
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid document continuation');
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    (cursor as MobileDocumentCursor).version !== 1 ||
    (cursor as MobileDocumentCursor).ownerId !== ownerId ||
    typeof (cursor as MobileDocumentCursor).id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      (cursor as MobileDocumentCursor).id,
    ) ||
    typeof (cursor as MobileDocumentCursor).createdAt !== 'string' ||
    !Number.isFinite(Date.parse((cursor as MobileDocumentCursor).createdAt)) ||
    new Date((cursor as MobileDocumentCursor).createdAt).toISOString() !==
      (cursor as MobileDocumentCursor).createdAt
  )
    throw new Error('Document continuation does not match this owner or is invalid');
  return cursor as MobileDocumentCursor;
}

export function parseMobileDocumentPageSize(value: string | null): number {
  if (value === null) return MOBILE_DOCUMENT_PAGE_SIZE;
  if (!/^(?:[1-9]\d?|100)$/.test(value))
    throw new Error('Document page size must be between 1 and 100');
  return Number(value);
}

export function mobilePageMetadata(input: {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}) {
  return {
    version: 1,
    consistency: 'live-keyset',
    pageSize: input.limit,
    hasMore: input.hasMore,
    complete: !input.hasMore,
    nextCursor: input.nextCursor,
  } as const;
}
