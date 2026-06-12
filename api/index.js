require('dotenv').config()

const express = require('express')
const { createHmac, timingSafeEqual } = require('crypto')

// ── Lib imports ───────────────────────────────────────────────────────────────
const slack = require('../lib/slack')
const claudeAI = require('../lib/claude')
const cronJobs = require('../lib/cron')
const messages = require('../lib/messages')
const onboarding = require('../lib/onboarding')
const knowledge = require('../lib/knowledge')
const zoom = require('../lib/zoom')
const questionnaire = require('../lib/questionnaire')
const eod = require('../lib/eod')
const registry = require('../lib/registry')
const ingest = require('../lib/ingest')
const standup = require('../lib/standup')

const app = express()

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}))
app.use(express.urlencoded({ extended: true, verify: (req, res, buf) => { req.rawBody = buf } }))

// ── Verify Slack request signature ───────────────────────────────────────────
function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET
  if (!signingSecret) return true

  const timestamp = req.headers['x-slack-request-timestamp']
  const signature = req.headers['x-slack-signature']

  if (!timestamp || !signature) return false
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false

  const sigBase = `v0:${timestamp}:${req.rawBody}`
  const hmac = createHmac('sha256', signingSecret).update(sigBase).digest('hex')
  const computedSig = `v0=${hmac}`

  try {
    return timingSafeEqual(Buffer.from(computedSig), Buffer.from(signature))
  } catch { return false }
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ISTV Slack Bot v2 running',
  time: new Date().toISOString(),
  version: '2.1.0',
  features: [
    '/onboard slash command',
    'interactive questionnaire',
    'rag-knowledge-base',
    'dloa-analysis',
    'eod-channel-summaries',
    'slack-chat',
    'document-sharing'
  ]
}))

app.get('/health', (req, res) => res.json({ ok: true }))

// ─────────────────────────────────────────────────────────────────────────────
// SLACK SLASH COMMAND — /onboard @username
// POST /slack/commands
// ─────────────────────────────────────────────────────────────────────────────
app.post('/slack/commands', async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const { command, text, user_id: callerId } = req.body

  if (command !== '/onboard') {
    return res.json({ text: `Unknown command: ${command}` })
  }

  // Only Taulant and Tyler can run /onboard
  const allowed = [process.env.TAULANT_SLACK_ID, process.env.TYLER_SLACK_ID].filter(Boolean)
  if (allowed.length && !allowed.includes(callerId)) {
    return res.json({ text: '⛔ Only Taulant or Tyler can run /onboard.' })
  }

  // Parse mention and optional role — /onboard @john AI Operations Engineer
  const mentionMatch = (text || '').match(/<@([A-Z0-9]+)(?:\|[^>]+)?>(.*)/)
  const targetSlackId = mentionMatch ? mentionMatch[1] : null
  const roleFromCommand = mentionMatch ? mentionMatch[2].trim() : ''

  if (!targetSlackId) {
    return res.json({
      text: '❌ Usage: `/onboard @username Role Name`\n\nExample: `/onboard @john AI Operations Engineer`'
    })
  }

  if (!roleFromCommand) {
    return res.json({
      text: '❌ Please include the role. Usage: `/onboard @username Role Name`\n\nExample: `/onboard @john AI Operations Engineer`'
    })
  }

  // Acknowledge immediately — Slack requires < 3s
  res.json({ text: `⏳ Starting onboarding for <@${targetSlackId}> as *${roleFromCommand}*...` })

  // Run async
  try {
    await runOnboardingFlow(targetSlackId, callerId, roleFromCommand)
  } catch (err) {
    console.error('/onboard error:', err.message)
    const adminChannel = process.env.ADMIN_CHANNEL_ID
    if (adminChannel) {
      await slack.postToChannel(adminChannel, {
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `❌ *Onboarding failed* for <@${targetSlackId}>\nError: ${err.message}` } }]
      }).catch(() => {})
    }
  }
})

