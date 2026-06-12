const slack = require('./slack')
const sheets = require('./sheets')
const messages = require('./messages')
const { getPersonalChannelName } = require('./channels')

// ── Run the full onboarding flow for a new hire ───────────────────────────────
async function onboardNewHire(hire) {
  console.log(`\n🚀 Starting onboarding for ${hire.name} (${hire.role})`)
  const errors = []

  // Parse name
  const nameParts = hire.name.trim().split(' ')
  hire.firstName = nameParts[0]
  hire.lastName = nameParts.slice(1).join(' ') || 'Unknown'

  try {
    // ── STEP 1: Create personal onboarding channel ────────────────────────────
    // Naming: sd-[role-slug]-[firstname]
    // e.g. sd-operations-dagim, sd-designer-manula, sd-knowledge-ekata
    console.log('Step 1: Creating personal onboarding channel...')
    hire.channelName = getPersonalChannelName(hire)
    const { channelId, channelName } = await slack.createOnboardingChannel(hire)
    hire.channelId = channelId
    hire.channelName = channelName
    console.log(`✅ Channel created: #${channelName}`)
  } catch (err) {
    errors.push(`Channel creation failed: ${err.message}`)
    console.error('❌ Channel creation failed:', err.message)
  }

  try {
    // ── STEP 2: Post welcome message in channel ───────────────────────────────
    console.log('Step 2: Posting welcome message...')
    await slack.postToChannel(hire.channelId, messages.welcomeMessage(hire))
    console.log('✅ Welcome message posted')
  } catch (err) {
    errors.push(`Welcome message failed: ${err.message}`)
    console.error('❌ Welcome message failed:', err.message)
  }

  try {
    // ── STEP 2b: Add to all 11 department channels ────────────────────────────
    if (hire.slackId) {
      console.log('Step 2b: Adding to all department channels...')
      const channelResults = await slack.addToAllChannels(hire)
      const added = channelResults.filter(r => r.status === 'added').length
      const notFound = channelResults.filter(r => r.status === 'not_found').length
      console.log(`✅ Added to ${added} channels. ${notFound > 0 ? `⚠️ ${notFound} channels not found (check channel names).` : ''}`)
    } else {
      console.log('⚠️ No Slack ID — channel assignment skipped until intake form submitted')
    }
  } catch (err) {
    errors.push(`Channel assignment failed: ${err.message}`)
    console.error('❌ Channel assignment failed:', err.message)
  }

  try {
    // ── STEP 3: DM the new hire ───────────────────────────────────────────────
    if (hire.slackId) {
      console.log('Step 3: Sending DM to new hire...')
      await slack.sendDM(hire.slackId, messages.newHireDM(hire))
      console.log('✅ DM sent')
    } else {
      console.log('⚠️ No Slack ID yet — DM skipped. Will send when intake form is submitted.')
    }
  } catch (err) {
    errors.push(`DM failed: ${err.message}`)
    console.error('❌ DM failed:', err.message)
  }

  try {
    // ── STEP 4: Add to Onboarding Tracker in Google Sheets ───────────────────
    console.log('Step 4: Updating Google Sheets...')
    await sheets.addOnboardingRow(hire)
    console.log('✅ Onboarding tracker updated')
  } catch (err) {
    errors.push(`Sheets update failed: ${err.message}`)
    console.error('❌ Sheets update failed:', err.message)
  }

  try {
    // ── STEP 5: Alert Taulant and Tyler in admin channel ─────────────────────
    console.log('Step 5: Sending admin alert...')
    const adminChannel = process.env.ADMIN_CHANNEL_ID
    if (adminChannel) {
      await slack.postToChannel(adminChannel, messages.newHireAlert(hire))
      console.log('✅ Admin alert sent')
    }
  } catch (err) {
    errors.push(`Admin alert failed: ${err.message}`)
    console.error('❌ Admin alert failed:', err.message)
  }

  try {
    // ── STEP 6: Check Slack profile (runs once immediately) ──────────────────
    if (hire.slackId) {
      console.log('Step 6: Checking Slack profile...')
      await checkAndReportProfile(hire)
    }
  } catch (err) {
    errors.push(`Profile check failed: ${err.message}`)
    console.error('❌ Profile check failed:', err.message)
  }

  const summary = {
    name: hire.name,
    role: hire.role,
    channelId: hire.channelId,
    channelName: hire.channelName,
    errors,
    success: errors.length === 0
  }

  console.log(`\n${errors.length === 0 ? '✅' : '⚠️'} Onboarding complete for ${hire.name}`)
  if (errors.length > 0) console.log('Errors:', errors)

  return summary
}

