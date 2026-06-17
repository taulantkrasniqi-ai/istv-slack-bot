const cron = require('node-cron')
const registry = require('./registry')
const slack = require('./slack')
const messages = require('./messages')
const claudeAI = require('./claude')
const onboarding = require('./onboarding')
const eod = require('./eod')
const standup = require('./standup')

// Store DLOAs in memory (in production, use a database or Redis)
const dloaStore = {}

// ── Register all cron jobs ────────────────────────────────────────────────────
function registerCronJobs() {
  console.log('⏰ Registering cron jobs...')

  // New hire polling REMOVED — onboarding is now triggered manually via /onboard slash command

  // 1. DLOA reminder — 4:30pm EST weekdays
  cron.schedule('30 16 * * 1-5', sendDLOAReminders, { timezone: 'America/New_York' })
  console.log('✅ DLOA reminder: 4:30pm EST weekdays')

  // 2. DLOA missing alert — 6pm EST weekdays
  cron.schedule('0 18 * * 1-5', checkMissingDLOAs, { timezone: 'America/New_York' })
  console.log('✅ DLOA missing check: 6pm EST weekdays')

  // 3. Day one morning message — 9am EST weekdays
  cron.schedule('0 9 * * 1-5', sendDayOneMessages, { timezone: 'America/New_York' })
  console.log('✅ Day one messages: 9am EST weekdays')

  // 4. Profile check — 10am EST weekdays
  cron.schedule('0 10 * * 1-5', runProfileChecks, { timezone: 'America/New_York' })
  console.log('✅ Profile checks: 10am EST weekdays')

  // 5. Check-in reminders — 9am EST weekdays (7/14/30/90 day marks)
  cron.schedule('0 9 * * 1-5', sendCheckinReminders, { timezone: 'America/New_York' })
  console.log('✅ Check-in reminders: 9am EST weekdays')

  // 6. EOD channel summaries — 5pm EST weekdays → admin channel
  cron.schedule('0 17 * * 1-5', eod.sendEODSummary, { timezone: 'America/New_York' })
  console.log('✅ EOD channel summaries: 5pm EST weekdays')

  // 7. Weekly DLOA summary for Tyler/Taulant — Friday 5:30pm EST
  cron.schedule('30 17 * * 5', sendWeeklySummaries, { timezone: 'America/New_York' })
  console.log('✅ Weekly summaries: Friday 5:30pm EST')

  console.log('✅ All cron jobs registered\n')
}

// pollForNewHires removed — onboarding is triggered manually via /onboard slash command

// ── DLOA Reminders ────────────────────────────────────────────────────────────
async function sendDLOAReminders() {
  console.log('⏰ Sending DLOA reminders...')
  try {
    const onboardees = registry.getActiveOnboardees()
    for (const hire of onboardees) {
      if (!hire.slackId || !hire.name) continue
      await slack.sendDM(hire.slackId, messages.dloaReminder(hire.firstName, hire.channelId))
      console.log(`✅ DLOA reminder sent to ${hire.name}`)
    }
  } catch (err) {
    console.error('DLOA reminder error:', err.message)
  }
}

// ── Check for missing DLOAs ───────────────────────────────────────────────────
async function checkMissingDLOAs() {
  console.log('🔍 Checking for missing DLOAs...')
  try {
    const onboardees = registry.getActiveOnboardees()
    const today = new Date().toISOString().split('T')[0]
    const adminChannel = process.env.ADMIN_CHANNEL_ID

    for (const hire of onboardees) {
      if (!hire.slackId) continue
      const todayDLOA = dloaStore[hire.slackId]?.find(d => d.date === today)
      if (!todayDLOA && adminChannel) {
        await slack.postToChannel(adminChannel, messages.dloaMissingAlert(hire))
        console.log(`⚠️ Missing DLOA alert sent for ${hire.name}`)
      }
    }
  } catch (err) {
    console.error('DLOA check error:', err.message)
  }
}

// ── Day one messages ──────────────────────────────────────────────────────────
async function sendDayOneMessages() {
  try {
    const onboardees = registry.getActiveOnboardees()
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

    for (const hire of onboardees) {
      if (!hire.channelId) continue
      if (hire.startDate && (hire.startDate.includes(today) || hire.startDate === today)) {
        await onboarding.sendDayOneMessage(hire)
        console.log(`☀️ Day one message sent for ${hire.name}`)
      }
    }
  } catch (err) {
    console.error('Day one message error:', err.message)
  }
}

// ── Profile checks ────────────────────────────────────────────────────────────
async function runProfileChecks() {
  try {
    const onboardees = registry.getActiveOnboardees()
    for (const hire of onboardees) {
      if (!hire.slackId) continue
      await onboarding.checkAndReportProfile(hire)
    }
  } catch (err) {
    console.error('Profile check error:', err.message)
  }
}

// ── Check-in reminders ────────────────────────────────────────────────────────
async function sendCheckinReminders() {
  try {
    const onboardees = registry.getActiveOnboardees()
    const today = new Date()

    for (const hire of onboardees) {
      if (!hire.slackId) continue
      const { daysSinceStart } = hire
      if ([7, 14, 30, 90].includes(daysSinceStart)) {
        await onboarding.sendCheckinReminder(hire, daysSinceStart)
        console.log(`📅 ${daysSinceStart}-day check-in reminder sent for ${hire.name}`)
      }
    }
  } catch (err) {
    console.error('Check-in reminder error:', err.message)
  }
}

