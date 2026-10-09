import { extractDocument } from './extract.js';
import { type JobInput, parseJobInput } from './input.js';
import { buildWorkspace } from './storage.js';

/**
 * The Workspace document-processor job (Phase 14). Credential-free by
 * construction: it receives a document reference + one-shot callback token via
 * env, reads the bytes from the agent's Workspace, extracts plain text (office
 * parsing; image/scanned-PDF OCR is a follow-up), uploads the text back to the
 * Workspace, and reports over a single HTTP callback. No database access, no API
 * keys. Always exits 0 — failure is a callback payload, not a job retry (the
 * document's staleness sweep covers total loss).
 */

interface JobResult {
  ok: boolean;
  kind: 'text' | 'unsupported' | 'error';
  chars: number;
  detail?: string;
  error?: string;
  durationMs?: number;
  [key: string]: unknown;
}

async function run(input: JobInput): Promise<JobResult> {
  const workspace = buildWorkspace(input.storage);
  const bytes = await workspace.get(input.source.workspacePath);
  if (!bytes) {
    return { ok: false, kind: 'error', chars: 0, error: 'source bytes not found in workspace' };
  }

  const outcome = await extractDocument(bytes, input.source.mime, input.source.title);
  if (outcome.kind === 'unsupported') {
    return { ok: false, kind: 'unsupported', chars: 0, error: outcome.detail };
  }

  // Even an empty parse is a success — the extract pipeline marks it ready/empty.
  const text = outcome.text.trim();
  await workspace.put(input.outputPath, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8');
  return {
    ok: true,
    kind: 'text',
    chars: text.length,
    detail: outcome.detail,
    structure: outcome.structure,
  };
}

async function postCallback(input: JobInput, result: JobResult): Promise<void> {
  const body = JSON.stringify({
    documentId: input.documentId,
    token: input.callbackToken,
    result,
  });
  const delaysMs = [0, 2_000, 5_000, 15_000];
  for (const [attempt, delay] of delaysMs.entries()) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(input.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      if (res.status !== 409 && res.status < 500) {
        console.error(`callback rejected: ${res.status} ${await res.text()}`);
        return;
      }
      console.error(`callback attempt ${attempt + 1} got ${res.status} — retrying`);
    } catch (err) {
      console.error(`callback attempt ${attempt + 1} failed: ${err}`);
    }
  }
  console.error('callback exhausted retries — the document will settle via its staleness sweep');
}

async function main(): Promise<void> {
  let input: JobInput;
  try {
    input = parseJobInput(process.env.DOCUMENT_JOB_INPUT);
  } catch (err) {
    console.error('invalid job input:', err);
    return;
  }

  const started = Date.now();
  const result = await run(input).catch(
    (err): JobResult => ({
      ok: false,
      kind: 'error',
      chars: 0,
      error: String(err).slice(0, 1000),
    }),
  );
  result.durationMs = Date.now() - started;
  console.log(
    JSON.stringify({
      msg: 'document job finished',
      documentId: input.documentId,
      ok: result.ok,
      kind: result.kind,
      chars: result.chars,
      durationMs: result.durationMs,
    }),
  );
  await postCallback(input, result);
}

await main();
process.exit(0);
