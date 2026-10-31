# Notes

A private, message-first notes app. Send a message to a Telegram bot and it is
saved, tagged and searchable. A web dashboard lets you search and browse, and
Claude can read your notes through an MCP server.

It is for one person or a small allowlist of Telegram accounts. There is no
public sign-up.

## Features

- Capture by Telegram message. Any text is saved, even if parsing fails.
- `#hashtags` organize notes. Tags are searchable and listed in the dashboard.
- Lists, such as `list groceries: milk, eggs`.
- Reminders, such as `remind me tomorrow at 9am to call Sam`.
- Link previews for URLs in a note.
- Web dashboard (React PWA) with the notes feed and search, plus tag and list
  pages. Reminders are managed in Telegram with `/reminders` and `/cancel`.
- Read-only MCP server so Claude can search and read your notes.

## Bot commands

Send these to the bot. Anything else is saved as a note.

| Command | What it does |
| --- | --- |
| `/login` | Sends a one-time link that opens the web dashboard. It expires in 10 minutes. |
| `/reminders` | Lists pending reminders. |
| `/cancel <number>` | Cancels a reminder by the number shown in `/reminders`. |
| `/timezone <name>` | Sets your timezone, such as `America/Toronto`. |
| `/mcptoken <name>` | Creates a token for Claude access. Shown once. |
| `/mcprevoke <name>` | Revokes that token. |
| `/help` or `/start` | Shows the help text. |

Only text messages are saved. Other message types get "Text only for now."

## Local setup (polling mode)

Requirements: Node.js 22 or newer. CI runs on Node 24.

1. Install dependencies from the repository root:

   ```sh
   npm ci
   ```

