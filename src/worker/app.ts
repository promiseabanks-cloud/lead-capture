import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono, type Handler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import { ensureSchema, mapNote, type NoteRow } from './db'

type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: D1Database }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

/** Tests inject identities; production always uses the Freebuff SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  )
  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  app.use('/api/notes/*', async (c, next) => {
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  })

  app.get('/api/notes', async (c) => {
    const result = await c
      .get('db')
      .prepare(
        'SELECT id, content, created_at, updated_at FROM notes WHERE owner_sub = ? ORDER BY created_at DESC, id DESC LIMIT 100',
      )
      .bind(c.get('user').sub)
      .all<NoteRow>()
    return c.json({ notes: result.results.map(mapNote) })
  })

  const saveNote: Handler<AppContext> = async (c) => {
    const id = c.req.param('id')
    const body: unknown = await c.req.json().catch(() => null)
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'content') ||
      !('content' in body) ||
      typeof body.content !== 'string' ||
      !body.content.trim() ||
      body.content.trim().length > 1000
    )
      return c.json(
        { error: 'Write a note between 1 and 1000 characters.' },
        400,
      )
    const content = body.content.trim()
    const now = Date.now()
    const db = c.get('db')
    const owner = c.get('user').sub
    if (id) {
      const row = await db
        .prepare(
          'UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND owner_sub = ? RETURNING id, content, created_at, updated_at',
        )
        .bind(content, now, id, owner)
        .first<NoteRow>()
      return row
        ? c.json({ note: mapNote(row) })
        : c.json({ error: 'Note not found.' }, 404)
    }
    const note = {
      id: crypto.randomUUID(),
      content,
      createdAt: now,
      updatedAt: now,
    }
    await db
      .prepare(
        'INSERT INTO notes (id, owner_sub, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(note.id, owner, content, now, now)
      .run()
    return c.json({ note }, 201)
  }
  app.post('/api/notes', saveNote)
  app.patch('/api/notes/:id', saveNote)

  app.delete('/api/notes/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare('DELETE FROM notes WHERE id = ? AND owner_sub = ? RETURNING id')
      .bind(c.req.param('id'), c.get('user').sub)
      .first()
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'Note not found.' }, 404)
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
