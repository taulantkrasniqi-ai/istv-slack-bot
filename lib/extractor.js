// Extracts text content from scanned PDFs (via Claude Vision),
// Google Drive/Docs links, and Notion page links.

require('dotenv').config()
const axios = require('axios')
const Anthropic = require('@anthropic-ai/sdk')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Scanned PDF → Claude Vision OCR ──────────────────────────────────────────
async function extractFromPDF(buffer) {
  try {
    const base64 = buffer.toString('base64')
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 }
          },
          {
            type: 'text',
            text: 'Extract all text from this document. Return only the raw text content, preserving headings and structure. No commentary.'
          }
        ]
      }]
    })
    const text = response.content[0].text
    return text && text.length > 30 ? text : null
  } catch (err) {
    console.error('PDF OCR error:', err.message)
    return null
  }
}

// ── Google Drive / Docs / Sheets / Slides ────────────────────────────────────
function detectGoogleUrl(url) {
  const doc    = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/)
  const sheet  = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  const slides = url.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/)
  const drive  = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) ||
                 url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/)

  if (doc)    return { type: 'doc',    id: doc[1] }
  if (sheet)  return { type: 'sheet',  id: sheet[1] }
  if (slides) return { type: 'slides', id: slides[1] }
  if (drive)  return { type: 'file',   id: drive[1] }
  return null
}

async function extractFromGoogleDrive(url) {
  const detected = detectGoogleUrl(url)
  if (!detected) return null

  const exportUrls = {
    doc:    `https://docs.google.com/document/d/${detected.id}/export?format=txt`,
    sheet:  `https://docs.google.com/spreadsheets/d/${detected.id}/export?format=csv`,
    slides: `https://docs.google.com/presentation/d/${detected.id}/export?format=txt`,
    file:   `https://drive.google.com/uc?export=download&id=${detected.id}`
  }

  try {
    const res = await axios.get(exportUrls[detected.type], {
      responseType: 'text',
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const text = typeof res.data === 'string' ? res.data : null
    // If Google returns a sign-in page it'll contain "accounts.google.com"
    if (!text || text.length < 50 || text.includes('accounts.google.com')) return null
    return text
  } catch (err) {
    console.error('Google Drive extraction error:', err.message)
    return null
  }
}

// ── Notion ────────────────────────────────────────────────────────────────────
function extractNotionPageId(url) {
  // Handles: notion.so/Page-Title-abc123, notion.so/workspace/Page-abc123
  const match = url.match(/notion\.so\/(?:[^/]+-)?([a-f0-9]{32})/)
  return match ? match[1] : null
}

function blockToText(block) {
  const content = block[block.type]
  if (!content) return ''
  if (content.rich_text) return content.rich_text.map(t => t.plain_text || '').join('')
  if (content.title)     return content.title.map(t => t.plain_text || '').join('')
  return ''
}

async function extractFromNotion(url) {
  const token = process.env.NOTION_API_TOKEN
  if (!token) {
    console.warn('NOTION_API_TOKEN not set — skipping Notion link')
    return null
  }

  const pageId = extractNotionPageId(url)
  if (!pageId) return null

  try {
    // Fetch page title
    const pageRes = await axios.get(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      timeout: 10000
    })
    const props = pageRes.data.properties || {}
    const titleProp = Object.values(props).find(p => p.type === 'title')
    const title = titleProp?.title?.map(t => t.plain_text).join('') || 'Notion Page'

    // Fetch blocks (page body)
    const blocksRes = await axios.get(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      timeout: 10000
    })
    const blocks = blocksRes.data.results || []
    const body = blocks.map(blockToText).filter(Boolean).join('\n')

    const full = `# ${title}\n\n${body}`
    return full.length > 50 ? full : null
  } catch (err) {
    console.error('Notion extraction error:', err.message)
    return null
  }
}

// ── Main router — detect URL type and extract ─────────────────────────────────
async function extractFromUrl(url) {
  if (/docs\.google\.com|drive\.google\.com/.test(url)) {
    return await extractFromGoogleDrive(url)
  }
  if (/notion\.so/.test(url)) {
    return await extractFromNotion(url)
  }
  return null
}

module.exports = { extractFromPDF, extractFromGoogleDrive, extractFromNotion, extractFromUrl }
