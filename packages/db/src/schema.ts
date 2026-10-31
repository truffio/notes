export const migrations: string[] = [
  `
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id text NOT NULL UNIQUE,
    display_name text NOT NULL DEFAULT '',
    timezone text NOT NULL DEFAULT 'UTC',
    created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
  );

  CREATE TABLE notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text text NOT NULL,
    source text NOT NULL,
    links jsonb NOT NULL DEFAULT '[]',
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
    created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
    updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
  );
  CREATE INDEX notes_user_created ON notes (user_id, created_at DESC, id DESC);
  CREATE INDEX notes_search ON notes USING gin (search);

  CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    UNIQUE (user_id, name)
  );

  CREATE TABLE note_tags (
    note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
  );
  CREATE INDEX note_tags_tag ON note_tags (tag_id);

  CREATE TABLE lists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    UNIQUE (user_id, name)
  );

  CREATE TABLE list_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    text text NOT NULL,
    checked boolean NOT NULL DEFAULT false,
    position bigint GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX list_items_list ON list_items (list_id, position);

  CREATE TABLE reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id uuid REFERENCES notes(id) ON DELETE SET NULL,
    text text NOT NULL,
    remind_at timestamptz NOT NULL,
    next_attempt_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    claimed_at timestamptz
  );
  CREATE INDEX reminders_due ON reminders (status, next_attempt_at);

  CREATE TABLE login_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  );

  CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token text NOT NULL,
    expires_at timestamptz NOT NULL
  );

  CREATE TABLE api_tokens (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );

  CREATE TABLE processed_updates (
    channel text NOT NULL,
    update_id text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel, update_id)
  );
  `,
];
