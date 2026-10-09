import { toPersonSummaryView } from '@assistant/application/people-view';
import { mobilePageMetadata } from '@/lib/mobile-document-pages';
import { parseMobilePeoplePageSize } from '@/lib/mobile-people-pages';
import { getMobilePeoplePage } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The People directory, with every label already rendered. The client sorts
 * and groups; it never formats a date or decides what a span may claim.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const params = new URL(request.url).searchParams;
  let limit: number;
  try {
    limit = parseMobilePeoplePageSize(params.get('limit'));
  } catch {
    return mobileJson({ error: 'People page size must be between 1 and 100' }, { status: 400 });
  }
  const rawCursor = params.get('cursor');
  try {
    const page = await getMobilePeoplePage({ limit, cursor: rawCursor });
    const generatedAt = new Date(page.generatedAt);
    return mobileJson({
      generatedAt: page.generatedAt,
      people: page.people.map((person) => toPersonSummaryView(person, generatedAt)),
      pagination: mobilePageMetadata({
        limit,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('continuation'))
      return mobileJson({ error: error.message }, { status: 400 });
    return mobileJson(
      { error: 'People are unavailable. Retry before viewing them.' },
      { status: 503 },
    );
  }
}
