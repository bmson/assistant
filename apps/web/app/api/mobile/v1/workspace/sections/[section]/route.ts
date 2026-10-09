import {
  type MobileWorkspacePageSection,
  parseMobileWorkspacePageLimit,
} from '@/lib/mobile-workspace-pages';
import { getMobileWorkspaceSectionPage } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

const SECTIONS = new Set<MobileWorkspacePageSection>([
  'chats',
  'skills',
  'anomalies',
  'improvements',
  'import-sources',
  'import-files',
]);

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ section: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { section: rawSection } = await context.params;
  if (!SECTIONS.has(rawSection as MobileWorkspacePageSection))
    return mobileJson({ error: 'Unknown workspace section' }, { status: 404 });
  const section = rawSection as MobileWorkspacePageSection;
  const url = new URL(request.url);
  const archivedValue = url.searchParams.get('archived');
  if (
    section === 'chats' &&
    archivedValue !== null &&
    archivedValue !== 'true' &&
    archivedValue !== 'false'
  )
    return mobileJson({ error: 'archived must be true or false' }, { status: 400 });
  if (section !== 'chats' && archivedValue !== null)
    return mobileJson({ error: 'archived is only valid for chats' }, { status: 400 });
  const archived = archivedValue === 'true';
  let limit: number;
  try {
    limit = parseMobileWorkspacePageLimit(url.searchParams.get('limit'));
  } catch {
    return mobileJson({ error: 'Workspace page size must be between 1 and 100' }, { status: 400 });
  }
  if ((section === 'import-sources' || section === 'import-files') && limit > 50)
    return mobileJson(
      { error: 'Import history page size must be between 1 and 50' },
      { status: 400 },
    );
  const rawCursor = url.searchParams.get('cursor');

  try {
    const page = await getMobileWorkspaceSectionPage({
      section,
      archived,
      limit,
      cursor: rawCursor,
    });
    const consistency = 'consistency' in page ? page.consistency : 'live-keyset';
    return mobileJson({
      section,
      items: page.items,
      pagination: {
        version: 1,
        consistency,
        pageSize: limit,
        hasMore: page.hasMore,
        complete: !page.hasMore,
        nextCursor: page.nextCursor,
      },
      availability: { status: 'available', version: 1 },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('continuation'))
      return mobileJson({ error: error.message }, { status: 400 });
    return mobileJson(
      {
        section,
        items: [],
        pagination: {
          version: 1,
          consistency: 'unavailable',
          pageSize: limit,
          hasMore: false,
          complete: false,
          nextCursor: null,
        },
        availability: {
          status: 'unavailable',
          version: 1,
          message: 'This section is unavailable. Retry to continue loading it.',
        },
      },
      { status: 503 },
    );
  }
}