// ── Check profile and send feedback ──────────────────────────────────────────
async function checkAndReportProfile(hire) {
  if (!hire.slackId) return

  const result = await slack.checkSlackProfile(hire.slackId)

  if (result.complete) {
    // Post in their channel
    await slack.postToChannel(hire.channelId, messages.profileCompleteMessage(hire.firstName))
  } else {
    // DM them about what's missing
    await slack.sendDM(hire.slackId, messages.profileIncompleteMessage(hire.firstName, result.missing))
    // Also notify in their channel
    await slack.postToChannel(hire.channelId, {
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ ${hire.firstName}'s Slack profile is incomplete. Missing: ${result.missing.join(', ')}. They've been sent a DM with instructions.`
        }
      }]
    })
  }

  return result
}

// ── Send day one morning message ─────────────────────────────────────────────
async function sendDayOneMessage(hire) {
  if (!hire.channelId) return
  await slack.postToChannel(hire.channelId, messages.dayOneMessage(hire))
  console.log(`✅ Day one message sent for ${hire.name}`)
}

// ── Send check-in reminder ────────────────────────────────────────────────────
async function sendCheckinReminder(hire, days) {
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (adminChannel) {
    await slack.postToChannel(adminChannel, messages.checkinReminder(hire, days))
  }
  // Also post in their onboarding channel
  if (hire.channelId) {
    await slack.postToChannel(hire.channelId, {
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📅 *${days}-day check-in reminder.* ${hire.firstName}, it's your responsibility to schedule this. Message Taulant to book it.`
        }
      }]
    })
  }
}

// ── Share onboarding documents from source channels ──────────────────────────
// Pulls pinned messages + recent files from #sd-onboarding-taulant
// and #sd-all-meeting-transcripts-recordings-tyler and shares in hire's channel
async function shareOnboardingDocuments(hire) {
  if (!hire.channelId) return

  const SOURCE_CHANNELS = [
    'sd-onboarding-taulant',
    'sd-all-meeting-transcripts-recordings-tyler'
  ]

  try {
    const channelMap = await slack.buildChannelMap()

    for (const name of SOURCE_CHANNELS) {
      const sourceId = channelMap[name]
      if (!sourceId) {
        console.warn(`⚠️ Source channel not found: #${name}`)
        continue
      }

      // Get pinned messages
      const pinned = await slack.getPinnedMessages(sourceId)
      if (pinned.length > 0) {
        await slack.postToChannel(hire.channelId, {
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📌 *Pinned resources from <#${sourceId}>:*`
            }
          }]
        })
        for (const msg of pinned.slice(0, 5)) {
          if (msg.text) {
            await slack.postToChannel(hire.channelId, msg.text).catch(() => {})
          }
        }
      }

      // Get recent files
      const files = await slack.getChannelFiles(sourceId)
      if (files.length > 0) {
        const fileLinks = files.slice(0, 5)
          .map(f => `• <${f.permalink}|${f.name}>`)
          .join('\n')
        await slack.postToChannel(hire.channelId, {
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📁 *Files from <#${sourceId}>:*\n${fileLinks}`
            }
          }]
        })
      }

      console.log(`✅ Documents shared from #${name}`)
    }
  } catch (err) {
    console.error('shareOnboardingDocuments error:', err.message)
  }
}

module.exports = { onboardNewHire, checkAndReportProfile, sendDayOneMessage, sendCheckinReminder, shareOnboardingDocuments }
