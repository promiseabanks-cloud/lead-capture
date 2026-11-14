import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Note, Session } from '../shared/types'
import './style.css'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => {
    throw new Error('Could not reach your workspace. Please try again.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const current = await request<Session>('/api/session')
        if (!live) return
        setSession(current)
        if (current.user && current.database) {
          const result = await request<{ notes: Note[] }>('/api/notes')
          if (live) setNotes(result.notes)
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof Error ? e.message : 'Could not load your workspace.',
          )
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const enabled = Boolean(loaded && session?.user && session.database)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!content.trim() || !enabled || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await request<{ note: Note }>(
        editing ? `/api/notes/${editing}` : '/api/notes',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        },
      )
      setNotes((previous) =>
        editing
          ? previous.map((note) => (note.id === editing ? result.note : note))
          : [result.note, ...previous].slice(0, 100),
      )
      setContent('')
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your note.')
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: string) {
    setBusy(true)
    setError('')
    try {
      await request(`/api/notes/${id}`, { method: 'DELETE' })
      setNotes((previous) => previous.filter((note) => note.id !== id))
      if (editing === id) {
        setEditing(null)
        setContent('')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your note.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <header>
        <span className="wordmark">Your workspace</span>
        <div className="account">
          {session?.mode === 'local' ? (
            <span className="badge">Local preview</span>
          ) : session?.user ? (
            <>
              <span>
                {session.user.name || session.user.email || 'Signed in'}
              </span>
              <form method="post" action="/auth/freebuff/signout">
                <button className="quiet">Sign out</button>
              </form>
            </>
          ) : session?.mode === 'freebuff' ? (
            <a className="button" href="/auth/freebuff/signin?returnTo=%2F">
              Sign in with Freebuff
            </a>
          ) : null}
        </div>
      </header>
      <div className="intro">
        <span className="eyebrow">A place to begin</span>
        <h1>
          Keep an idea.
          <br />
          Build from here.
        </h1>
        <p>A small workspace, ready to become your next app.</p>
      </div>
      {session?.mode === 'local' && (
        <p className="notice">
          Try the app here. Published projects use your Freebuff account.
        </p>
      )}
      {session && !enabled && (
        <p className="notice">
          {session.mode === 'setup' || !session.database
            ? 'This app is still being set up. Please try again later.'
            : 'Sign in with Freebuff to keep your own notes.'}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="workspace">
        <section className="editor" aria-labelledby="editor-title">
          <h2 id="editor-title">{editing ? 'Edit note' : 'New note'}</h2>
          <form onSubmit={save}>
            <label htmlFor="note">What’s on your mind?</label>
            <textarea
              id="note"
              required
              maxLength={1000}
              value={content}
              disabled={!enabled || busy}
              onChange={(e) => setContent(e.target.value)}
              placeholder="An idea, a reminder, a place to start…"
            />
            <div className="form-footer">
              <span>{content.length}/1000</span>
              <div>
                {editing && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null)
                      setContent('')
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button disabled={!enabled || busy || !content.trim()}>
                  {busy ? 'Saving…' : editing ? 'Save changes' : 'Add note'}
                </button>
              </div>
            </div>
          </form>
        </section>
        <section className="notes" aria-labelledby="notes-title">
          <div className="section-heading">
            <h2 id="notes-title">Your notes</h2>
            <span>{notes.length}</span>
          </div>
          {!loaded ? (
            <p className="empty">Loading your workspace…</p>
          ) : !notes.length ? (
            <div className="empty">
              <span aria-hidden="true">✳</span>
              <h3>Room for your first idea.</h3>
              <p>Add a note to start making this space yours.</p>
            </div>
          ) : (
            <ul>
              {notes.map((note) => (
                <li key={note.id}>
                  <p>{note.content}</p>
                  <div className="note-footer">
                    <time dateTime={new Date(note.createdAt).toISOString()}>
                      {new Date(note.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                    <div>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => {
                          setEditing(note.id)
                          setContent(note.content)
                          document
                            .querySelector<HTMLTextAreaElement>('#note')
                            ?.focus()
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => void remove(note.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