// ── Weekly summaries ──────────────────────────────────────────────────────────
async function sendWeeklySummaries() {
  try {
    const onboardees = registry.getActiveOnboardees()
    const adminChannel = process.env.ADMIN_CHANNEL_ID
    if (!adminChannel) return

    await slack.postToChannel(adminChannel, {
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `📊 *Weekly onboarding summary — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}*\n${onboardees.length} active onboardee${onboardees.length !== 1 ? 's' : ''}` }
      }]
    })

    for (const hire of onboardees) {
      if (!hire.slackId) continue

      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)
      const weekDLOAs = (dloaStore[hire.slackId] || [])
        .filter(d => new Date(d.date) >= weekAgo)
        .map(d => d.text)

      const hireData = { name: hire.name, role: hire.role, daysSinceStart: hire.daysSinceStart }
      const summary = await claudeAI.generateWeeklySummary(hireData, weekDLOAs)

      await slack.postToChannel(adminChannel, {
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${hire.name}* — ${hire.role} — Day ${hire.daysSinceStart}` } },
          { type: 'section', text: { type: 'mrkdwn', text: summary } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `DLOAs this week: ${weekDLOAs.length}/5` }] },
          { type: 'divider' }
        ]
      })
    }
  } catch (err) {
    console.error('Weekly summary error:', err.message)
  }
}

// ── Store a DLOA when the bot sees one ────────────────────────────────────────
function recordDLOA(slackId, text) {
  if (!dloaStore[slackId]) dloaStore[slackId] = []
  const today = new Date().toISOString().split('T')[0]
  // Remove any existing entry for today
  dloaStore[slackId] = dloaStore[slackId].filter(d => d.date !== today)
  dloaStore[slackId].push({ date: today, text })
}

function getDLOAs(slackId) {
  return dloaStore[slackId] || []
}

// ── Silent hire check — alert if no activity for 3+ days ─────────────────────
async function checkSilentHires() {
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (!adminChannel) return

  const onboardees = registry.getActiveOnboardees()
  const threeDays = 3 * 24 * 60 * 60 * 1000

  for (const hire of onboardees) {
    if (!hire.lastActiveAt) continue
    if (Date.now() - hire.lastActiveAt > threeDays) {
      await slack.postToChannel(adminChannel, {
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🔇 *Silent hire alert* — <@${hire.slackId}> (${hire.name}, ${hire.role}) has not been active for 3+ days.\nLast active: ${new Date(hire.lastActiveAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
          }
        }]
      }).catch(() => {})
    }
  }
}

// ── Weekly knowledge digest from new hire questions ───────────────────────────
async function sendWeeklyKnowledgeDigest() {
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (!adminChannel) return

  const questions = registry.getWeeklyQuestions()
  if (questions.length === 0) return

  const digest = await claudeAI.generateKnowledgeDigest(questions.map(q => q.question))
  if (!digest) return

  await slack.postToChannel(adminChannel, {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📚 Weekly Knowledge Digest' }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `_Top themes from ${questions.length} new hire question${questions.length !== 1 ? 's' : ''} this week:_\n\n${digest}`
        }
      }
    ]
  }).catch(console.error)
}

// ── 90-day risk flag — runs Friday with weekly summary ───────────────────────
async function checkRiskFlags() {
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (!adminChannel) return

  const hires = registry.getActiveOnboardees()
  if (hires.length === 0) return

  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)
  const today = new Date().toISOString().split('T')[0]

  const atRisk = []

  for (const hire of hires) {
    if (!hire.slackId) continue
    const flags = []

    // Check DLOAs this week
    const weekDLOAs = (dloaStore[hire.slackId] || []).filter(d => new Date(d.date) >= weekAgo)
    if (weekDLOAs.length < 3) {
      flags.push(`Only ${weekDLOAs.length}/5 DLOAs this week`)
    }

    // Check if approaching or past 60-day mark
    if (hire.daysSinceStart >= 60 && hire.daysSinceStart < 90) {
      flags.push(`Day ${hire.daysSinceStart} — keeper/cut decision approaching`)
    }

    // Check if past 90 days with no decision made (still in registry)
    if (hire.daysSinceStart >= 90) {
      flags.push(`Day ${hire.daysSinceStart} — past 90-day mark, decision needed`)
    }

    // Missing DLOA today (if it's a weekday)
    const dayOfWeek = new Date().getDay()
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      const todayDLOA = (dloaStore[hire.slackId] || []).find(d => d.date === today)
      if (!todayDLOA) flags.push('No DLOA today')
    }

    if (flags.length > 0) {
      atRisk.push({ hire, flags })
    }
  }

  if (atRisk.length === 0) {
    await slack.postToChannel(adminChannel, {
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ *90-day risk check — no flags this week.* All ${hires.length} onboardee${hires.length !== 1 ? 's' : ''} on track.` }
      }]
    })
    return
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `⚠️ Weekly Risk Flags — ${atRisk.length} hire${atRisk.length !== 1 ? 's' : ''} need attention` }
    },
    { type: 'divider' }
  ]

  for (const { hire, flags } of atRisk) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${hire.name}* — ${hire.role} — Day ${hire.daysSinceStart}\n${flags.map(f => `• ${f}`).join('\n')}`
      }
    })
    blocks.push({ type: 'divider' })
  }

  await slack.postToChannel(adminChannel, { blocks })
  console.log(`⚠️ Risk flags posted for ${atRisk.length} hire(s)`)
}

module.exports = {
  registerCronJobs,
  recordDLOA,
  getDLOAs,
  sendDLOAReminders,
  checkMissingDLOAs,
  sendDayOneMessages,
  runProfileChecks,
  sendCheckinReminders,
  sendWeeklySummaries,
  checkRiskFlags,
  checkSilentHires,
  sendWeeklyKnowledgeDigest,
  standup
}
