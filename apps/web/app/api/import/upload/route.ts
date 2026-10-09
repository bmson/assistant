import {
  DEFAULT_MAX_BODY_DURATION_MS,
  DEFAULT_MAX_MULTIPART_BODY_BYTES,
  readBoundedFormData,
} from '@assistant/application/http-body';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getImportCommands } from '@/lib/server';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Cloud Run request cap is 32MB — stay under it

function hasOnlyBoundedFields(form: FormData, file: File): boolean {
  const allowed = new Set(['file', 'source', 'voice', 'register']);
  for (const key of new Set([...form.keys()])) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) return false;
  }
  if (form.get('file') !== file) return false;
  const source = form.get('source');
  const voice = form.get('voice');
  const register = form.get('register');
  return (
    (source === null ||
      (typeof source === 'string' && new TextEncoder().encode(source).length <= 512)) &&
    (voice === null || (typeof voice === 'string' && voice.length <= 1)) &&
    (register === null || (typeof register === 'string' && register.length <= 64)) &&
    new TextEncoder().encode(file.name).length <= 255 &&
    file.type.length <= 256
  );
}

/**
 * Backstory archive upload: multipart form → immutable workspace upload →
 * import source + resumable job task. Bigger archives should be copied into
 * the bucket's import/ prefix directly (gcloud storage cp) and started from
 * the dashboard list instead.
 */
export async function POST(req: Request) {
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const bounded = await readBoundedFormData(
    req,
    DEFAULT_MAX_MULTIPART_BODY_BYTES,
    DEFAULT_MAX_BODY_DURATION_MS,
  );
  if (!bounded.ok) {
    const error =
      bounded.status === 413
        ? 'file too large for upload — copy it into the workspace import/ prefix instead'
        : bounded.status === 408
          ? 'upload request body took too long'
          : 'invalid multipart form';
    return Response.json({ error }, { status: bounded.status });
  }
  const form = bounded.value;
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: 'file too large for upload — copy it into the workspace import/ prefix instead' },
      { status: 413 },
    );
  }
  if (!hasOnlyBoundedFields(form, file)) {
    return Response.json({ error: 'invalid multipart form fields' }, { status: 400 });
  }

  const labelField = String(form.get('source') ?? '').trim();
  // Voice uploads seed the writing-sample corpus instead of memory; the Profile
  // page posts here with voice=1 and a register.
  const isVoice = String(form.get('voice') ?? '') === '1';

  const content = await file.text();
  const result = await getImportCommands().uploadImport({
    fileName: file.name,
    content,
    source: labelField,
    voice: isVoice,
    register: String(form.get('register') ?? ''),
  });

  redirect(result.destination);
}
