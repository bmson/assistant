import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { toolOperationKey } from '../operation-identity.js';
import type { ToolRegistry } from '../registry.js';
import type { AssistantTool, ToolFlags } from '../types.js';
import { contentDigest, type GoogleClient } from './client.js';
import { renderSlideBody } from './docs-markdown.js';
import {
  checkpointGoogleEffect,
  type GoogleEffectReceipt,
  PartialGoogleArtifactError,
} from './effect-progress.js';

const CODE_FONT = 'Courier New';
const LINK_COLOR = { red: 0.06, green: 0.45, blue: 0.8 };

const SLIDES = 'https://slides.googleapis.com/v1/presentations';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

/** Presentation ids are URL path segments — constrain them to Google's alphabet. */
const presentationId = z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/, 'not a Google presentation id');
const slide = z.object({
  title: z.string().min(1).max(300),
  body: z
    .string()
    .max(15_000)
    .default('')
    .describe(
      'Slide body in Markdown — `-`/`*` bullets, **bold**, *italic*, `code`, and [links](https://…) render as real formatting. Keep it concise; one idea per bullet.',
    ),
});
const slideList = z.array(slide).min(1).max(30);

export interface SlidesToolDeps {
  client: GoogleClient;
  /** The presentation is created in the bot's Drive then shared with the owner. */
  ownerEmail: string;
}

interface Presentation {
  presentationId?: string;
  title?: string;
  slides?: Array<{ objectId?: string }>;
}

function register<S extends z.ZodType, Out>(
  registry: ToolRegistry,
  tool: AssistantTool<S, Out>,
  flags: ToolFlags = {},
) {
  registry.register(tool as unknown as AssistantTool, flags);
}

function presentationUrl(id: string): string {
  return `https://docs.google.com/presentation/d/${id}/edit`;
}

function objectPrefix(): string {
  return `assistant_${randomUUID().replaceAll('-', '')}`;
}

/** Build plain, readable slides without relying on a locale-specific template placeholder. */
export function buildSlideRequests(
  slides: z.infer<typeof slideList>,
  options: { deleteSlideId?: string; insertionIndex?: number } = {},
): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];
  if (options.deleteSlideId) requests.push({ deleteObject: { objectId: options.deleteSlideId } });

  const prefix = objectPrefix();
  for (const [index, content] of slides.entries()) {
    const slideId = `${prefix}_slide_${index}`;
    const titleId = `${prefix}_title_${index}`;
    const bodyId = `${prefix}_body_${index}`;
    requests.push(
      {
        createSlide: {
          objectId: slideId,
          ...(options.insertionIndex === undefined
            ? {}
            : { insertionIndex: options.insertionIndex + index }),
          slideLayoutReference: { predefinedLayout: 'BLANK' },
        },
      },
      {
        createShape: {
          objectId: titleId,
          shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: slideId,
            size: {
              width: { magnitude: 640, unit: 'PT' },
              height: { magnitude: 58, unit: 'PT' },
            },
            transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 36, unit: 'PT' },
          },
        },
      },
      { insertText: { objectId: titleId, insertionIndex: 0, text: content.title } },
      {
        updateTextStyle: {
          objectId: titleId,
          style: { bold: true, fontSize: { magnitude: 28, unit: 'PT' } },
          textRange: { type: 'ALL' },
          fields: 'bold,fontSize',
        },
      },
    );
    if (content.body) {
      const rendered = renderSlideBody(content.body);
      requests.push(
        {
          createShape: {
            objectId: bodyId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: 640, unit: 'PT' },
                height: { magnitude: 380, unit: 'PT' },
              },
              transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 122, unit: 'PT' },
            },
          },
        },
        { insertText: { objectId: bodyId, insertionIndex: 0, text: rendered.text } },
        {
          updateTextStyle: {
            objectId: bodyId,
            style: { fontSize: { magnitude: 17, unit: 'PT' } },
            textRange: { type: 'ALL' },
            fields: 'fontSize',
          },
        },
      );
      // Bullets first (they only tag paragraphs), then per-run emphasis over
      // FIXED_RANGE spans computed against the stripped body text.
      for (const range of rendered.bulletRanges) {
        requests.push({
          createParagraphBullets: {
            objectId: bodyId,
            textRange: { type: 'FIXED_RANGE', startIndex: range.start, endIndex: range.end },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
      }
      for (const span of rendered.spans) {
        const style: Record<string, unknown> = {};
        const fields: string[] = [];
        if (span.bold) {
          style.bold = true;
          fields.push('bold');
        }
        if (span.italic) {
          style.italic = true;
          fields.push('italic');
        }
        if (span.code) {
          style.fontFamily = CODE_FONT;
          fields.push('fontFamily');
        }
        if (span.link) {
          style.link = { url: span.link };
          style.underline = true;
          style.foregroundColor = { opaqueColor: { rgbColor: LINK_COLOR } };
          fields.push('link', 'underline', 'foregroundColor');
        }
        if (fields.length > 0) {
          requests.push({
            updateTextStyle: {
              objectId: bodyId,
              style,
              textRange: { type: 'FIXED_RANGE', startIndex: span.start, endIndex: span.end },
              fields: fields.join(','),
            },
          });
        }
      }
    }
  }
  return requests;
}

