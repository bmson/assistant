import path from 'node:path';

export interface WorkspacePort {
  read(relativePath: string): Promise<string>;
  write(relativePath: string, content: string): Promise<unknown>;
  readBytes(relativePath: string): Promise<Buffer>;
  writeBytes(relativePath: string, content: Buffer, contentType: string): Promise<unknown>;
  list(relativePath: string): Promise<Array<{ name: string; dir: boolean }>>;
  /** Bounded immediate-child listing. Cursors are opaque to application callers. */
  listPage?(
    relativePath: string,
    input: { cursor: string | null; limit: number },
  ): Promise<WorkspaceListPage>;
  delete(relativePath: string): Promise<void>;
}

export interface WorkspaceListPage {
  items: Array<{ name: string; dir: boolean }>;
  hasMore: boolean;
  nextCursor: string | null;
  consistency: 'process-snapshot' | 'provider-token';
}

/** Normalize an owner-controlled relative workspace path and reject traversal. */
export function safeWorkspacePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/')).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error('path escapes the workspace');
  }
  return normalized;
}
