// @vitest-environment jsdom
import type { Note } from '@notes/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.ts';
import { FeedPage, safeHref } from './FeedPage.tsx';

vi.mock('../api.ts', () => ({
  api: { listNotes: vi.fn(), createNote: vi.fn(), updateNote: vi.fn(), deleteNote: vi.fn() },
}));

const mocked = vi.mocked(api);

function note(id: string, text: string, extra: Partial<Note> = {}): Note {
  return {
    id,
    text,
    source: 'web',
    tags: [],
    links: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

beforeEach(() => {
  mocked.listNotes.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('FeedPage', () => {
  it('shows notes, tags and safe link previews, rendering text as text', async () => {
    mocked.listNotes.mockResolvedValue({
      items: [
        note('1', '<b>bold</b>', {
          tags: ['work'],
          links: [
            { url: 'https://example.com/a', title: 'Example', description: 'Desc' },
            { url: 'javascript:alert(1)', title: 'Evil', description: null },
          ],
        }),
      ],
      nextCursor: null,
    });
    const { container } = render(<FeedPage />);
    expect(await screen.findByText('<b>bold</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('#work')).toBeTruthy();
    expect(screen.getByText('Example').closest('a')?.getAttribute('href')).toBe('https://example.com/a');
    expect(screen.getByText('Evil').closest('a')).toBeNull();
  });

  it('only allows http and https hrefs', () => {
    expect(safeHref('http://a.com')).toBeTruthy();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('loads more pages using the cursor', async () => {
    mocked.listNotes
      .mockResolvedValueOnce({ items: [note('1', 'first')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [note('2', 'second')], nextCursor: null });
    render(<FeedPage />);
    fireEvent.click(await screen.findByText('Load more'));
    expect(await screen.findByText('second')).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    expect(mocked.listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' }));
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('searches as you type and ignores stale responses', async () => {
    let resolveSlow: (value: { items: Note[]; nextCursor: null }) => void = () => {};
    mocked.listNotes.mockImplementation((query) => {
      if (query?.q === 'a') return new Promise((resolve) => (resolveSlow = resolve));
      if (query?.q === 'ab') return Promise.resolve({ items: [note('2', 'fresh')], nextCursor: null });
      return Promise.resolve({ items: [], nextCursor: null });
    });
    render(<FeedPage />);
    const box = screen.getByLabelText('Search notes');
    fireEvent.change(box, { target: { value: 'a' } });
    await waitFor(() => expect(mocked.listNotes).toHaveBeenCalledWith(expect.objectContaining({ q: 'a' })));
    fireEvent.change(box, { target: { value: 'ab' } });
    expect(await screen.findByText('fresh')).toBeTruthy();
    resolveSlow({ items: [note('1', 'stale')], nextCursor: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.getByText('fresh')).toBeTruthy();
  });

  it('filters by tag and clears the filter', async () => {
    const onClearTag = vi.fn();
    render(<FeedPage tag="work" onClearTag={onClearTag} />);
    await waitFor(() => expect(mocked.listNotes).toHaveBeenCalledWith(expect.objectContaining({ tag: 'work' })));
    fireEvent.click(screen.getByLabelText('Clear tag filter'));
    expect(onClearTag).toHaveBeenCalled();
  });

  it('creates a note and reloads the feed', async () => {
    mocked.createNote.mockResolvedValue(note('9', 'new #x'));
    render(<FeedPage />);
    await screen.findByText('No notes yet.');
    mocked.listNotes.mockResolvedValue({ items: [note('9', 'new', { tags: ['x'] })], nextCursor: null });
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'new #x' } });
    fireEvent.click(screen.getByText('Add note'));
    expect(await screen.findByText('new')).toBeTruthy();
    expect(mocked.createNote).toHaveBeenCalledWith('new #x');
  });

  it('edits a note', async () => {
    mocked.listNotes.mockResolvedValue({ items: [note('1', 'old', { tags: ['t'] })], nextCursor: null });
    mocked.updateNote.mockResolvedValue(note('1', 'updated', { tags: ['t'] }));
    render(<FeedPage />);
    fireEvent.click(await screen.findByText('Edit'));
    expect(screen.getByText(/Existing tags are kept/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'updated' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('updated')).toBeTruthy();
    expect(mocked.updateNote).toHaveBeenCalledWith('1', 'updated');
  });

  it('deletes a note after confirmation', async () => {
    mocked.listNotes.mockResolvedValue({ items: [note('1', 'bye')], nextCursor: null });
    mocked.deleteNote.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FeedPage />);
    fireEvent.click(await screen.findByText('Delete'));
    await waitFor(() => expect(screen.queryByText('bye')).toBeNull());
    expect(mocked.deleteNote).toHaveBeenCalledWith('1');
  });
});
