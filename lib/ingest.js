// Auto-ingests files and substantial messages from department channels into the knowledge base.
// Triggered by message events — no polling needed.

const axios = require('axios')
const knowledge = require('./knowledge')

// Every channel from the department (screenshot). The bot must be a member to receive events.
const INGEST_CHANNELS = [
  'sd-ai-video-talha',
  'sd-all-meeting-transcripts-recordings-tyler',
  'sd-crm-ghl-deo',
  'sd-deployment-jaya',
  'sd-dloa-tyler',
  'sd-eat-that-frog-tyler',
  'sd-feature-docs-sri',
  'sd-github-tyler',
  'sd-idea-dump-tyler',
  'sd-index',
  'sd-intercom-customer-service-saqlain',
  'sd-main-tyler',
  'sd-mr-moe',
  'sd-notion-knowledge-layer-adrian',
  'sd-onboarding-taulant',
  'sd-operations-katching',
  'sd-random-convos-tyler',
  'sd-recruiting-ai-taulant',
  'sd-recruiting-interview-recordings',
  'sd-recruiting-leadership-only-taulant',
  'sd-sales-syed',
]

// File types worth ingesting
const INGESTIBLE_TYPES = ['txt', 'md', 'markdown', 'text', 'javascript', 'python',
  'typescript', 'css', 'html', 'json', 'yaml', 'xml', 'csv', 'pdf', 'code']

let channelIdToName = {} // populated on first use

function cacheChannelName(channelId, channelName) {
  channelIdToName[channelId] = channelName
}

function isIngestChannel(channelName) {
  return INGEST_CHANNELS.includes(channelName)
}

async function downloadFile(url) {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'text',
      timeout: 15000,
      maxContentLength: 500000 // 500kb max
    })
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  } catch {
    return null
  }
}

async function ingestEvent(event, channelName) {
  const files = event.files || []
  const text = event.text || ''
  const ingested = []
  const dateStr = new Date(parseFloat(event.ts || 0) * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  })

  // ── Ingest attached files ───────────────────────────────────────────────────
  for (const file of files) {
    const type = (file.filetype || '').toLowerCase()
    const isText = INGESTIBLE_TYPES.some(t => type.includes(t))
    if (!isText) continue

    const url = file.url_private_download || file.url_private
    if (!url) continue

    const content = await downloadFile(url)
    if (!content || content.length < 50) continue

    const title = `[#${channelName}] ${file.name || file.title || 'File'} — ${dateStr}`
    await knowledge.addDocument(title, content, 'document', {
      channelName, fileId: file.id, fileName: file.name, source: 'auto-ingest'
    }).catch(() => {})
    ingested.push(file.name || file.title)
    console.log(`📥 Ingested file: ${file.name} from #${channelName}`)
  }

  // ── Ingest substantial messages (200+ chars or contains a URL) ─────────────
  const hasUrl = /https?:\/\/[^\s>]{10,}/.test(text)
  const isSubstantial = text.length >= 200

  if ((hasUrl || isSubstantial) && !event.bot_id) {
    const title = `[#${channelName}] Message — ${dateStr}`
    await knowledge.addDocument(title, text, 'message', {
      channelName, ts: event.ts, source: 'auto-ingest'
    }).catch(() => {})
    ingested.push('message')
    console.log(`📥 Ingested message from #${channelName} (${text.length} chars)`)
  }

  return ingested
}

module.exports = { ingestEvent, isIngestChannel, cacheChannelName, INGEST_CHANNELS }
