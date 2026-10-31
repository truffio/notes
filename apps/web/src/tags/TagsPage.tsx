import { useEffect, useState } from 'react';
import type { Tag } from '@notes/core';
import { api, ApiError } from '../api.ts';
import './tags.css';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Lists tags with counts. `onSelectTag` opens the feed filtered by that tag. */
export function TagsPage({ onSelectTag }: { onSelectTag?: (name: string) => void }) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listTags()
      .then((res) => {
        if (!cancelled) setTags(res.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function startRename(tag: Tag) {
    setRenamingId(tag.id);
    setDraft(tag.name);
    setRenameError(null);
    setConfirmingId(null);
  }

  async function submitRename(tag: Tag) {
    const name = draft.trim().replace(/^#/, '');
    if (name === '' || name === tag.name) {
      setRenamingId(null);
      return;
    }
    try {
      const updated = await api.renameTag(tag.id, name);
      setTags((prev) => prev?.map((t) => (t.id === tag.id ? { ...t, ...updated } : t)) ?? prev);
      setRenamingId(null);
      setRenameError(null);
    } catch (err) {
      setRenameError(err instanceof ApiError && err.status === 409 ? err.message : errorMessage(err));
    }
  }

  async function confirmDelete(tag: Tag) {
    try {
      await api.deleteTag(tag.id);
      setTags((prev) => prev?.filter((t) => t.id !== tag.id) ?? prev);
      setConfirmingId(null);
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  if (loadError) return <p className="tags-error" role="alert">{loadError}</p>;
  if (!tags) return <p className="tags-muted">Loading tags…</p>;

  return (
    <section className="tags-page">
      <h2>Tags</h2>
      {actionError && <p className="tags-error" role="alert">{actionError}</p>}
      {tags.length === 0 ? (
        <p className="tags-muted">No tags yet. Add a #hashtag to a message and it shows up here.</p>
      ) : (
        <ul className="tags-list">
          {tags.map((tag) => (
            <li key={tag.id} className="tags-row">
              {renamingId === tag.id ? (
                <form
                  className="tags-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitRename(tag);
                  }}
                >
                  <input
                    aria-label={`New name for ${tag.name}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoFocus
                  />
                  <button type="submit">Save</button>
                  <button type="button" onClick={() => setRenamingId(null)}>
                    Cancel
                  </button>
                  {renameError && <p className="tags-error" role="alert">{renameError}</p>}
                </form>
              ) : (
                <>
                  <button type="button" className="tags-name" onClick={() => onSelectTag?.(tag.name)}>
                    #{tag.name}
                    <span className="tags-count">{tag.noteCount}</span>
                  </button>
                  {confirmingId === tag.id ? (
                    <span className="tags-confirm">
                      <span>Delete #{tag.name}?</span>
                      <button type="button" className="tags-danger" onClick={() => void confirmDelete(tag)}>
                        Confirm delete
                      </button>
                      <button type="button" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="tags-actions">
                      <button type="button" aria-label={`Rename ${tag.name}`} onClick={() => startRename(tag)}>
                        Rename
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${tag.name}`}
                        onClick={() => {
                          setConfirmingId(tag.id);
                          setRenamingId(null);
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
