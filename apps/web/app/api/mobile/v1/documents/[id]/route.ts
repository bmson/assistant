import { deleteDocument } from '@assistant/application/documents';
import { isModuleEnabled, loadConfig } from '@assistant/config';
import {
  documentDetailErrorResponse,
  documentPageOptionsFromUrl,
  readConfiguredDocument,
} from '@/lib/document-detail';
import { getFirestoreDocumentStores } from '@/lib/firestore-documents';
import { getApplication, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read one configured-owner document and its extracted passages. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid document id' }, { status: 400 });
  let options: ReturnType<typeof documentPageOptionsFromUrl>;
  try {
    options = documentPageOptionsFromUrl(request.url, id);
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'invalid page options' },
      { status: 400 },
    );
  }
  try {
    const result = await readConfiguredDocument(id, options);
    return result
      ? mobileJson(result)
      : mobileJson({ error: 'document not found' }, { status: 404 });
  } catch (error) {
    if (
      error instanceof Error &&
      ['DocumentChunkPageTooLargeError', 'DocumentChunkCursorStaleError'].includes(error.name)
    ) {
      return documentDetailErrorResponse(error);
    }
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Document detail could not be read.' },
      { status: 503 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return mobileJson({ error: 'invalid document id' }, { status: 400 });
  try {
    const result =
      config.PERSISTENCE_DRIVER === 'firestore'
        ? await deleteDocument(getFirestoreDocumentStores(), getWorkspace(), id)
        : await getApplication().deleteDocument(id);
    return mobileJson({ ok: true, pendingAssets: result.pendingAssets });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Document could not be deleted.' },
      { status: 409 },
    );
  }
}