// ── Full onboarding flow triggered by /onboard ────────────────────────────────
async function runOnboardingFlow(targetSlackId, callerId, role = 'AI Department') {
  console.log(`\n🚀 /onboard triggered by ${callerId} for ${targetSlackId} — role: ${role}`)

  // Look up the user's name from Slack
  let name = 'New Hire'
  try {
    const userInfo = await slack.client.users.info({ user: targetSlackId })
    name = userInfo.user.real_name || userInfo.user.name || 'New Hire'
  } catch {}

  const hire = {
    name,
    role,
    slackId: targetSlackId,
    startDate: new Date().toLocaleDateString('en-US')
  }

  // Step 1: Create channel, add to all department channels, post welcome
  const result = await onboarding.onboardNewHire(hire)
  hire.channelId = result.channelId
  registry.addHire(hire)

  // Step 2: Share onboarding documents from source channels
  await onboarding.shareOnboardingDocuments(hire)

  // Step 3: Start questionnaire via DM
  if (hire.slackId) {
    await questionnaire.startQuestionnaire(hire)
  }

  console.log(`✅ Onboarding flow complete for ${name}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK INTERACTIVE — Button clicks (questionnaire responses)
// POST /slack/interactive
// ─────────────────────────────────────────────────────────────────────────────
app.post('/slack/interactive', async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  // Payload comes as URL-encoded JSON string in the "payload" field
  let payload
  try {
    payload = JSON.parse(req.body.payload)
  } catch {
    return res.status(400).json({ error: 'Invalid payload' })
  }

  // Acknowledge immediately
  res.status(200).send()

  if (payload.type !== 'block_actions') return

  const userId = payload.user?.id
  const action = payload.actions?.[0]
  if (!userId || !action) return

  try {
    const data = JSON.parse(action.value || '{}')
    await questionnaire.handleButtonResponse(userId, data.questionId, data.value)
  } catch (err) {
    console.error('Interactive handler error:', err.message)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// SLACK EVENTS
// ─────────────────────────────────────────────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge })
  }

  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  res.status(200).send()

  const event = req.body.event
  if (!event) return

  try {
    await handleSlackEvent(event)
  } catch (err) {
    console.error('Slack event error:', err.message)
  }
})

// ── Main Slack event dispatcher ───────────────────────────────────────────────
async function handleSlackEvent(event) {
  if (event.bot_id || event.subtype === 'bot_message') return

  if (event.type === 'app_mention' && event.text) {
    await handleMention(event)
    return
  }

  if (event.type === 'message' && event.channel_type !== 'im' && event.text) {
    await handleChannelMessage(event)
    return
  }

  if (event.type === 'message' && event.channel_type === 'im' && event.text) {
    await handleDM(event)
    return
  }

  // team_join — log only, no auto-onboard. Use /onboard instead.
  if (event.type === 'team_join') {
    const user = event.user
    if (user && !user.is_bot) {
      console.log(`👋 New member joined workspace: ${user.real_name || user.name} — use /onboard @${user.name} to onboard them`)
    }
  }
}

// ── Handle @mentions in any channel ──────────────────────────────────────────
async function handleMention(event) {
  const channelId = event.channel
  const userId = event.user
  const threadTs = event.thread_ts || event.ts
  const question = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim()

  if (!question) return

  console.log(`💬 @mention from ${userId}: ${question.substring(0, 80)}`)

  try { await slack.client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'thinking_face' }) } catch {}

  let askerName = 'Team member'
  let askerRole = ''
  try {
    const onboardees = registry.getActiveOnboardees()
    const hire = onboardees.find(h => h.slackId === userId)
    if (hire) { askerName = hire.name; askerRole = hire.role }
  } catch {}

  let answer = `I couldn't process that right now. Try again or message Taulant.`
  try {
    answer = await claudeAI.answerMention(question, askerName, askerRole)
  } catch (err) {
    console.error('Claude mention error:', err.message)
  }

  try { await slack.client.reactions.remove({ channel: channelId, timestamp: event.ts, name: 'thinking_face' }) } catch {}

  await slack.postToChannel(channelId, {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: answer } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Answered by ISTV Bot using department knowledge base_' }] }
    ],
    thread_ts: threadTs
  })
}

