export type Source = 'telegram' | 'web';

export interface User {
  id: string;
  telegramId: string;
  displayName: string;
  timezone: string;
  createdAt: string;
}

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
}

export interface Note {
  id: string;
  text: string;
  source: Source;
  tags: string[];
  links: LinkPreview[];
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  name: string;
  noteCount: number;
}

export interface ListItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface List {
  id: string;
  name: string;
  items: ListItem[];
}

export type ReminderStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface Reminder {
  id: string;
  userId: string;
  noteId: string | null;
  text: string;
  remindAt: string;
  status: ReminderStatus;
  attempts: number;
}
