// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.ts', () => ({
  api: {
    listLists: vi.fn(),
    addListItem: vi.fn(),
    updateListItem: vi.fn(),
    deleteListItem: vi.fn(),
    deleteList: vi.fn(),
  },
}));

import { api } from '../api.ts';
import { ListsPage } from './ListsPage.tsx';

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.listLists.mockResolvedValue({
    items: [{ id: 'l1', name: 'groceries', items: [{ id: 'i1', text: 'milk', checked: false }] }],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ListsPage', () => {
  it('explains how to create lists when empty', async () => {
    mocked.listLists.mockResolvedValue({ items: [] });
    render(<ListsPage />);
    expect(await screen.findByText('list groceries: milk, eggs')).toBeTruthy();
  });

  it('checks an item optimistically', async () => {
    mocked.updateListItem.mockResolvedValue({ id: 'i1', text: 'milk', checked: true });
    render(<ListsPage />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(mocked.updateListItem).toHaveBeenCalledWith('i1', true);
  });

  it('rolls back when the update fails', async () => {
    mocked.updateListItem.mockRejectedValue(new Error('boom'));
    render(<ListsPage />);
    const box = (await screen.findByRole('checkbox')) as HTMLInputElement;
    fireEvent.click(box);
    await screen.findByRole('alert');
    expect(box.checked).toBe(false);
  });

  it('adds and removes items', async () => {
    mocked.addListItem.mockResolvedValue({ id: 'i2', text: 'eggs', checked: false });
    mocked.deleteListItem.mockResolvedValue({ ok: true });
    render(<ListsPage />);
    fireEvent.change(await screen.findByLabelText('Add item to groceries'), { target: { value: 'eggs' } });
    fireEvent.click(screen.getByText('Add'));
    expect(await screen.findByText('eggs')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove milk'));
    await waitFor(() => expect(screen.queryByText('milk')).toBeNull());
  });

  it('deletes a list only after inline confirmation', async () => {
    mocked.deleteList.mockResolvedValue({ ok: true });
    render(<ListsPage />);
    fireEvent.click(await screen.findByLabelText('Delete list groceries'));
    expect(mocked.deleteList).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm delete'));
    await waitFor(() => expect(mocked.deleteList).toHaveBeenCalledWith('l1'));
    await waitFor(() => expect(screen.queryByText('groceries')).toBeNull());
  });
});
