import { useEffect, useState } from 'react';
import type { List } from '@notes/core';
import { api } from '../api.ts';
import './lists.css';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Shows every list with checkable items. Lists are created by messaging the bot. */
export function ListsPage() {
  const [lists, setLists] = useState<List[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listLists()
      .then((res) => {
        if (!cancelled) setLists(res.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setChecked(itemId: string, checked: boolean) {
    setLists((prev) =>
      prev?.map((l) => ({ ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, checked } : i)) })) ?? prev,
    );
  }

  async function toggle(itemId: string, checked: boolean) {
    setChecked(itemId, checked);
    setError(null);
    try {
      await api.updateListItem(itemId, checked);
    } catch (err) {
      setChecked(itemId, !checked);
      setError(errorMessage(err));
    }
  }

  async function addItem(list: List) {
    const text = (drafts[list.id] ?? '').trim();
    if (text === '') return;
    try {
      const item = await api.addListItem(list.id, text);
      setLists((prev) => prev?.map((l) => (l.id === list.id ? { ...l, items: [...l.items, item] } : l)) ?? prev);
      setDrafts((d) => ({ ...d, [list.id]: '' }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeItem(listId: string, itemId: string) {
    try {
      await api.deleteListItem(itemId);
      setLists((prev) =>
        prev?.map((l) => (l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l)) ?? prev,
      );
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function removeList(listId: string) {
    try {
      await api.deleteList(listId);
      setLists((prev) => prev?.filter((l) => l.id !== listId) ?? prev);
      setConfirmingId(null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (loadError) return <p className="lists-error" role="alert">{loadError}</p>;
  if (!lists) return <p className="lists-muted">Loading lists…</p>;

  return (
    <section className="lists-page">
      <h2>Lists</h2>
      {error && <p className="lists-error" role="alert">{error}</p>}
      {lists.length === 0 ? (
        <p className="lists-muted">
          No lists yet. Lists are created by messaging the bot, for example{' '}
          <code>list groceries: milk, eggs</code>.
        </p>
      ) : (
        lists.map((list) => (
          <article key={list.id} className="lists-card">
            <header className="lists-header">
              <h3>{list.name}</h3>
              {confirmingId === list.id ? (
                <span className="lists-confirm">
                  <span>Delete {list.name}?</span>
                  <button type="button" className="lists-danger" onClick={() => void removeList(list.id)}>
                    Confirm delete
                  </button>
                  <button type="button" onClick={() => setConfirmingId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" aria-label={`Delete list ${list.name}`} onClick={() => setConfirmingId(list.id)}>
                  Delete list
                </button>
              )}
            </header>
            <ul className="lists-items">
              {list.items.map((item) => (
                <li key={item.id} className={item.checked ? 'lists-item lists-done' : 'lists-item'}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={(e) => void toggle(item.id, e.target.checked)}
                    />
                    <span>{item.text}</span>
                  </label>
                  <button type="button" aria-label={`Remove ${item.text}`} onClick={() => void removeItem(list.id, item.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <form
              className="lists-add"
              onSubmit={(e) => {
                e.preventDefault();
                void addItem(list);
              }}
            >
              <input
                aria-label={`Add item to ${list.name}`}
                placeholder="Add item"
                value={drafts[list.id] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [list.id]: e.target.value }))}
              />
              <button type="submit">Add</button>
            </form>
          </article>
        ))
      )}
    </section>
  );
}
