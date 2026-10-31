// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../api.ts';
import { App } from './App.tsx';

vi.mock('../api.ts', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: { login: vi.fn(), me: vi.fn(), listNotes: vi.fn() },
}));

vi.mock('../tags/TagsPage.tsx', () => ({
  TagsPage: ({ onSelectTag }: { onSelectTag?: (name: string) => void }) => (
    <button onClick={() => onSelectTag?.('work')}>pick work</button>
  ),
}));
vi.mock('../lists/ListsPage.tsx', () => ({ ListsPage: () => <p>lists page</p> }));

const mocked = vi.mocked(api);

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  mocked.me.mockResolvedValue({ user: { id: 'u', displayName: 'U', timezone: 'UTC' }, csrfToken: 'c' });
  mocked.listNotes.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('App', () => {
  it('shows the signed-out screen on 401', async () => {
    mocked.me.mockRejectedValue(new ApiError(401, 'no'));
    render(<App />);
    expect(await screen.findByText(/Send/)).toBeTruthy();
    expect(screen.getByText('/login')).toBeTruthy();
  });

  it('logs in from the URL token and clears it', async () => {
    window.history.replaceState(null, '', '/login#token=abc');
    mocked.login.mockResolvedValue({ ok: true });
    render(<App />);
    await screen.findByLabelText('New note');
    expect(mocked.login).toHaveBeenCalledWith('abc');
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('');
  });

  it('routes between pages and opens the feed filtered by a selected tag', async () => {
    render(<App />);
    await screen.findByLabelText('New note');
    fireEvent.click(screen.getByText('Lists'));
    expect(await screen.findByText('lists page')).toBeTruthy();
    expect(window.location.pathname).toBe('/lists');
    fireEvent.click(screen.getByText('Tags'));
    fireEvent.click(await screen.findByText('pick work'));
    expect(await screen.findByText('Tag: #work')).toBeTruthy();
    await waitFor(() => expect(mocked.listNotes).toHaveBeenLastCalledWith(expect.objectContaining({ tag: 'work' })));
    fireEvent.click(screen.getByLabelText('Clear tag filter'));
    await waitFor(() => expect(screen.queryByText('Tag: #work')).toBeNull());
    expect(window.location.search).toBe('');
  });
});
