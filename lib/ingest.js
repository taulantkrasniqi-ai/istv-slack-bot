// Auto-ingests files and substantial messages from department channels into the knowledge base.
// Handles: text files, PDFs (including scanned via Claude Vision), Google Drive, Notion links.

const axios = require('axios')
const knowledge = require('./knowledge')
const extractor = require('./extractor')

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

// Text-based file types (downloaded as text)
const TEXT_TYPES = ['txt', 'md', 'markdown', 'text', 'javascript', 'python',
  'typescript', 'css', 'html', 'json', 'yaml', 'xml', 'csv', 'code']

function isIngestChannel(channelName) {
  return INGEST_CHANNELS.includes(channelName)
}

function cacheChannelName(channelId, channelName) {}  // kept for API compatibility

// Download file as raw buffer (for PDFs) or text
async function downloadFile(url, asBinary = false) {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: asBinary ? 'arraybuffer' : 'text',
      timeout: 20000,
      maxContentLength: 10 * 1024 * 1024 // 10mb max
    })
    return asBinary ? Buffer.from(res.data) : (typeof res.data === 'string' ? res.data : JSON.stringify(res.data))
  } catch {
    return null
  }
}

// Extract URLs from a Slack message text (strips Slack formatting)
function extractUrls(text) {
  const raw = (text || '').replace(/<([^|>]+)(?:\|[^>]*)?>/, '$1')
  const matches = raw.match(/https?:\/\/[^\s>)"]+/g) || []
  return [...new Set(matches)]
}

async function ingestEvent(event, channelName) {
  const files = event.files || []
  const text = event.text || ''
  const ingested = []
  const dateStr = new Date(parseFloat(event.ts || 0) * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  })

  // ── Ingest attached files ─────────────────────────────────────────────────
  for (const file of files) {
    const type = (file.filetype || '').toLowerCase()
    const url  = file.url_private_download || file.url_private
    if (!url) continue

    let content = null

    if (type === 'pdf') {
      // PDFs — download as binary, use Claude Vision (handles scanned + text PDFs)
      const buffer = await downloadFile(url, true)
      if (buffer) {
        content = await extractor.extractFromPDF(buffer)
        if (!content) {
          // Fallback: try downloading as plain text (works for text-layer PDFs)
          content = await downloadFile(url, false)
        }
      }
    } else if (TEXT_TYPES.some(t => type.includes(t))) {
      // Plain text files — download directly
      content = await downloadFile(url, false)
    }

    if (!content || content.length < 50) continue

    const title = `[#${channelName}] ${file.name || file.title || 'File'} — ${dateStr}`
    await knowledge.addDocument(title, content, 'document', {
      channelName, fileId: file.id, fileName: file.name, source: 'auto-ingest'
    }).catch(() => {})
    ingested.push(file.name || file.title)
    console.log(`📥 Ingested file: ${file.name} from #${channelName}`)
  }

  // ── Ingest Google Drive / Notion links from message text ──────────────────
  const urls = extractUrls(text)
  for (const url of urls) {
    const isGoogleDrive = /docs\.google\.com|drive\.google\.com/.test(url)
    const isNotion = /notion\.so/.test(url)
    if (!isGoogleDrive && !isNotion) continue

    const content = await extractor.extractFromUrl(url)
    if (!content || content.length < 50) continue

    const source = isGoogleDrive ? 'google-drive' : 'notion'
    const label  = isGoogleDrive ? 'Google Doc' : 'Notion Page'
    const title  = `[#${channelName}] ${label} — ${dateStr}`

    await knowledge.addDocument(title, content, 'document', {
      channelName, url, source, ts: event.ts
    }).catch(() => {})
    ingested.push(label)
    console.log(`📥 Ingested ${label} link from #${channelName}`)
  }

  // ── Ingest substantial plain messages (200+ chars, no special links) ───────
  const hasSpecialLink = urls.some(u => /docs\.google\.com|drive\.google\.com|notion\.so/.test(u))
  const isSubstantial  = text.length >= 200

  if (isSubstantial && !hasSpecialLink && !event.bot_id) {
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
