import { isModuleEnabled, loadConfig } from '@assistant/config';
import { requireOwner } from '@/auth';
import {
  documentDetailErrorResponse,
  documentPageOptionsFromUrl,
  readConfiguredDocument,
} from '@/lib/document-detail';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireOwner();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents'))
    return Response.json({ error: 'documents module disabled' }, { status: 404 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: 'invalid document id' }, { status: 400 });
  let options: ReturnType<typeof documentPageOptionsFromUrl>;
  try {
    options = documentPageOptionsFromUrl(request.url, id);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'invalid page options' },
      { status: 400 },
    );
  }
  try {
    const result = await readConfiguredDocument(id, options);
    return result
      ? Response.json(result, { headers: { 'cache-control': 'no-store' } })
      : Response.json({ error: 'document not found' }, { status: 404 });
  } catch (error) {
    return documentDetailErrorResponse(error);
  }
}
