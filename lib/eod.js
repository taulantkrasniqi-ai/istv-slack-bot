require('dotenv').config()
const slack = require('./slack')
const claudeAI = require('./claude')

async function sendEODSummary() {
  console.log('📊 Generating EOD channel summaries...')
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (!adminChannel) return

  try {
    const channels = await slack.getBotChannels()
    if (!channels.length) return

    const summaries = []

    for (const channel of channels) {
      try {
        const messages = await slack.getChannelHistory(channel.id, 9)
        if (!messages || messages.length < 3) continue

        const text = messages
          .filter(m => !m.bot_id && m.text && m.text.trim().length > 5)
          .map(m => m.text)
          .join('\n')

        if (text.length < 100) continue

        const summary = await claudeAI.summariseChannelActivity(channel.name, text)
        if (summary) summaries.push({ name: channel.name, id: channel.id, summary })
      } catch (err) {
        console.error(`EOD error for #${channel.name}:`, err.message)
      }
    }

    const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

    if (!summaries.length) {
      await slack.postToChannel(adminChannel, {
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `📊 *EOD Summary — ${date}*\n\nNo significant activity across channels today.` }
        }]
      })
      return
    }

    await slack.postToChannel(adminChannel, {
      blocks: [{
        type: 'header',
        text: { type: 'plain_text', text: `📊 EOD Summary — ${date}` }
      }, {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `${summaries.length} active channel${summaries.length !== 1 ? 's' : ''} today` }]
      }]
    })

    for (const s of summaries) {
      await slack.postToChannel(adminChannel, {
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*<#${s.id}>*\n${s.summary}` } },
          { type: 'divider' }
        ]
      })
    }

    console.log(`✅ EOD summary sent — ${summaries.length} channels`)
  } catch (err) {
    console.error('EOD summary failed:', err.message)
  }
}

module.exports = { sendEODSummary }
