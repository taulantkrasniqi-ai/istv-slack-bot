# ISTV Slack Bot — Codex Context

## What this project is

This is the AI brain for the InsideSuccess TV Shipping Department. It is a Node.js Slack bot deployed on Vercel that automates the entire AI department onboarding process, reads and analyses DLOAs, answers questions from a RAG knowledge base built from department documents and Zoom transcripts, syncs with Monday.com, and replaces most manual work that Taulant Krasniqi and Tyler Mills currently do.

## Who is involved

- **Tyler Mills** — Chief of Staff, CEO's right hand. Runs the AI department. Makes all keeper/cut decisions. Fast-paced, expects results not updates.
- **Taulant Krasniqi** — HR and Recruiting. Manages onboarding. Sends Slack invites via Make.com. Uses this bot daily.
- **CEO: Rudy Mawer** — Builds the Netflix of Business TV.
- **New hires** — Start at $7/hr work trial. 90-day binary keeper/cut decision. High turnover by design.

## The department's operating principles (critical context)

- High turnover is by design. Most hires are probes.
- DLOA = Daily List of Activities. Posted every day by 5pm EST in #sd-dloa-tyler. Missing it is serious.
- Joints not welds: all work must be documented well enough that someone else can take over in one day.
- 90-day keeper decision is binary: keep or cut. Fine is a cut.
- Documentation is a first-class deliverable from day one.
- Tyler gives vision, not steps. Builders figure out the execution.
- All times are EST. Always.

## Slack channel structure

### Universal channels — every new hire joins all of these
- `#sd-main-tyler` — primary department channel
- `#sd-recruiting-ai-taulant` — HR and recruiting
- `#sd-notion-knowledge-layer-adrian` — knowledge layer
- `#sd-dloa-tyler` — daily DLOA submissions
- `#sd-github-tyler` — GitHub activity
- `#sd-idea-dump-tyler` — ideas and experiments
- `#sd-system-admin-tyler` — system admin
- `#sd-feature-docs-sri` — feature docs
- `#sd-intercom-customer-service-saqlain` — customer service
- `#sd-deployment-jaya` — deployments
- `#sd-sales-syed` — sales

### Personal onboarding channel naming
Format: `sd-[role-slug]-[firstname]`
- AI Chief of Staff Assistant → `sd-chiefofstaff-[name]`
- AI-native Operations Engineer Generalist → `sd-operations-[name]`
- AI Knowledge Systems Engineer → `sd-knowledge-[name]`
- AI Tools Deployment Engineer → `sd-deployment-[name]`
- AI Designer → `sd-designer-[name]`

### Admin channel
- `#ai-onboarding-updates` — where bot sends alerts to Taulant and Tyler only

## File structure

```
istv-slack-bot/
├── AGENTS.md                  ← YOU ARE HERE. Read this first every session.
├── api/
│   └── index.js               ← Express server, all HTTP endpoints, Slack events
├── lib/
│   ├── slack.js               ← All Slack API calls
│   ├── sheets.js              ← Google Sheets read/write
│   ├── messages.js            ← All Slack message templates
│   ├── onboarding.js          ← Core onboarding orchestrator (6 steps)
│   ├── cron.js                ← All scheduled jobs
│   ├── Codex.js              ← Codex API: DLOA analysis, Q&A, summaries
│   ├── knowledge.js           ← RAG system: embeddings, vector store, search
│   ├── monday.js              ← Monday.com GraphQL API: DLOA sync
│   ├── zoom.js                ← Zoom webhook handler + transcript parser
│   ├── channels.js            ← Channel config and naming
│   └── test.js                ← Test runner
├── knowledge/
│   └── store.json             ← Local vector store (embeddings + chunks)
├── docs/                      ← Department docs loaded into knowledge base
│   ├── hiring-philosophy.md
│   ├── onboarding-guide.md
│   ├── knowledge-capture-standard.md
│   └── culture-deck.md
├── .env.example
├── vercel.json
└── package.json
```

## Environment variables needed

```
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
TAULANT_SLACK_ID=U...
TYLER_SLACK_ID=U...
ADMIN_CHANNEL_ID=C...  (the #ai-onboarding-updates channel ID)

# Google Sheets
GOOGLE_SHEET_ID=...
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Monday.com
MONDAY_API_KEY=...
MONDAY_BOARD_ID=...

# Zoom
ZOOM_VERIFICATION_TOKEN=...
ZOOM_OAUTH_TOKEN=...

# App
ONBOARDING_PDF_URL=https://drive.google.com/...
ONBOARDING_FORM_URL=https://your-form.vercel.app
WEBHOOK_SECRET=...
CRON_SECRET=...
PORT=3000
NODE_ENV=development
ENABLE_CRON=false
```

## Key behaviours to preserve when editing

1. Slack event handler responds in < 3 seconds (200 OK immediately, process async)
2. DLOA detection uses `looksLikeDLOA()` in slack.js — checks for EOD/blockers/tomorrow keywords
3. New hire polling checks Google Sheet every 5 min for Active rows with no channel yet
4. Channel map is built fresh on each onboarding (calls conversations.list)
5. Knowledge base uses Anthropic embeddings (model: text-embedding-3-small equivalent)
6. RAG search returns top 5 chunks, fed as context to Codex before answering
7. Zoom transcripts are VTT format — parser strips timestamps and speaker labels
8. Monday.com sync uses GraphQL, not REST
9. Make.com webhook endpoint: POST /webhook/new-hire with { secret, name, role, email, slackEmail, startDate }
10. @mention handler: app_mention Slack event → search knowledge base → Codex answers in thread

## What NOT to change without asking

- The 11 universal channel names in channels.js
- The DLOA reminder time (4:30pm EST)
- The missing DLOA alert time (6pm EST)
- The weekly summary time (Friday 5:30pm EST)
- The channel naming format (sd-[role]-[firstname])

## When adding new features

Always add to the relevant lib/ file, never put business logic in api/index.js. Index.js is routing only. Tests go in lib/test.js. New environment variables go in .env.example with comments.
