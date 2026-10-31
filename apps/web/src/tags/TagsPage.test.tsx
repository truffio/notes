// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.ts', async () => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { listTags: vi.fn(), renameTag: vi.fn(), deleteTag: vi.fn() } };
});

import { api, ApiError } from '../api.ts';
import { TagsPage } from './TagsPage.tsx';

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.listTags.mockResolvedValue({
    items: [
      { id: 't1', name: 'work', noteCount: 3 },
      { id: 't2', name: 'home', noteCount: 1 },
    ],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TagsPage', () => {
  it('lists tags with counts and selects one', async () => {
    const onSelectTag = vi.fn();
    render(<TagsPage onSelectTag={onSelectTag} />);
    fireEvent.click(await screen.findByText('#work'));
    expect(onSelectTag).toHaveBeenCalledWith('work');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('shows the 409 conflict inline on rename', async () => {
    mocked.renameTag.mockRejectedValue(new ApiError(409, 'Tag already exists'));
    render(<TagsPage />);
    fireEvent.click(await screen.findByLabelText('Rename work'));
    fireEvent.change(screen.getByLabelText('New name for work'), { target: { value: 'home' } });
    fireEvent.click(screen.getByText('Save'));
    expect((await screen.findByRole('alert')).textContent).toBe('Tag already exists');
  });

  it('renames a tag', async () => {
    mocked.renameTag.mockResolvedValue({ id: 't1', name: 'job', noteCount: 3 });
    render(<TagsPage />);
    fireEvent.click(await screen.findByLabelText('Rename work'));
    fireEvent.change(screen.getByLabelText('New name for work'), { target: { value: 'job' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('#job')).toBeTruthy();
  });

  it('deletes only after inline confirmation', async () => {
    mocked.deleteTag.mockResolvedValue({ ok: true });
    render(<TagsPage />);
    fireEvent.click(await screen.findByLabelText('Delete work'));
    expect(mocked.deleteTag).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm delete'));
    await waitFor(() => expect(mocked.deleteTag).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.queryByText('#work')).toBeNull());
  });
});
