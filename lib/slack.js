const { WebClient } = require('@slack/web-api')

const client = new WebClient(process.env.SLACK_BOT_TOKEN)

// ── Create onboarding channel ─────────────────────────────────────────────────
async function createOnboardingChannel(hire) {
  // Use pre-computed name if set (sd-[role]-[firstname]), otherwise fallback
  const channelName = (hire.channelName || `sd-ai-${hire.firstName.toLowerCase()}`)
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 80)

  console.log(`Creating channel: #${channelName}`)

  // Create the channel
  const result = await client.conversations.create({
    name: channelName,
    is_private: true
  })

  const channelId = result.channel.id

  // Set channel topic
  await client.conversations.setTopic({
    channel: channelId,
    topic: `Onboarding channel for ${hire.name} — ${hire.role} — Started ${hire.startDate}`
  })

  // Invite Taulant, Tyler, and the new hire
  const membersToAdd = [
    process.env.TAULANT_SLACK_ID,
    process.env.TYLER_SLACK_ID,
    hire.slackId
  ].filter(Boolean)

  if (membersToAdd.length > 0) {
    await client.conversations.invite({
      channel: channelId,
      users: membersToAdd.join(',')
    })
  }

  console.log(`Channel #${channelName} created: ${channelId}`)
  return { channelId, channelName }
}

// ── Post message to a channel ─────────────────────────────────────────────────
async function postToChannel(channelId, message) {
  if (typeof message === 'string') {
    return await client.chat.postMessage({ channel: channelId, text: message })
  }
  return await client.chat.postMessage({
    channel: channelId,
    text: message.text || 'ISTV Onboarding Bot',
    blocks: message.blocks
  })
}

// ── Send DM to a user ─────────────────────────────────────────────────────────
async function sendDM(userId, message) {
  const dm = await client.conversations.open({ users: userId })
  const channelId = dm.channel.id
  if (typeof message === 'string') {
    return await client.chat.postMessage({ channel: channelId, text: message })
  }
  return await client.chat.postMessage({
    channel: channelId,
    text: message.text || 'ISTV Onboarding Bot',
    blocks: message.blocks
  })
}

// ── Check Slack profile completeness ─────────────────────────────────────────
async function checkSlackProfile(slackId) {
  try {
    const result = await client.users.info({ user: slackId })
    const profile = result.user.profile
    const missing = []

    if (!profile.image_original && !profile.image_192) missing.push('Professional photo')
    if (!profile.title || profile.title.trim() === '') missing.push('Job title (your exact role at ISTV)')
    if (!profile.phone || profile.phone.trim() === '') missing.push('Phone number (with country code)')
    if (!profile.fields) {
      missing.push('Typical working hours')
    } else {
      // Check custom fields if they exist
      const fieldValues = Object.values(profile.fields || {})
      const hasHours = fieldValues.some(f => f.value && f.value.includes('EST'))
      if (!hasHours) missing.push('Typical working hours (must include EST timezone)')
    }

    return {
      complete: missing.length === 0,
      missing,
      profile: {
        name: profile.real_name,
        title: profile.title,
        phone: profile.phone,
        hasPhoto: !!(profile.image_original || profile.image_192)
      }
    }
  } catch (err) {
    console.error('Error checking profile:', err.message)
    return { complete: false, missing: ['Could not check profile — Slack ID may be incorrect'], error: true }
  }
}

// ── Look up a user by email (to find new hire in Slack) ──────────────────────
async function findUserByEmail(email) {
  try {
    const result = await client.users.lookupByEmail({ email })
    return result.user
  } catch {
    return null
  }
}

// ── Get all workspace members ─────────────────────────────────────────────────
async function getWorkspaceMembers() {
  const result = await client.users.list()
  return result.members.filter(m => !m.is_bot && !m.deleted)
}

// ── Check if a message contains a DLOA ───────────────────────────────────────
function looksLikeDLOA(text) {
  const lower = (text || '').toLowerCase()
  return (
    lower.includes('eod') ||
    lower.includes('tasks completed') ||
    lower.includes('blockers') ||
    lower.includes('tomorrow') ||
    (lower.includes('role:') && lower.includes('date:'))
  )
}

// ── Archive the onboarding channel after 90-day decision ────────────────────
async function archiveChannel(channelId) {
  try {
    await client.conversations.archive({ channel: channelId })
    console.log(`Channel ${channelId} archived`)
  } catch (err) {
    console.error('Archive failed:', err.message)
  }
}

module.exports = {
  client,
  createOnboardingChannel,
  postToChannel,
  sendDM,
  checkSlackProfile,
  findUserByEmail,
  getWorkspaceMembers,
  looksLikeDLOA,
  archiveChannel
}

// ── Add new hire to all department channels ───────────────────────────────────
async function addToAllChannels(hire) {
  const { getAllChannelNames, getPersonalChannelName } = require('./channels')
  const channelNames = getAllChannelNames(hire)
  const results = []

  // Cache of channel name -> ID
  const channelMap = await buildChannelMap()

  for (const name of channelNames) {
    const channelId = channelMap[name]
    if (!channelId) {
      console.warn(`⚠️ Channel not found: ${name} — skipping`)
      results.push({ name, status: 'not_found' })
      continue
    }
    try {
      await client.conversations.invite({ channel: channelId, users: hire.slackId })
      console.log(`✅ Added ${hire.firstName} to #${name}`)
      results.push({ name, status: 'added', channelId })
    } catch (err) {
      // already_in_channel is fine
      if (err.data && err.data.error === 'already_in_channel') {
        results.push({ name, status: 'already_member', channelId })
      } else {
        console.error(`❌ Failed to add to #${name}:`, err.message)
        results.push({ name, status: 'error', error: err.message })
      }
    }
  }

  return results
}

// ── Build a map of channel name -> channel ID ─────────────────────────────────
async function buildChannelMap() {
  const map = {}
  try {
    let cursor
    do {
      const res = await client.conversations.list({
        types: 'public_channel,private_channel',
        limit: 200,
        cursor
      })
      for (const ch of res.channels || []) {
        map[ch.name] = ch.id
      }
      cursor = res.response_metadata && res.response_metadata.next_cursor
    } while (cursor)
  } catch (err) {
    console.error('Failed to build channel map:', err.message)
  }
  return map
}

module.exports.addToAllChannels = addToAllChannels
module.exports.buildChannelMap = buildChannelMap
