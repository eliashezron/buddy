import { defineTool } from '@wa/core'
import { z } from 'zod'
import { googleApi } from './google-api.js'
import { trashFile } from './google-drive.js'

const SLIDES = 'https://slides.googleapis.com/v1/presentations'

const createdSchema = z.object({
  presentationId: z.string(),
  slides: z
    .array(
      z.object({
        objectId: z.string(),
        pageElements: z
          .array(z.object({ objectId: z.string(), shape: z.object({ placeholder: z.object({ type: z.string() }).optional() }).optional() }))
          .default([]),
      }),
    )
    .default([]),
})

type SlideInput = { title: string; bullets?: string[] | undefined }

/**
 * batchUpdate requests: fill the title slide Google creates, then one Title-and-body slide
 * per entry (Title-only when it has no bullets). Object ids are ours, so later requests
 * can refer to the shapes they just created.
 */
export function slideRequests(
  deckTitle: string,
  subtitle: string | undefined,
  first: { titleId?: string | undefined; subtitleId?: string | undefined },
  slides: SlideInput[],
) {
  const requests: object[] = []
  if (first.titleId) requests.push({ insertText: { objectId: first.titleId, text: deckTitle } })
  if (first.subtitleId && subtitle) requests.push({ insertText: { objectId: first.subtitleId, text: subtitle } })
  slides.forEach((slide, i) => {
    const id = `slide_${i}`
    const bullets = (slide.bullets ?? []).filter((b) => b.trim())
    requests.push({
      createSlide: {
        objectId: id,
        insertionIndex: i + 1,
        slideLayoutReference: { predefinedLayout: bullets.length ? 'TITLE_AND_BODY' : 'TITLE_ONLY' },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: 'TITLE' }, objectId: `${id}_title` },
          ...(bullets.length ? [{ layoutPlaceholder: { type: 'BODY' }, objectId: `${id}_body` }] : []),
        ],
      },
    })
    requests.push({ insertText: { objectId: `${id}_title`, text: slide.title } })
    if (bullets.length) {
      requests.push({ insertText: { objectId: `${id}_body`, text: bullets.join('\n') } })
      requests.push({
        createParagraphBullets: { objectId: `${id}_body`, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' },
      })
    }
  })
  return requests
}

export const createPresentation = defineTool({
  name: 'create_presentation',
  description:
    "Create a new Google Slides deck in the user's Drive: a title slide, then one slide per entry with a " +
    'title and short bullet points (keep bullets brief; 3 to 6 per slide). Private to the user; not shared. ' +
    'Only when the user asked for slides in their own message. Reply with the link. The user can undo for ' +
    '10 minutes. Asks the user to connect Google Drive if needed.',
  risk: 'low_write',
  input: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().max(200).optional(),
    slides: z
      .array(z.object({ title: z.string().min(1).max(200), bullets: z.array(z.string().max(300)).max(8).optional() }))
      .min(1)
      .max(25),
  }),
  preview: ({ title, slides }) => `Create a Slides deck "${title}" (${slides.length + 1} slides)`,
  async execute({ title, subtitle, slides }, ctx) {
    const created = await googleApi(ctx, ['drive.create'], SLIDES, { method: 'POST', schema: createdSchema, body: { title } })
    const placeholders = created.slides[0]?.pageElements ?? []
    const find = (...types: string[]) => placeholders.find((e) => types.includes(e.shape?.placeholder?.type ?? ''))?.objectId
    const requests = slideRequests(title, subtitle, { titleId: find('CENTERED_TITLE', 'TITLE'), subtitleId: find('SUBTITLE') }, slides)
    try {
      await googleApi(ctx, ['drive.create'], `${SLIDES}/${encodeURIComponent(created.presentationId)}:batchUpdate`, {
        method: 'POST',
        schema: z.unknown(),
        body: { requests },
      })
    } catch (err) {
      // Don't leave a half-built deck behind.
      await trashFile(ctx, created.presentationId).catch(() => {})
      throw err
    }
    return {
      ok: true as const,
      fileId: created.presentationId,
      title,
      slideCount: slides.length + 1,
      link: `https://docs.google.com/presentation/d/${created.presentationId}/edit`,
      sharedWithAnyone: false,
      undoableForMinutes: 10,
    }
  },
  async undo(result, ctx) {
    if (result.ok) await trashFile(ctx, result.fileId)
  },
})
