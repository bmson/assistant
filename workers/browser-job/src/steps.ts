import { createHash } from 'node:crypto';
import path from 'node:path';
import { immutableArtifactPath } from '@assistant/persistence/artifact-path';
import type { Page } from 'playwright';
import type { BrowserStep } from './input.js';
import type { BlobStore } from './storage.js';

const STEP_TIMEOUT_MS = 20_000;
const EXTRACT_CHAR_LIMIT = 4_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const BROWSER_ATTACHMENT_PREFIX = 'browser/attachments/';

/** Defense in depth: the job can upload only purpose-staged attachments, never its profile or traces. */
function isAttachmentPath(workspacePath: string): boolean {
  if (!workspacePath.startsWith(BROWSER_ATTACHMENT_PREFIX) || workspacePath.includes('\\')) {
    return false;
  }
  const parts = workspacePath.split('/');
  return (
    parts.length >= 3 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function uploadMimeType(workspacePath: string): string {
  const extension = path.extname(workspacePath).toLowerCase();
  return (
    {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }[extension] ?? 'application/octet-stream'
  );
}

export interface StepOutput {
  index: number;
  action: string;
  ok: boolean;
  note?: string;
  /** extract */
  what?: string;
  text?: string;
  /** goto */
  url?: string;
  title?: string;
  /** screenshot */
  screenshotPath?: string;
  screenshotReceipt?: { sha256: string; bytes: number; executionId: string };
  error?: string;
}

export interface StepRunResult {
  outputs: StepOutput[];
  screenshots: string[];
  /** Set when a step failed and the rest of the plan was skipped. */
  failedAtStep?: number;
}

/**
 * Execute the approved plan verbatim — the worker adds no steps of its own.
 * A failing step stops the plan (later steps usually depend on earlier ones);
 * whatever was extracted up to that point still goes back in the result.
 */
export async function runSteps(
  page: Page,
  steps: BrowserStep[],
  opts: { taskId: string; executionId?: string; workspace: BlobStore },
): Promise<StepRunResult> {
  const outputs: StepOutput[] = [];
  const screenshots: string[] = [];

  for (const [index, step] of steps.entries()) {
    const base: StepOutput = { index, action: step.action, ok: true, note: step.note };
    try {
      switch (step.action) {
        case 'goto': {
          if (!step.url) throw new Error('goto needs a url');
          const url = new URL(step.url);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http(s) only');
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          outputs.push({ ...base, url: page.url(), title: await page.title() });
          break;
        }
        case 'waitFor': {
          if (step.selector) {
            await page
              .locator(step.selector)
              .first()
              .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
          } else {
            await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => {
              // busy pages never go idle — proceed with what's rendered
            });
          }
          outputs.push(base);
          break;
        }
        case 'extract': {
          let text: string;
          if (step.selector) {
            const texts = await page.locator(step.selector).allInnerTexts();
            text = texts.join('\n---\n');
          } else {
            text = await page.locator('body').innerText({ timeout: STEP_TIMEOUT_MS });
          }
          text = text.replace(/\n{3,}/g, '\n\n').trim();
          outputs.push({
            ...base,
            what: step.what,
            text:
              text.length > EXTRACT_CHAR_LIMIT
                ? `${text.slice(0, EXTRACT_CHAR_LIMIT)}\n…[truncated ${text.length} chars total]`
                : text,
          });
          break;
        }
        case 'screenshot': {
          const buffer = await page.screenshot({ fullPage: false });
          const digest = createHash('sha256').update(buffer).digest('hex');
          const executionId =
            opts.executionId ?? createHash('sha256').update(opts.taskId).digest('hex');
          const shotPath = immutableArtifactPath(
            'browser/shots/',
            executionId,
            digest,
            `${index}-${step.name ?? 'shot'}.png`,
          );
          await opts.workspace.put(shotPath, buffer, 'image/png');
          screenshots.push(shotPath);
          outputs.push({
            ...base,
            screenshotPath: shotPath,
            screenshotReceipt: { sha256: digest, bytes: buffer.length, executionId },
          });
          break;
        }
        case 'scroll': {
          await page.mouse.wheel(0, 1_200);
          await page.waitForTimeout(500);
          outputs.push(base);
          break;
        }
        case 'click': {
          if (!step.selector) throw new Error('click needs a selector');
          await page.locator(step.selector).first().click({ timeout: STEP_TIMEOUT_MS });
          outputs.push(base);
          break;
        }
        case 'type': {
          if (!step.selector) throw new Error('type needs a selector');
          await page
            .locator(step.selector)
            .first()
            .fill(step.text ?? '', {
              timeout: STEP_TIMEOUT_MS,
            });
          outputs.push(base);
          break;
        }
        case 'select': {
          if (!step.selector || step.value === undefined) {
            throw new Error('select needs selector + value');
          }
          await page.locator(step.selector).first().selectOption(step.value, {
            timeout: STEP_TIMEOUT_MS,
          });
          outputs.push(base);
          break;
        }
        case 'press': {
          if (!step.key) throw new Error('press needs a key');
          await page.keyboard.press(step.key);
          outputs.push(base);
          break;
        }
        case 'upload': {
          if (!step.selector || !step.workspacePath) {
            throw new Error('upload needs selector + workspacePath');
          }
          if (!isAttachmentPath(step.workspacePath)) {
            throw new Error(`upload path must be inside ${BROWSER_ATTACHMENT_PREFIX}`);
          }
          const file = await opts.workspace.get(step.workspacePath);
          if (!file) throw new Error(`workspace attachment not found: ${step.workspacePath}`);
          if (file.length > MAX_UPLOAD_BYTES) {
            throw new Error(`workspace attachment exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`);
          }
          await page
            .locator(step.selector)
            .first()
            .setInputFiles({
              name: path.basename(step.workspacePath),
              mimeType: uploadMimeType(step.workspacePath),
              buffer: file,
            });
          outputs.push(base);
          break;
        }
        default:
          throw new Error(`unknown action: ${(step as BrowserStep).action}`);
      }
    } catch (err) {
      outputs.push({ ...base, ok: false, error: String(err).slice(0, 500) });
      return { outputs, screenshots, failedAtStep: index };
    }
  }
  return { outputs, screenshots };
}
