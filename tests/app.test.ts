import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-db',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: { DB: { type: 'd1', name: 'notes-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env
beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  env = {
    DB: db as unknown as D1Database,
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

// This identity seam exists only in the app factory. The Worker entrypoint
// never reads these test headers and always calls the real auth SDK.
const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})
const call = (
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

test('unauthenticated data routes refuse access and public assets remain public', async () => {
  for (const [path, method] of [
    ['/api/notes', 'GET'],
    ['/api/notes', 'POST'],
    ['/api/notes/absent', 'PATCH'],
    ['/api/notes/absent', 'DELETE'],
  ]) {
    const response = await call(path!, undefined, method)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(await (await call('/')).text()).toBe('public page')
  expect((await call('/api/health')).status).toBe(200)
})

test('create, edit and delete are isolated by the authenticated owner', async () => {
  const created = await call('/api/notes', 'alice', 'POST', {
    content: '  First idea  ',
  })
  expect(created.status).toBe(201)
  const { note } = (await created.json()) as {
    note: { id: string; content: string }
  }
  expect(note.content).toBe('First idea')
  expect(
    ((await (await call('/api/notes', 'alice')).json()) as { notes: unknown[] })
      .notes,
  ).toHaveLength(1)
  expect(
    ((await (await call('/api/notes', 'bob')).json()) as { notes: unknown[] })
      .notes,
  ).toHaveLength(0)
  expect(
    (
      await call(`/api/notes/${note.id}`, 'bob', 'PATCH', {
        content: 'Taken over',
      })
    ).status,
  ).toBe(404)
  expect((await call(`/api/notes/${note.id}`, 'bob', 'DELETE')).status).toBe(
    404,
  )
  const updated = await call(`/api/notes/${note.id}`, 'alice', 'PATCH', {
    content: 'Revised idea',
  })
  expect(await updated.json()).toMatchObject({
    note: { content: 'Revised idea' },
  })
  expect((await call(`/api/notes/${note.id}`, 'alice', 'DELETE')).status).toBe(
    200,
  )
  expect(
    ((await (await call('/api/notes', 'alice')).json()) as { notes: unknown[] })
      .notes,
  ).toHaveLength(0)
})

test('rejects foreign and absent origins, owner spoofing, malformed input and oversized bodies', async () => {
  expect(
    (
      await call(
        '/api/notes',
        'alice',
        'POST',
        { content: 'bad' },
        'https://foreign.example',
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await app.request(
        'https://app.example.test/api/notes',
        { method: 'POST', headers: { 'test-user': 'alice' } },
        env,
      )
    ).status,
  ).toBe(403)
  for (const body of [
    { content: ' ' },
    { content: 1 },
    { content: 'x'.repeat(1001) },
    { content: 'hello', owner_sub: 'bob' },
    [],
    null,
  ]) {
    expect((await call('/api/notes', 'alice', 'POST', body)).status).toBe(400)
  }
  expect(
    (await call('/api/notes', 'alice', 'POST', { content: 'x'.repeat(10_000) }))
      .status,
  ).toBe(413)
  const malformed = await app.request(
    'https://app.example.test/api/notes',
    {
      method: 'POST',
      headers: {
        'test-user': 'alice',
        Origin: env.APP_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body: 'not JSON',
    },
    env,
  )
  expect(malformed.status).toBe(400)
})

test('missing database reports setup and local preview identity never activates on hosted origins', async () => {
  const noDb = await app.request(
    'https://app.example.test/api/notes',
    { headers: { 'test-user': 'alice' } },
    { ...env, DB: undefined },
  )
  expect(noDb.status).toBe(503)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})
