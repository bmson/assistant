export type MobilePeopleCursor = {
  version: 1;
  ownerId: string;
  name: string;
  id: string;
};

export function encodeMobilePeopleCursor(cursor: MobilePeopleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeMobilePeopleCursor(value: string, ownerId: string): MobilePeopleCursor {
  if (value.length > 1_024) throw new Error('Invalid people continuation');
  let cursor: unknown;
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid people continuation');
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    (cursor as MobilePeopleCursor).version !== 1 ||
    (cursor as MobilePeopleCursor).ownerId !== ownerId ||
    typeof (cursor as MobilePeopleCursor).name !== 'string' ||
    typeof (cursor as MobilePeopleCursor).id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      (cursor as MobilePeopleCursor).id,
    )
  )
    throw new Error('People continuation does not match this owner or is invalid');
  return cursor as MobilePeopleCursor;
}

export function parseMobilePeoplePageSize(value: string | null): number {
  if (value === null) return 50;
  if (!/^(?:[1-9]\d?|100)$/.test(value))
    throw new Error('People page size must be between 1 and 100');
  return Number(value);
}