2. Create a bot with BotFather. Open a chat with [@BotFather](https://t.me/BotFather),
   send `/newbot`, and follow the prompts. It replies with a token. Keep it secret.

3. Find your numeric Telegram user id. Your username is not enough; the app
   checks the numeric id. Any bot that replies with user ids will do, such as
   [@userinfobot](https://t.me/userinfobot). That is a third-party bot, so use it
   with care, and check that the number it returns matches your account.

4. Create your settings file and fill in the three required values:

   ```sh
   cp .env.example .env
   ```

   - `TELEGRAM_BOT_TOKEN`: the token from BotFather.
   - `TELEGRAM_ALLOWED_USER_IDS`: your numeric id. Separate several ids with commas.
   - `BASE_URL`: `http://localhost:5173`, so the login link opens the Vite dev server.

   Everything in `.env.example` is documented there.

5. Make the variables visible to the server. The dev scripts do not read `.env`,
   so either export the variables in your shell, or start the server with Node's
   built-in loader from the repository root:

   ```sh
   node --env-file=.env --import tsx apps/server/src/index.ts
   ```

6. Start the server in one terminal:

   ```sh
   npm run dev:server
   ```

   It listens on `PORT` (default 3000) and, when `DATABASE_URL` is unset, keeps its
   PGlite database in `PGLITE_DATA_DIR` (default `.data/pglite`). It starts
   polling Telegram, because `TELEGRAM_WEBHOOK_SECRET` is unset.

7. Start the web app in a second terminal:

   ```sh
   npm run dev:web
   ```

   Vite serves the app on http://localhost:5173 and proxies `/api` to port 3000.

8. In Telegram, send `/login` to your bot and open the link. It opens on
   http://localhost:5173, because that is what `BASE_URL` says.

Checks:

```sh
npm run typecheck
npm run lint
npm test
```

## Production deployment

Production runs the server in **webhook mode** with the web app built into it,
using Docker Compose with Postgres.

### Webhook mode and https

Setting `TELEGRAM_WEBHOOK_SECRET` switches the bot from polling to webhook mode.
In that mode:

- `BASE_URL` must start with `https://`. The server refuses to start otherwise.
- At startup the server registers `${BASE_URL}/telegram/webhook` with Telegram,
  using the secret. Telegram sends the secret with every request, and the server
  rejects requests without it.
- Session cookies are marked `Secure` because `BASE_URL` is https.

Put a reverse proxy with a valid certificate in front of the app. Telegram only
delivers webhooks over https. The compose file publishes the app on
`127.0.0.1:3000`, so only the proxy on the same host can reach it. Example with
Caddy, which obtains the certificate itself:

```
notes.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Docker Compose

1. Create `.env` from `.env.example`. Set `BASE_URL` to your https address, set
   `TELEGRAM_WEBHOOK_SECRET` to 32 to 256 letters, digits, `_` or `-` (the server
   refuses to start otherwise; `openssl rand -hex 32` works), and set
   `POSTGRES_PASSWORD` to letters and digits only.

2. Build and start:

   ```sh
   docker compose up -d --build
   ```

The `app` service builds the image from the `Dockerfile`. It runs as a non-root
user, and the server applies database migrations when it starts. The `postgres`
service uses `postgres:17` and stores its data in the named volume `pgdata`.
`docker compose down` keeps that volume. `docker compose down -v` deletes it.

Postgres is also published on `127.0.0.1:5432` of the host, so a Claude MCP
server on that host can read the database. From another machine, reach it through
an SSH tunnel, for example `ssh -L 5432:127.0.0.1:5432 you@your-host`. Do not
publish the port on a public interface.

## Connecting Claude (MCP)

The MCP server is read-only. It exposes four tools: `search_notes`, `get_note`,
`list_tags` and `list_recent_notes`. It runs as a local process that Claude
starts over stdio.

1. In Telegram, send `/mcptoken <name>` to your bot, for example `/mcptoken laptop`.
   Copy the token it shows. It is not shown again, so keep it secret. To revoke it,
   send `/mcprevoke <name>`, then restart the MCP server, which checks its token
   only at startup.

2. Add the server to your Claude client's MCP configuration. Use absolute paths,
   and set `MCP_API_TOKEN` and the database variable. For a Docker deployment,
   `DATABASE_URL` points at the published Postgres port, using the same password
   as `.env`. For local polling mode, set `DATABASE_URL` to the database the
   server uses, or set `PGLITE_DATA_DIR` to the server's PGlite directory as an
   absolute path. Running the server and the MCP server against one PGlite
   directory at the same time has not been tested, so stop the server while
   you rely on it, or use Postgres.

   ```json
   {
     "mcpServers": {
       "notes": {
         "command": "node",
         "args": [
           "/absolute/path/to/notes/node_modules/tsx/dist/cli.mjs",
           "/absolute/path/to/notes/apps/mcp/src/index.ts"
         ],
         "env": {
           "MCP_API_TOKEN": "paste-the-token-from-mcptoken",
           "DATABASE_URL": "postgres://notes:your-password@127.0.0.1:5432/notes"
         }
       }
     }
   }
   ```

   On Windows, write the paths with forward slashes, or escape backslashes in the JSON.

The MCP server needs either `DATABASE_URL` or `PGLITE_DATA_DIR`. It exits at
startup if neither is set or if `MCP_API_TOKEN` is not a valid token.

## Known limitations

- **Telegram only.** Capture works only through Telegram. The web app and the
  MCP server read and search, and the web app can also create and edit notes.
- **Web-created notes do not create lists.** Lists are created when a Telegram
  message uses the `list name: items` form. A note created in the web app is
  saved as text with its tags, so `list ...` text is not turned into a list.
- **Login rate limiting uses the socket address, not `X-Forwarded-For`.** Each
  address may make 10 requests to `POST /api/auth/login` per minute. The count is
  kept in memory and resets when the server restarts. The server ignores
  `X-Forwarded-For`, because a client can set that header to anything. Behind a
  reverse proxy, every client arrives from the proxy's address and shares one
  limit, so 10 login requests from anyone in a minute block everyone else's login
  for the rest of that minute.
- **MCP tokens are checked only at startup.** A running MCP server keeps working
  after `/mcprevoke` until it restarts, and tokens do not expire.
- **Private chats only.** The bot ignores group chats, so login links and tokens
  are never posted to a group.