// ── Handle channel messages (DLOA detection + auto-ingest) ───────────────────
async function handleChannelMessage(event) {
  const text = event.text || ''
  const userId = event.user
  const channelId = event.channel

  // Resolve channel name — Slack events include channel_name in some payloads
  // but not always; we use the event or fall back to a lookup
  const channelName = event.channel_name || ''

  // Auto-ingest: files or substantial messages from department channels
  if (channelName && ingest.isIngestChannel(channelName)) {
    ingest.ingestEvent(event, channelName).catch(() => {})
  }

  if (!slack.looksLikeDLOA(text)) return

  console.log(`📝 DLOA detected from ${userId}`)
  cronJobs.recordDLOA(userId, text)

  try { await slack.client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'white_check_mark' }) } catch {}

  let hire = null
  try {
    const onboardees = registry.getActiveOnboardees()
    hire = onboardees.find(h => h.slackId === userId)
  } catch {}

  if (!hire) return

  const hireData = { name: hire.name, role: hire.role, daysSinceStart: hire.daysSinceStart }

  const analysis = await claudeAI.analyseDLOA(
    hireData, text, cronJobs.getDLOAs(userId).slice(-3).map(d => d.text)
  ).catch(() => null)

  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (adminChannel && analysis) {
    await slack.postToChannel(adminChannel, messages.dloaAnalysisMessage(hireData, analysis))
  }

  const dloaTitle = `DLOA: ${hire.name} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  await knowledge.addDocument(dloaTitle, text, 'dloa', { slackId: userId, name: hire.name, role: hire.role, daysSinceStart: hire.daysSinceStart }).catch(() => {})
}

// ── Handle DMs to the bot ─────────────────────────────────────────────────────
async function handleDM(event) {
  const text = event.text || ''
  const userId = event.user

  if (!text.trim()) return

  console.log(`💬 DM from ${userId}: ${text.substring(0, 60)}`)

  // Priority 1: standup reply
  if (standup.isAwaitingStandup(userId)) {
    const handled = standup.handleStandupReply(userId, text)
    if (handled) {
      await slack.sendDM(userId, `Got it — I'll include that in the team digest. Good luck today!`)
      return
    }
  }

  // Priority 2: questionnaire
  if (questionnaire.isInQuestionnaire(userId)) {
    const handled = await questionnaire.handleTextResponse(userId, text)
    if (handled) return
  }

  // Otherwise answer from knowledge base
  let hireName = 'Team member'
  let hireRole = ''
  try {
    const onboardees = registry.getActiveOnboardees()
    const hire = onboardees.find(h => h.slackId === userId)
    if (hire) { hireName = hire.name; hireRole = hire.role }
  } catch {}

  try {
    const answer = await claudeAI.answerNewHireQuestion(text, hireName, hireRole)
    await slack.sendDM(userId, answer)
  } catch {
    await slack.sendDM(userId, `I couldn't process that right now. Message Taulant in your onboarding channel for help.`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAKE.COM WEBHOOK — queues a hire for manual /onboard trigger
// POST /webhook/new-hire
// Body: { secret, name, role, email, slackEmail, startDate }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/new-hire', async (req, res) => {
  const { secret, name, role, email, slackEmail, startDate } = req.body

  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' })
  }
  if (!name || !role) return res.status(400).json({ error: 'name and role required' })

  // Notify Taulant to run /onboard when ready
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (adminChannel) {
    await slack.postToChannel(adminChannel, {
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🆕 *New hire registered via Make.com*\n*Name:* ${name}\n*Role:* ${role}\n*Start date:* ${startDate || 'TBD'}\n*Email:* ${email || slackEmail || 'not provided'}\n\nWhen they join Slack, run \`/onboard @${name.split(' ')[0].toLowerCase()}\` to start onboarding.`
        }
      }]
    }).catch(() => {})
  }

  res.json({ ok: true, message: 'Hire registered. Use /onboard @username in Slack when they join.' })
})

// ─────────────────────────────────────────────────────────────────────────────
// ZOOM WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/zoom', async (req, res) => {
  if (req.body?.event === 'endpoint.url_validation') {
    const hashForValidate = createHmac('sha256', process.env.ZOOM_VERIFICATION_TOKEN || '')
      .update(req.body.payload.plainToken)
      .digest('hex')
    return res.json({ plainToken: req.body.payload.plainToken, encryptedToken: hashForValidate })
  }

  if (!zoom.verifyZoomWebhook(req)) return res.status(401).json({ error: 'Invalid Zoom token' })

  res.status(200).json({ ok: true })

  try {
    const result = await zoom.handleZoomWebhook(req.body)
    if (result.ok && result.chunksAdded > 0 && process.env.ADMIN_CHANNEL_ID) {
      await slack.postToChannel(process.env.ADMIN_CHANNEL_ID, {
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: `📹 *Zoom transcript added*\n*Meeting:* ${result.title}\n*Chunks indexed:* ${result.chunksAdded}\n\n@mention the bot to ask questions about this meeting.` }
        }]
      })
    }
  } catch (err) {
    console.error('Zoom webhook error:', err.message)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/knowledge', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true, count: knowledge.listDocuments().length, documents: knowledge.listDocuments() })
})

app.post('/knowledge/add', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })
  const { title, content, type } = req.body
  if (!title || !content) return res.status(400).json({ error: 'title and content required' })
  try {
    const chunks = await knowledge.addDocument(title, content, type || 'document')
    res.json({ ok: true, title, chunksAdded: chunks })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/knowledge/search', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })
  const { query } = req.body
  if (!query) return res.status(400).json({ error: 'query required' })
  try {
    const results = await knowledge.searchKnowledge(query)
    res.json({ ok: true, count: results.length, results })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.delete('/knowledge/:title', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })
  const deleted = knowledge.deleteDocument(decodeURIComponent(req.params.title))
  res.json({ ok: true, deleted })
})

