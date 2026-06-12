const slack = require('./slack')
const registry = require('./registry')

// userId -> { name, role, asked: timestamp, reply: string|null }
const sessions = {}

async function sendStandupDMs() {
  const hires = registry.getActiveOnboardees()
  if (hires.length === 0) {
    console.log('Standup: no active hires in registry')
    return
  }

  // Clear previous sessions before sending new round
  Object.keys(sessions).forEach(k => delete sessions[k])

  for (const hire of hires) {
    if (!hire.slackId) continue
    try {
      await slack.sendDM(hire.slackId, {
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `☀️ *Daily standup, ${hire.firstName}.*\n\nWhat are you working on today? Reply here — one message, I'll include it in the team digest.`
            }
          }
        ]
      })
      sessions[hire.slackId] = { name: hire.name, role: hire.role, asked: Date.now(), reply: null }
      console.log(`✅ Standup DM sent to ${hire.name}`)
    } catch (err) {
      console.error(`Standup DM error for ${hire.name}:`, err.message)
    }
  }
}

// Returns true if this DM was a standup reply (so the caller can skip normal Q&A)
function handleStandupReply(userId, text) {
  if (!sessions[userId] || sessions[userId].reply !== null) return false
  sessions[userId].reply = text
  console.log(`📋 Standup reply from ${sessions[userId].name}`)
  return true
}

function isAwaitingStandup(userId) {
  return !!sessions[userId] && sessions[userId].reply === null
}

async function postStandupDigest() {
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (!adminChannel) return

  const all = Object.entries(sessions)
  if (all.length === 0) {
    console.log('Standup digest: no sessions')
    return
  }

  const replied = all.filter(([, s]) => s.reply)
  const silent  = all.filter(([, s]) => !s.reply)

  const dateLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  })

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `☀️ Daily Standup — ${dateLabel}` }
    },
    { type: 'divider' }
  ]

  for (const [, s] of replied) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${s.name}* — ${s.role}\n${s.reply}` }
    })
    blocks.push({ type: 'divider' })
  }

  if (replied.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No replies received._' }
    })
  }

  if (silent.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `⚠️ No reply: ${silent.map(([, s]) => s.name).join(', ')}`
      }]
    })
  }

  await slack.postToChannel(adminChannel, { blocks })
  console.log(`✅ Standup digest posted — ${replied.length} replied, ${silent.length} silent`)
}

module.exports = { sendStandupDMs, handleStandupReply, isAwaitingStandup, postStandupDigest }