async function shareWithOwner(client: GoogleClient, id: string, ownerEmail: string): Promise<void> {
  await client.api(`${DRIVE}/${encodeURIComponent(id)}/permissions?sendNotificationEmail=false`, {
    method: 'POST',
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: ownerEmail }),
  });
}

export function registerSlidesTools(registry: ToolRegistry, deps: SlidesToolDeps): ToolRegistry {
  const createSchema = z.object({ title: z.string().min(1).max(300), slides: slideList });

  register(
    registry,
    {
      name: 'slides.create',
      description:
        "Create a Google Slides presentation in the assistant's Drive, populate it with a concise deck, and share it with the owner. Use this when the owner asks for a presentation, slide deck, briefing, or pitch. Each slide has a title and a Markdown body (bullets, bold, links render as real formatting).",
      inputSchema: createSchema,
      risk: 'autonomous',
      acceptsUntrustedInput: true,
      idempotencyKey: (args, ctx) => {
        const a = args as z.infer<typeof createSchema>;
        return toolOperationKey('slides-create', ctx, `slides-create-${ctx.taskId}-${a.title}`);
      },
      execute: async (args, ctx) => {
        const created = await deps.client.api<Presentation>(SLIDES, {
          method: 'POST',
          body: JSON.stringify({ title: args.title }),
        });
        const id = created.presentationId;
        if (!id) throw new Error('Slides API did not return a presentationId');
        const progress: GoogleEffectReceipt = {
          provider: 'google',
          kind: 'slides',
          objectId: id,
          stage: 'created',
        };
        try {
          await checkpointGoogleEffect(ctx, progress);
          const requests = buildSlideRequests(args.slides, {
            deleteSlideId: created.slides?.[0]?.objectId,
            insertionIndex: 0,
          });
          await deps.client.api(`${SLIDES}/${encodeURIComponent(id)}:batchUpdate`, {
            method: 'POST',
            body: JSON.stringify({ requests }),
          });
          progress.stage = 'filled';
          await checkpointGoogleEffect(ctx, progress);
          await shareWithOwner(deps.client, id, deps.ownerEmail);
          progress.stage = 'shared';
          await checkpointGoogleEffect(ctx, progress);
          return {
            presentationId: id,
            title: created.title ?? args.title,
            url: presentationUrl(id),
            slideCount: args.slides.length,
            sharedWith: deps.ownerEmail,
          };
        } catch (error) {
          throw new PartialGoogleArtifactError({ ...progress }, error);
        }
      },
    },
    { privateWrite: true },
  );

  const appendSchema = z.object({ presentationId, slides: slideList });
  register(
    registry,
    {
      name: 'slides.append',
      description:
        'Append one or more slides (title + Markdown body) to a Google Slides presentation the assistant can access.',
      inputSchema: appendSchema,
      risk: 'approval',
      acceptsUntrustedInput: true,
      approvalSummary: (input) => {
        const args = input as z.infer<typeof appendSchema>;
        return `Append ${args.slides.length} slides to ${presentationUrl(args.presentationId)} (visible to its current readers):\n\n${args.slides.map((slide) => `${slide.title}\n${slide.body}`).join('\n\n')}`;
      },
      // Append is non-idempotent: a crash-retry must not duplicate the slides.
      idempotencyKey: (args, ctx) => {
        const a = args as z.infer<typeof appendSchema>;
        return `slides-append-${ctx.taskId}-${a.presentationId}-${contentDigest(a.slides)}`;
      },
      execute: async (args) => {
        await deps.client.api(`${SLIDES}/${encodeURIComponent(args.presentationId)}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({ requests: buildSlideRequests(args.slides) }),
        });
        return {
          presentationId: args.presentationId,
          url: presentationUrl(args.presentationId),
          appendedSlides: args.slides.length,
        };
      },
    },
    { privateWrite: true, outwardFacing: true, networkEgress: true, blanketAllowIneligible: true },
  );

  return registry;
}