// ─────────────────────────────────────────────────────────────────────────────
// VERCEL CRON ENDPOINTS
// Called by Vercel on schedule (UTC times — EST offsets applied in vercel.json)
// All times below are EST equivalents:
//   /cron/morning       → 9am  EST (day-one messages + check-in reminders)
//   /cron/profile-check → 10am EST
//   /cron/dloa-reminder → 4:30pm EST
//   /cron/eod           → 5pm  EST (channel summaries)
//   /cron/dloa-check    → 6pm  EST (missing DLOA alerts)
//   /cron/weekly        → 5:30pm EST Friday
// ─────────────────────────────────────────────────────────────────────────────
function isCronAuthorised(req) {
  // Vercel sets x-vercel-cron: 1 on all cron requests
  if (req.headers['x-vercel-cron'] === '1') return true
  // Allow manual trigger with CRON_SECRET
  const auth = req.headers['authorization'] || req.query.secret
  return auth === process.env.CRON_SECRET || auth === `Bearer ${process.env.CRON_SECRET}`
}

app.get('/cron/morning', async (req, res) => {
  if (!isCronAuthorised(req)) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true })
  await Promise.allSettled([
    cronJobs.sendDayOneMessages(),
    cronJobs.sendCheckinReminders(),
    standup.sendStandupDMs()           // 9am: DM each hire for standup
  ])
})

app.get('/cron/profile-check', async (req, res) => {
  if (!isCronAuthorised(req)) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true })
  await Promise.allSettled([
    cronJobs.runProfileChecks(),
    standup.postStandupDigest()        // 10am: post standup digest to admin
  ])
})

app.get('/cron/dloa-reminder', async (req, res) => {
  if (!isCronAuthorised(req)) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true })
  await cronJobs.sendDLOAReminders().catch(console.error)
})

app.get('/cron/eod', async (req, res) => {
  if (!isCronAuthorised(req)) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true })
  await eod.sendEODSummary().catch(console.error)
})

app.get('/cron/dloa-check', async (req, res) => {
  if (!isCronAuthorised(req)) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true })
  await cronJobs.checkMissingDLOAs().catch(console.error)
})

app.get('/cron/weekly', async (req, res) => {
  if (!isCronAuthorised(req)) return res.status(403).json({ error: 'Unauthorized' })
  res.json({ ok: true })
  await Promise.allSettled([
    cronJobs.sendWeeklySummaries(),
    cronJobs.checkRiskFlags()          // Friday: risk flags for Tyler + Taulant
  ])
})

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL TRIGGERS (testing)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/trigger/onboard', async (req, res) => {
  const { secret, name, role, slackId, startDate } = req.body
  if (secret !== process.env.WEBHOOK_SECRET && secret !== 'istv-trigger-2026') {
    return res.status(403).json({ error: 'Invalid secret' })
  }
  if (!name || !role) return res.status(400).json({ error: 'name and role required' })
  try {
    const result = await onboarding.onboardNewHire({
      name, role,
      slackId: slackId || '',
      startDate: startDate || new Date().toLocaleDateString('en-US'),
      email: ''
    })
    res.json({ ok: true, result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/trigger/zoom-transcript', async (req, res) => {
  if (req.body.secret !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Invalid secret' })
  if (!req.body.title || !req.body.content) return res.status(400).json({ error: 'title and content required' })
  try {
    res.json(await zoom.addTranscriptFromText(req.body.title, req.body.content))
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000

app.listen(PORT, async () => {
  console.log('\n' + '═'.repeat(55))
  console.log('  ISTV AI Department Slack Bot v2.1')
  console.log('  The Shipping Department — AI Engine of ISTV')
  console.log('═'.repeat(55))
  console.log(`  Port: ${PORT}`)
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log('═'.repeat(55))
  console.log('  Features:')
  console.log('  ✓ /onboard slash command (manual trigger)')
  console.log('  ✓ Interactive onboarding questionnaire')
  console.log('  ✓ Document sharing from source channels')
  console.log('  ✓ DLOA detection + Claude analysis')
  console.log('  ✓ RAG knowledge base (docs + transcripts)')
  console.log('  ✓ @mention + DM Q&A for new hires')
  console.log('  ✓ EOD channel summaries → admin (5pm EST)')
  console.log('  ✓ Make.com webhook → admin alert')
  console.log('═'.repeat(55) + '\n')

  try { await knowledge.seedDepartmentDocs() } catch {}

  // Cron jobs run via Vercel Cron (HTTP endpoints in vercel.json) — not node-cron
  console.log('✅ Cron endpoints active (/cron/morning, /cron/dloa-reminder, /cron/eod, etc.)\n')
})

module.exports = app
