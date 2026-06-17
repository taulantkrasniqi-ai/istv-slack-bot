# ISTV Slack Onboarding Bot

Node.js Slack bot for the InsideSuccess TV Shipping Department. It automates new-hire onboarding, monitors DLOA submissions, answers department questions from a local knowledge base, stores Zoom transcripts, and syncs selected workflow data with Monday.com.

The app is built with Express and deployed on Vercel through `api/index.js`.

## Features

- Slack Events API handler for app mentions, channel messages, DMs, and new workspace members.
- New-hire onboarding flow that creates a personal onboarding channel, invites users, posts welcome material, and updates Google Sheets.
- DLOA detection and analysis from Slack channel messages.
- Friday summary and daily DLOA reminder/missing-DLOA cron jobs.
- Knowledge base backed by local chunk storage in `knowledge/store.json`.
- Department document seeding from `docs/*.md` and `docs/*.txt`.
- Zoom webhook support for recording transcript ingestion.
- Make.com webhook support for triggering onboarding.
- Monday.com GraphQL sync for DLOA data.
- Vercel cron endpoint for polling Google Sheets every five minutes.

## Project Structure

```text
api/
  index.js          Express app, HTTP routes, Slack event routing
lib/
  channels.js       Slack channel names and personal channel naming
  claude.js         Anthropic/Claude prompts for DLOA analysis and Q&A
  cron.js           Scheduled jobs and DLOA tracking
  knowledge.js      Knowledge base storage, seeding, and search
  messages.js       Slack message templates
  monday.js         Monday.com GraphQL integration
  onboarding.js     New-hire onboarding orchestrator
  sheets.js         Google Sheets integration
  slack.js          Slack API helpers and DLOA detection
  test.js           Integration test runner
  zoom.js           Zoom webhook and transcript handling
docs/               Department source documents loaded into knowledge
knowledge/          Generated local knowledge store
```

## Requirements

- Node.js 18 or newer.
- Slack app with a bot token and signing secret.
- Google service account with access to the onboarding sheet.
- Anthropic API key.
- Monday.com API key and board ID, if DLOA sync is enabled.
- Zoom webhook credentials, if transcript ingestion is enabled.
- Vercel project for production deployment.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a local environment file:

```bash
cp .env.example .env
```

3. Fill in the values in `.env`.

Important variables:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `TAULANT_SLACK_ID`
- `TYLER_SLACK_ID`
- `ADMIN_CHANNEL_ID`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `ANTHROPIC_API_KEY`
- `MONDAY_API_KEY`
- `MONDAY_BOARD_ID`
- `ZOOM_VERIFICATION_TOKEN`
- `ZOOM_OAUTH_TOKEN`
- `ONBOARDING_PDF_URL`
- `ONBOARDING_FORM_URL`
- `WEBHOOK_SECRET`
- `CRON_SECRET`
- `PORT`
- `NODE_ENV`
- `ENABLE_CRON`

4. Seed the local knowledge base from `docs/`:

```bash
npm run seed-knowledge
```

5. Start the app locally:

```bash
npm run dev
```

By default the app listens on `http://localhost:3000`.

## Scripts

```bash
npm run dev
```

Starts the Express server with `node api/index.js`.

```bash
npm test
```

Runs integration checks in `lib/test.js`. These tests call real Slack and Google Sheets APIs, so valid `.env` credentials are required.

```bash
npm run seed-knowledge
```

Loads Markdown and text files from `docs/` into `knowledge/store.json`.

## HTTP Routes

Public health routes:

- `GET /` - returns app status, version, and enabled feature list.
- `GET /health` - returns `{ ok: true }`.

Slack:

- `POST /slack/events` - Slack Events API endpoint. Responds immediately and processes events asynchronously.

Make.com:

- `POST /webhook/new-hire` - triggers onboarding for a new hire.
- Body: `{ secret, name, role, email, slackEmail, startDate }`

Zoom:

- `POST /webhook/zoom` - receives Zoom webhook events and ingests recording transcripts.

Knowledge base:

- `GET /knowledge` - lists indexed documents. Requires `x-api-key: WEBHOOK_SECRET`.
- `POST /knowledge/add` - manually adds a document. Requires `x-api-key: WEBHOOK_SECRET`.
- `POST /knowledge/search` - searches knowledge. Requires `x-api-key: WEBHOOK_SECRET`.
- `DELETE /knowledge/:title` - deletes a document by title. Requires `x-api-key: WEBHOOK_SECRET`.

Manual triggers:

- `POST /trigger/onboard` - manually triggers onboarding for testing.
- `POST /trigger/zoom-transcript` - manually uploads a Zoom VTT transcript.

Cron:

- `GET /cron/poll` - polls Google Sheets for active hires with no onboarding channel. Requires `x-cron-secret: CRON_SECRET` or `?secret=CRON_SECRET`.

## Slack Behavior

- App mentions answer questions in a thread using the knowledge base.
- DMs answer new-hire questions using the knowledge base.
- Channel messages are checked with `looksLikeDLOA()` in `lib/slack.js`.
- DLOA submissions are reacted to, analyzed, synced to Monday.com, posted to the admin channel, and stored in the knowledge base.
- Slack event requests return `200 OK` before async processing to stay within Slack's response deadline.

## Onboarding Flow

Onboarding is handled in `lib/onboarding.js`.

The bot:

- Finds or creates the personal onboarding channel.
- Uses the `sd-[role-slug]-[firstname]` naming convention from `lib/channels.js`.
- Invites the new hire and required internal stakeholders.
- Adds the new hire to the universal department channels.
- Posts onboarding instructions and resources.
- Updates the Google Sheet with onboarding status.
- Sends admin alerts to `ADMIN_CHANNEL_ID`.

## Knowledge Base

The knowledge base stores chunked text in `knowledge/store.json`.

Sources include:

- Department docs in `docs/`.
- Zoom transcripts.
- DLOA submissions.
- Manually added documents.

The app currently uses Claude to score chunk relevance during search. Keep `docs/` concise and operationally useful because those files are seeded at startup and by `npm run seed-knowledge`.

## Deployment

The app is configured for Vercel with `vercel.json`.

Vercel settings:

- Build target: `api/index.js` through `@vercel/node`.
- All routes are sent to `api/index.js`.
- Cron schedule: `*/5 * * * *` for `/cron/poll`.
- Production env sets `NODE_ENV=production` and `ENABLE_CRON=true`.

Set all environment variables in the Vercel dashboard before deploying.

## Operational Guardrails

- Do not change the universal channel names in `lib/channels.js` without confirming the Slack workflow impact.
- Do not change DLOA reminder, missing-DLOA alert, or weekly summary times without approval.
- Keep business logic in `lib/`; keep `api/index.js` focused on routing and request handling.
- Add new environment variables to `.env.example`.
- Treat `npm test` as an integration test because it touches external services.

