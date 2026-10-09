export type TaskTimelineKind = 'approval' | 'message' | 'model' | 'tool';
export interface TaskTimelineCursor {
  version: 1;
  at: string;
  kind: TaskTimelineKind;
  id: string;
}
const kinds = new Set(['approval', 'message', 'model', 'tool']);
/** UTC nanosecond spelling preserves SQL microseconds and Firestore timestamps. */
export function timelineTime(at: Date): string {
  return at.toISOString().replace(/(\.\d{3})Z$/, '$1000000Z');
}
export function decodeTaskTimelineCursor(value: string): TaskTimelineCursor {
  try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      row.version !== 1 ||
      typeof row.at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/.test(row.at) ||
      !Number.isFinite(new Date(row.at).getTime()) ||
      new Date(row.at).toISOString().slice(0, 19) !== row.at.slice(0, 19) ||
      !kinds.has(row.kind) ||
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 256 ||
      [...row.id].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
    )
      throw new Error();
    return row;
  } catch {
    throw new Error('Invalid task timeline cursor');
  }
}
export function encodeTaskTimelineCursor(row: Omit<TaskTimelineCursor, 'version'>): string {
  return Buffer.from(JSON.stringify({ version: 1, ...row })).toString('base64url');
}
/** Every stream shares exactly this descending total order. */
export function compareTimelineRows(
  a: Omit<TaskTimelineCursor, 'version'>,
  b: Omit<TaskTimelineCursor, 'version'>,
): number {
  return a.at < b.at
    ? 1
    : a.at > b.at
      ? -1
      : a.kind < b.kind
        ? 1
        : a.kind > b.kind
          ? -1
          : a.id < b.id
            ? 1
            : a.id > b.id
              ? -1
              : 0;
}
