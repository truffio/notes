# Notes: delivery plan

A private, message-first notes app. Send a message, and it is saved, tagged and
searchable. Original product under its own name, inspired by the category; it
copies no branding, copy or assets from any existing app.

## Scope

In scope (v1): Telegram capture, hashtags, lists, link previews, reminders, a
web dashboard with search, read-only Claude access through MCP.

Out of scope (v1): SMS and WhatsApp, payments, public sign-up, native apps,
AI features inside the app.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| First channel | Telegram | Free, no carrier registration, works in minutes |
| Later channels | `Channel` interface | SMS/WhatsApp can be added without touching core |
| Users | Multi-user schema, allowlist at runtime | Personal first, no rewrite to open it up |
| Database | Plain Postgres | Runs on Supabase or anywhere else |
| Local and test database | PGlite | No Docker or accounts needed |
| Web login | One-time link from the bot (`/login`) | No passwords, identity already proven by Telegram |
| Search | Postgres full-text search | Enough for personal volume, no extra service |
| Language | TypeScript, npm workspaces | One language and shared types |

## Architecture

```
Telegram -> apps/server (grammY + Hono) -> packages/core -> packages/db -> Postgres
                 |  HTTP API                                  ^
                 v                                            |
            apps/web (React PWA)            apps/mcp (read-only tools)
```

| Path | Responsibility |
| --- | --- |
| `packages/core` | Pure logic: message parsing, tags, lists, time parsing, shared types |
| `packages/db` | Migrations and repositories; the only code that writes SQL |
| `apps/server` | Telegram channel, HTTP API, sessions, reminder worker, link enrichment |
| `apps/web` | React PWA dashboard |
| `apps/mcp` | Read-only MCP server, authenticated per user by token |

Rules that apply everywhere:

- A message is never lost. Any parsing or enrichment failure still saves a note.
- Every query is scoped by `user_id`.
- Secrets come from the environment and are never committed. This repo is public.
- Telegram handlers are idempotent on `update_id`, because Telegram redelivers.

## Parallel development

Work runs in three stages. Stage 1 is sequential because it fixes the contracts
everything else builds on. Stage 2 runs in parallel, each feature in its own git
worktree and pull request. Stage 3 integrates and reviews.

| Stage | Feature | Model | Why this level | Depends on |
| --- | --- | --- | --- | --- |
| 1 | F0.1 Monorepo, tooling, CI | Opus 5.5 | Sets conventions for everyone | none |
| 1 | F0.2 Contracts and schema | Opus 5.5 | Mistakes here multiply | F0.1 |
| 2 | F1.1 Message parser | Sonnet 5.5 | Well-defined logic with edge cases | F0.2 |
| 2 | F3.1 Reminder time parsing | Sonnet 5.5 | Timezones need care | F0.2 |
| 2 | F1.2 Telegram channel | Sonnet 5.5 | Integration with idempotency | F0.2 |
| 2 | F1.3 Link enrichment | Haiku 5.5 | Small, isolated, specified | F0.2 |
| 2 | F2.1 Auth and HTTP API | Opus 5.5 | Security-sensitive | F0.2 |
| 2 | F2.2 Feed and search UI | Sonnet 5.5 | Standard UI against a fixed API | F0.2 |
| 2 | F2.3 Tag views, lists, PWA | Sonnet 5.5 | Standard UI against a fixed API | F0.2 |
| 2 | F3.2 Reminder delivery | Sonnet 5.5 | Scheduling and retries | F0.2 |
| 2 | F4.1 Read-only MCP server | Sonnet 5.5 | Protocol integration | F0.2 |
| 3 | F5.1 Deployment and docs | Haiku 5.5 | Mechanical | Stage 2 |
| 3 | F5.2 End-to-end test and security review | Opus 5.5 | Judgment across the whole system | Stage 2 |

Parallel safety: each feature owns specific paths, listed in its issue. Stage 2
features code against the interfaces from F0.2 and do not change them; a needed
contract change goes back to the orchestrator. Opus 5.5 orchestrates, merges in
dependency order and resolves conflicts.

## Definition of done

- Typecheck, lint and tests pass in CI.
- Acceptance criteria in the issue are covered by tests.
- No secrets in the diff.
- Pull request merged and issue closed.

## What needs the owner

The code runs locally with a fake Telegram transport. Going live needs a bot
token from @BotFather, and a host and Postgres database for always-on use.
