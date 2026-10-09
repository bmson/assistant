import type { Records } from './records.js';

export interface ImportOverviewData {
  sources: Records['importSources'][];
  quarantineBySource: Record<string, number>;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ImportSourcesPageInput {
  afterSource?: string;
  /** Optional source prefix omitted while paging, so excluded rows cannot hide later rows. */
  excludeSourcePrefix?: string;
  limit: number;
}

export interface ImportSourcePathsInput {
  workspacePaths: string[];
}

/** Owner-scoped import metadata and quarantine counts for workspace views. */
export interface ImportOverviewRepository {
  readonly kind: 'import-overview-repository';
  listPage(input: ImportSourcesPageInput): Promise<ImportOverviewData>;
  trackedWorkspacePaths(input: ImportSourcePathsInput): Promise<string[]>;
}

export function isImportOverviewRepository(value: unknown): value is ImportOverviewRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'import-overview-repository' &&
    'listPage' in value &&
    typeof value.listPage === 'function' &&
    'trackedWorkspacePaths' in value &&
    typeof value.trackedWorkspacePaths === 'function'
  );
}
