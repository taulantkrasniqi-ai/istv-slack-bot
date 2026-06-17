const slack = require('./slack')
const registry = require('./registry')

async function postPeopleMap() {
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (!adminChannel) return

  const hires = registry.getActiveOnboardees()
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '👥 Shipping Department — People Map' }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Updated: ${today} · ${hires.length} active onboardee${hires.length !== 1 ? 's' : ''}` }]
    },
    { type: 'divider' }
  ]

  if (hires.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active onboardees._' }
    })
  } else {
    for (const hire of hires) {
      let line = `*${hire.name}* — ${hire.role} — Day ${hire.daysSinceStart} of 90`
      if (hire.project) line += `\n_Project: ${hire.project}_`
      if (hire.channelId) line += `\nChannel: <#${hire.channelId}>`

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: line }
      })
      blocks.push({ type: 'divider' })
    }
  }

  await slack.postToChannel(adminChannel, { blocks }).catch(err => {
    console.error('peoplemap post failed:', err.message)
  })
}

module.exports = { postPeopleMap }
