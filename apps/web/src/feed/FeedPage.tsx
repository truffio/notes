import type { LinkPreview, Note } from '@notes/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api.ts';

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 250;

/** Only http and https links are rendered as anchors. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function Preview({ link }: { link: LinkPreview }) {
  const href = safeHref(link.url);
  const title = link.title ?? link.url;
  return (
    <div className="preview">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {title}
        </a>
      ) : (
        <span>{title}</span>
      )}
      {link.description ? <p className="muted">{link.description}</p> : null}
    </div>
  );
}

interface NoteCardProps {
  note: Note;
  onSaved: (note: Note) => void;
  onDeleted: (id: string) => void;
}

function NoteCard({ note, onSaved, onDeleted }: NoteCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateNote(note.id, text));
      setEditing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Delete this note?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteNote(note.id);
      onDeleted(note.id);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <article className="card note">
      {editing ? (
        <form onSubmit={save}>
          <textarea
            aria-label="Edit note"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
          />
          <p className="muted small">
            Existing tags are kept when you save. To remove a tag, use the Tags page.
          </p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(note.text);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="note-text">{note.text}</p>
      )}
      {note.tags.length > 0 ? (
        <ul className="tags" aria-label="Tags">
          {note.tags.map((tag) => (
            <li key={tag}>#{tag}</li>
          ))}
        </ul>
      ) : null}
      {note.links.map((link) => (
        <Preview key={link.url} link={link} />
      ))}
      <div className="row meta">
        <time className="muted small" dateTime={note.createdAt}>
          {formatDate(note.createdAt)}
        </time>
        {editing ? null : (
          <span className="row">
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => {
                setDraft(note.text);
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button type="button" className="link danger" disabled={busy} onClick={remove}>
              Delete
            </button>
          </span>
        )}
      </div>
      {error ? <p role="alert" className="error">{error}</p> : null}
    </article>
  );
}

export interface FeedPageProps {
  /** Tag name to filter by. */
  tag?: string;
  onClearTag?: () => void;
}

export function FeedPage({ tag, onClearTag }: FeedPageProps = {}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (after: string | null) => {
      const id = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const page = await api.listNotes({
          q: query || undefined,
          tag,
          cursor: after ?? undefined,
          limit: PAGE_SIZE,
        });
        if (id !== latest.current) return;
        setNotes((current) => (after ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        if (id !== latest.current) return;
        setError(errorMessage(e));
      } finally {
        if (id === latest.current) setLoading(false);
      }
    },
    [query, tag],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createNote(text);
      setDraft('');
      await load(null);
    } catch (e) {
      setCreateError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="page">
      <form className="card" onSubmit={create}>
        <textarea
          aria-label="New note"
          placeholder="Write a note. Use #tags to organise it."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
        />
        <div className="row">
          <button type="submit" className="primary" disabled={creating || !draft.trim()}>
            Add note
          </button>
        </div>
        {createError ? <p role="alert" className="error">{createError}</p> : null}
      </form>

      <input
        type="search"
        aria-label="Search notes"
        placeholder="Search notes"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {tag ? (
        <p className="filter">
          <span>Tag: #{tag}</span>
          <button type="button" onClick={onClearTag} aria-label="Clear tag filter">
            Clear
          </button>
        </p>
      ) : null}

      {error ? <p role="alert" className="error">{error}</p> : null}

      <div className="stack">
        {notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            onSaved={(saved) => setNotes((current) => current.map((n) => (n.id === saved.id ? saved : n)))}
            onDeleted={(id) => setNotes((current) => current.filter((n) => n.id !== id))}
          />
        ))}
      </div>

      {loading ? <p className="muted">Loading...</p> : null}
      {!loading && !error && notes.length === 0 ? (
        <p className="muted">{query || tag ? 'No notes match.' : 'No notes yet.'}</p>
      ) : null}
      {!loading && cursor ? (
        <button type="button" className="more" onClick={() => void load(cursor)}>
          Load more
        </button>
      ) : null}
    </section>
  );
}
