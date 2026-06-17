const slack = require('./slack')
const ingest = require('./ingest')

const DAYS_BACK = 90

// ── Scrape full history of one channel ────────────────────────────────────────
async function scrapeChannel(channelId, channelName) {
  let messagesScanned = 0
  let itemsIngested = 0
  const oldest = Math.floor((Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000) / 1000).toString()
  let cursor

  console.log(`🔍 Scraping #${channelName} (last ${DAYS_BACK} days)...`)

  do {
    try {
      const res = await slack.client.conversations.history({
        channel: channelId,
        oldest,
        limit: 200,
        cursor
      })

      const messages = res.messages || []
      messagesScanned += messages.length

      for (const msg of messages) {
        if (msg.bot_id || msg.subtype === 'bot_message') continue
        const ingested = await ingest.ingestEvent(msg, channelName)
        itemsIngested += ingested.length
      }

      cursor = res.response_metadata?.next_cursor

      // Respect Slack rate limits between pages
      if (cursor) await sleep(600)
    } catch (err) {
      console.error(`Scrape error on #${channelName}:`, err.message)
      break
    }
  } while (cursor)

  console.log(`✅ #${channelName} — ${messagesScanned} messages scanned, ${itemsIngested} items ingested`)
  return { channelName, messagesScanned, itemsIngested }
}

// ── Scrape all department channels ────────────────────────────────────────────
async function scrapeAll(adminChannel) {
  const { INGEST_CHANNELS } = require('./ingest')
  const channelMap = await slack.buildChannelMap()

  const results = []
  let totalMessages = 0
  let totalIngested = 0

  for (let i = 0; i < INGEST_CHANNELS.length; i++) {
    const name = INGEST_CHANNELS[i]
    const channelId = channelMap[name]

    if (!channelId) {
      console.warn(`⚠️ Scrape: #${name} not found — skipping`)
      results.push({ channelName: name, skipped: true })
      continue
    }

    // Post progress update every 5 channels
    if (adminChannel && i > 0 && i % 5 === 0) {
      await slack.postToChannel(adminChannel, {
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `⏳ *Scraping in progress...* ${i}/${INGEST_CHANNELS.length} channels done` }
        }]
      }).catch(() => {})
    }

    const result = await scrapeChannel(channelId, name)
    results.push(result)
    totalMessages += result.messagesScanned || 0
    totalIngested += result.itemsIngested || 0

    // Delay between channels to avoid rate limits
    await sleep(1000)
  }

  return { results, totalMessages, totalIngested }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = { scrapeChannel, scrapeAll, DAYS_BACK }
