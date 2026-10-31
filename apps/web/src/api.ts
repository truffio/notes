import type { Api, List, ListItem, MeResponse, Note, Page, Reminder, Tag } from '@notes/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(response.status, data?.error ?? 'Request failed');
  return data as T;
}

export const api = {
  login: (token: string) => request<Api['login']['response']>('POST', '/auth/login', { token }),
  logout: () => request<Api['logout']['response']>('POST', '/auth/logout', {}),
  me: async (): Promise<MeResponse> => {
    const me = await request<MeResponse>('GET', '/me');
    csrfToken = me.csrfToken;
    return me;
  },
  updateMe: (timezone: string) => request<MeResponse>('PATCH', '/me', { timezone }),
  listNotes: (query: Api['listNotes']['query'] = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params}` : '';
    return request<Page<Note>>('GET', `/notes${suffix}`);
  },
  createNote: (text: string) => request<Note>('POST', '/notes', { text }),
  updateNote: (id: string, text: string) => request<Note>('PATCH', `/notes/${id}`, { text }),
  deleteNote: (id: string) => request<{ ok: true }>('DELETE', `/notes/${id}`),
  listTags: () => request<{ items: Tag[] }>('GET', '/tags'),
  renameTag: (id: string, name: string) => request<Tag>('PATCH', `/tags/${id}`, { name }),
  deleteTag: (id: string) => request<{ ok: true }>('DELETE', `/tags/${id}`),
  listLists: () => request<{ items: List[] }>('GET', '/lists'),
  addListItem: (listId: string, text: string) => request<ListItem>('POST', `/lists/${listId}/items`, { text }),
  updateListItem: (id: string, checked: boolean) => request<ListItem>('PATCH', `/list-items/${id}`, { checked }),
  deleteListItem: (id: string) => request<{ ok: true }>('DELETE', `/list-items/${id}`),
  deleteList: (id: string) => request<{ ok: true }>('DELETE', `/lists/${id}`),
  listReminders: () => request<{ items: Reminder[] }>('GET', '/reminders'),
  cancelReminder: (id: string) => request<{ ok: true }>('DELETE', `/reminders/${id}`),
};
