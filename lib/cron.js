const cron = require('node-cron')
const sheets = require('./sheets')
const slack = require('./slack')
const messages = require('./messages')
const claudeAI = require('./claude')
const onboarding = require('./onboarding')
const eod = require('./eod')

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

// ── Poll Google Sheet for new hires ──────────────────────────────────────────
async function pollForNewHires() {
  try {
    const roster = await sheets.getHiredRoster()
    for (const hire of roster) {
      // A hire needs onboarding if: they exist, have a name, but have no channel yet
      const needsOnboarding =
        hire['Name'] &&
        hire['Name'].trim() !== '' &&
        hire['Current Status'] === 'Active' &&
        (!hire['Onboarding Channel'] || hire['Onboarding Channel'].trim() === '')

      if (needsOnboarding) {
        console.log(`\n📋 New hire detected: ${hire['Name']}`)
        const hireData = {
          name: hire['Name'],
          role: hire['Role'] || 'AI Department',
          slackId: hire['⭐ SLACK ID ⭐'] || hire['Slack ID'] || '',
          email: hire['Company Email'] || hire['Personal Email'] || '',
          startDate: hire['Start Date'] || new Date().toLocaleDateString('en-US'),
          _rowIndex: hire._rowIndex
        }

        const result = await onboarding.onboardNewHire(hireData)

        // Update sheet to mark channel as created (prevents re-running)
        if (result.channelId) {
          await sheets.updateHiredRosterCell(
            hire._rowIndex,
            'H', // Adjust column letter to match "Onboarding Channel" column
            result.channelName
          )
        }
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message)
  }
}

// ── DLOA Reminders ────────────────────────────────────────────────────────────
async function sendDLOAReminders() {
  console.log('⏰ Sending DLOA reminders...')
  try {
    const onboardees = await sheets.getActiveOnboardees()
    for (const hire of onboardees) {
      const slackId = hire['⭐ Slack ID ⭐'] || hire['Slack ID'] || ''
      const channelId = hire['Personal Channel'] || hire['Onboarding Channel'] || ''
      const name = hire['Name'] || ''
      if (!slackId || !name) continue

      const firstName = name.split(' ')[0]
      await slack.sendDM(slackId, messages.dloaReminder(firstName, channelId))
      console.log(`✅ DLOA reminder sent to ${name}`)
    }
  } catch (err) {
    console.error('DLOA reminder error:', err.message)
  }
}

// ── Check for missing DLOAs ───────────────────────────────────────────────────
async function checkMissingDLOAs() {
  console.log('🔍 Checking for missing DLOAs...')
  try {
    const onboardees = await sheets.getActiveOnboardees()
    const today = new Date().toISOString().split('T')[0]
    const adminChannel = process.env.ADMIN_CHANNEL_ID

    for (const hire of onboardees) {
      const slackId = hire['⭐ Slack ID ⭐'] || hire['Slack ID'] || ''
      if (!slackId) continue

      // Check our memory store for today's DLOA
      const hireKey = slackId
      const todayDLOA = dloaStore[hireKey]?.find(d => d.date === today)

      if (!todayDLOA && adminChannel) {
        const hireData = {
          name: hire['Name'],
          role: hire['Role'],
          slackId,
          channelId: hire['Personal Channel'] || hire['Onboarding Channel'] || ''
        }
        await slack.postToChannel(adminChannel, messages.dloaMissingAlert(hireData))
        console.log(`⚠️ Missing DLOA alert sent for ${hire['Name']}`)
      }
    }
  } catch (err) {
    console.error('DLOA check error:', err.message)
  }
}

// ── Day one messages ──────────────────────────────────────────────────────────
async function sendDayOneMessages() {
  try {
    const onboardees = await sheets.getActiveOnboardees()
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

    for (const hire of onboardees) {
      const startDate = hire['Start Date'] || ''
      if (startDate.includes(today) || startDate === today) {
        const hireData = {
          firstName: hire['Name'].split(' ')[0],
          name: hire['Name'],
          channelId: hire['Personal Channel'] || hire['Onboarding Channel'] || ''
        }
        if (hireData.channelId) {
          await onboarding.sendDayOneMessage(hireData)
          console.log(`☀️ Day one message sent for ${hire['Name']}`)
        }
      }
    }
  } catch (err) {
    console.error('Day one message error:', err.message)
  }
}

// ── Profile checks ────────────────────────────────────────────────────────────
async function runProfileChecks() {
  try {
    const onboardees = await sheets.getActiveOnboardees()
    for (const hire of onboardees) {
      const slackId = hire['⭐ Slack ID ⭐'] || hire['Slack ID'] || ''
      const profileDone = hire['Slack Profile Complete'] || ''
      if (!slackId || profileDone === 'Yes') continue

      const hireData = {
        name: hire['Name'],
        firstName: hire['Name'].split(' ')[0],
        slackId,
        channelId: hire['Personal Channel'] || hire['Onboarding Channel'] || ''
      }

      const result = await onboarding.checkAndReportProfile(hireData)
      if (result && result.complete) {
        // Update sheet
        await sheets.updateOnboardingCell(hire._rowIndex, 'O', 'Yes')
      }
    }
  } catch (err) {
    console.error('Profile check error:', err.message)
  }
}

// ── Check-in reminders ────────────────────────────────────────────────────────
async function sendCheckinReminders() {
  try {
    const onboardees = await sheets.getActiveOnboardees()
    const today = new Date()

    for (const hire of onboardees) {
      const startDate = new Date(hire['Start Date'])
      if (isNaN(startDate.getTime())) continue

      const daysSinceStart = Math.floor((today - startDate) / (1000 * 60 * 60 * 24))
      const hireData = {
        name: hire['Name'],
        firstName: hire['Name'].split(' ')[0],
        role: hire['Role'],
        slackId: hire['⭐ Slack ID ⭐'] || hire['Slack ID'] || '',
        channelId: hire['Personal Channel'] || hire['Onboarding Channel'] || '',
        daysSinceStart
      }

      if ([7, 14, 30, 90].includes(daysSinceStart)) {
        await onboarding.sendCheckinReminder(hireData, daysSinceStart)
        console.log(`📅 ${daysSinceStart}-day check-in reminder sent for ${hire['Name']}`)
      }
    }
  } catch (err) {
    console.error('Check-in reminder error:', err.message)
  }
}

// ── Weekly summaries ──────────────────────────────────────────────────────────
async function sendWeeklySummaries() {
  try {
    const onboardees = await sheets.getActiveOnboardees()
    const adminChannel = process.env.ADMIN_CHANNEL_ID
    if (!adminChannel) return

    await slack.postToChannel(adminChannel, {
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `📊 *Weekly onboarding summary — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}*\n${onboardees.length} active onboardee${onboardees.length !== 1 ? 's' : ''}` }
      }]
    })

    for (const hire of onboardees) {
      const slackId = hire['⭐ Slack ID ⭐'] || hire['Slack ID'] || ''
      if (!slackId) continue

      const hireKey = slackId
      const weekDLOAs = (dloaStore[hireKey] || [])
        .filter(d => {
          const date = new Date(d.date)
          const weekAgo = new Date()
          weekAgo.setDate(weekAgo.getDate() - 7)
          return date >= weekAgo
        })
        .map(d => d.text)

      const startDate = new Date(hire['Start Date'])
      const daysSinceStart = Math.floor((new Date() - startDate) / (1000 * 60 * 60 * 24))

      const hireData = { name: hire['Name'], role: hire['Role'], daysSinceStart }
      const summary = await claudeAI.generateWeeklySummary(hireData, weekDLOAs)

      await slack.postToChannel(adminChannel, {
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${hire['Name']}* — ${hire['Role']} — Day ${daysSinceStart}`
            }
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: summary }
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `DLOAs this week: ${weekDLOAs.length}/5` }]
          },
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

module.exports = {
  registerCronJobs,
  recordDLOA,
  getDLOAs,
  pollForNewHires,
  sendDLOAReminders,
  checkMissingDLOAs,
  sendDayOneMessages,
  runProfileChecks,
  sendCheckinReminders,
  sendWeeklySummaries
}
