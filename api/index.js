require('dotenv').config()

const express = require('express')
const { createHmac, timingSafeEqual } = require('crypto')

// ── Lib imports ───────────────────────────────────────────────────────────────
const slack = require('../lib/slack')
const claudeAI = require('../lib/claude')
const cronJobs = require('../lib/cron')
const messages = require('../lib/messages')
const sheets = require('../lib/sheets')
const onboarding = require('../lib/onboarding')
const knowledge = require('../lib/knowledge')
const zoom = require('../lib/zoom')
const monday = require('../lib/monday')

const app = express()

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}))
app.use(express.urlencoded({ extended: true }))

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
  version: '2.0.0',
  features: ['onboarding', 'rag-knowledge-base', 'dloa-analysis', 'monday-sync', 'zoom-transcripts', 'slack-chat']
}))

app.get('/health', (req, res) => res.json({ ok: true }))

// ─────────────────────────────────────────────────────────────────────────────
// SLACK EVENTS
// ─────────────────────────────────────────────────────────────────────────────
app.post('/slack/events', async (req, res) => {
  // URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge })
  }

  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }

  // Respond immediately — process async
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
  // Ignore bot messages
  if (event.bot_id || event.subtype === 'bot_message') return

  // @mention in any channel — trigger knowledge base Q&A
  if (event.type === 'app_mention' && event.text) {
    await handleMention(event)
    return
  }

  // Message in a channel (DLOA detection)
  if (event.type === 'message' && event.channel_type !== 'im' && event.text) {
    await handleChannelMessage(event)
    return
  }

  // DM to the bot — Q&A
  if (event.type === 'message' && event.channel_type === 'im' && event.text) {
    await handleDM(event)
    return
  }

  // New workspace member
  if (event.type === 'team_join') {
    await handleNewMember(event.user)
    return
  }
}

// ── Handle @mentions in any channel ──────────────────────────────────────────
async function handleMention(event) {
  const channelId = event.channel
  const userId = event.user
  const threadTs = event.thread_ts || event.ts

  // Strip the bot mention from the text
  const rawText = event.text || ''
  const question = rawText.replace(/<@[A-Z0-9]+>/g, '').trim()

  if (!question) return

  console.log(`💬 @mention from ${userId}: ${question.substring(0, 80)}`)

  // Show typing indicator
  try {
    await slack.client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'thinking_face' })
  } catch {}

  // Look up who this person is
  let askerName = 'Team member'
  let askerRole = ''
  try {
    const onboardees = await sheets.getActiveOnboardees()
    const hire = onboardees.find(h => h['⭐ Slack ID ⭐'] === userId || h['Slack ID'] === userId)
    if (hire) {
      askerName = hire['Name']
      askerRole = hire['Role']
    }
  } catch {}

  // Answer from knowledge base
  const answer = await claudeAI.answerMention(question, askerName, askerRole)

  // Remove thinking indicator
  try {
    await slack.client.reactions.remove({ channel: channelId, timestamp: event.ts, name: 'thinking_face' })
  } catch {}

  // Reply in thread
  await slack.postToChannel(channelId, {
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: answer }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_Answered by ISTV Bot using department knowledge base_` }]
      }
    ],
    thread_ts: threadTs
  })
}

// ── Handle messages in channels (DLOA detection) ─────────────────────────────
async function handleChannelMessage(event) {
  const text = event.text || ''
  const userId = event.user
  const channelId = event.channel

  if (!slack.looksLikeDLOA(text)) return

  console.log(`📝 DLOA detected from ${userId}`)
  cronJobs.recordDLOA(userId, text)

  // React with checkmark
  try {
    await slack.client.reactions.add({ channel: channelId, timestamp: event.ts, name: 'white_check_mark' })
  } catch {}

  // Get hire info
  let hire = null
  try {
    const onboardees = await sheets.getActiveOnboardees()
    hire = onboardees.find(h => h['⭐ Slack ID ⭐'] === userId || h['Slack ID'] === userId)
  } catch {}

  if (!hire) return

  const startDate = new Date(hire['Start Date'])
  const daysSinceStart = Math.floor((new Date() - startDate) / (1000 * 60 * 60 * 24))
  const hireData = { name: hire['Name'], role: hire['Role'], daysSinceStart }

  // Run DLOA analysis and Monday sync in parallel
  const [analysis, mondayResult] = await Promise.allSettled([
    claudeAI.analyseDLOA(hireData, text, cronJobs.getDLOAs(userId).slice(-3).map(d => d.text)),
    monday.syncDLOAToMonday(text, hireData)
  ])

  // Send analysis to admin channel
  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (adminChannel && analysis.status === 'fulfilled' && analysis.value) {
    await slack.postToChannel(adminChannel, messages.dloaAnalysisMessage(hireData, analysis.value))
  }

  // Also store DLOA in knowledge base for future Q&A
  const dloaTitle = `DLOA: ${hire['Name']} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  await knowledge.addDocument(dloaTitle, text, 'dloa', {
    slackId: userId,
    name: hire['Name'],
    role: hire['Role'],
    daysSinceStart
  }).catch(() => {})
}

// ── Handle DMs to the bot ─────────────────────────────────────────────────────
async function handleDM(event) {
  const text = event.text || ''
  const userId = event.user

  if (!text.trim()) return

  console.log(`💬 DM from ${userId}: ${text.substring(0, 60)}`)

  // Find this person
  let hireName = 'Team member'
  let hireRole = ''
  try {
    const onboardees = await sheets.getActiveOnboardees()
    const hire = onboardees.find(h => h['⭐ Slack ID ⭐'] === userId || h['Slack ID'] === userId)
    if (hire) { hireName = hire['Name']; hireRole = hire['Role'] }
  } catch {}

  try {
    const answer = await claudeAI.answerNewHireQuestion(text, hireName, hireRole)
    await slack.sendDM(userId, answer)
  } catch (err) {
    await slack.sendDM(userId, `I couldn't process that right now. Message Taulant in your onboarding channel for help.`)
  }
}

// ── Handle new workspace member ───────────────────────────────────────────────
async function handleNewMember(user) {
  if (!user || user.is_bot) return
  console.log(`👋 New member joined: ${user.real_name || user.name}`)

  try {
    const roster = await sheets.getHiredRoster()
    const hire = roster.find(h =>
      h['Name'] && h['Name'].toLowerCase().includes((user.real_name || '').toLowerCase().split(' ')[0]) ||
      (user.profile?.email && h['Company Email'] === user.profile.email)
    )

    if (hire && !hire['Onboarding Channel']) {
      await onboarding.onboardNewHire({
        name: hire['Name'],
        role: hire['Role'],
        slackId: user.id,
        email: user.profile?.email || hire['Company Email'] || '',
        startDate: hire['Start Date'] || new Date().toLocaleDateString('en-US'),
        _rowIndex: hire._rowIndex
      })
    }
  } catch (err) {
    console.error('New member handler error:', err.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAKE.COM WEBHOOK — New hire trigger from Make.com
// POST /webhook/new-hire
// Body: { secret, name, role, email, slackEmail, startDate }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/new-hire', async (req, res) => {
  const { secret, name, role, email, slackEmail, startDate } = req.body

  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Invalid secret' })
  }

  if (!name || !role) {
    return res.status(400).json({ error: 'name and role are required' })
  }

  try {
    // Find their Slack ID by email if slackEmail is provided
    let slackId = ''
    if (slackEmail || email) {
      const user = await slack.findUserByEmail(slackEmail || email)
      if (user) slackId = user.id
    }

    const result = await onboarding.onboardNewHire({
      name,
      role,
      slackId,
      email: email || '',
      startDate: startDate || new Date().toLocaleDateString('en-US')
    })

    res.json({ ok: true, result })
  } catch (err) {
    console.error('Make.com webhook error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ZOOM WEBHOOK — Receives recording.completed events
// POST /webhook/zoom
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/zoom', async (req, res) => {
  // Zoom URL validation challenge
  if (req.body?.event === 'endpoint.url_validation') {
    const hashForValidate = createHmac('sha256', process.env.ZOOM_VERIFICATION_TOKEN || '')
      .update(req.body.payload.plainToken)
      .digest('hex')
    return res.json({
      plainToken: req.body.payload.plainToken,
      encryptedToken: hashForValidate
    })
  }

  // Verify token
  if (!zoom.verifyZoomWebhook(req)) {
    return res.status(401).json({ error: 'Invalid Zoom token' })
  }

  // Respond immediately
  res.status(200).json({ ok: true })

  // Process async
  try {
    const result = await zoom.handleZoomWebhook(req.body)
    console.log('Zoom webhook processed:', result)

    // If a transcript was added, post summary to admin channel
    if (result.ok && result.chunksAdded > 0 && process.env.ADMIN_CHANNEL_ID) {
      const summaryText = `📹 *Zoom transcript added to knowledge base*\n*Meeting:* ${result.title}\n*Participants:* ${(result.participants || []).join(', ') || 'Unknown'}\n*Chunks indexed:* ${result.chunksAdded}\n\nYou can now @mention the bot in any channel to ask questions about this meeting.`

      await slack.postToChannel(process.env.ADMIN_CHANNEL_ID, {
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: summaryText }
        }]
      })
    }
  } catch (err) {
    console.error('Zoom webhook processing error:', err.message)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE API
// ─────────────────────────────────────────────────────────────────────────────

// GET /knowledge — list all documents
app.get('/knowledge', async (req, res) => {
  const auth = req.headers['x-api-key']
  if (auth !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })
  const docs = knowledge.listDocuments()
  res.json({ ok: true, count: docs.length, documents: docs })
})

// POST /knowledge/add — manually add a document
app.post('/knowledge/add', async (req, res) => {
  const auth = req.headers['x-api-key']
  if (auth !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })

  const { title, content, type } = req.body
  if (!title || !content) return res.status(400).json({ error: 'title and content required' })

  try {
    const chunks = await knowledge.addDocument(title, content, type || 'document')
    res.json({ ok: true, title, chunksAdded: chunks })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// POST /knowledge/search — search the knowledge base
app.post('/knowledge/search', async (req, res) => {
  const auth = req.headers['x-api-key']
  if (auth !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })

  const { query } = req.body
  if (!query) return res.status(400).json({ error: 'query required' })

  try {
    const results = await knowledge.searchKnowledge(query)
    res.json({ ok: true, count: results.length, results })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// DELETE /knowledge/:title — delete a document
app.delete('/knowledge/:title', async (req, res) => {
  const auth = req.headers['x-api-key']
  if (auth !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' })

  const title = decodeURIComponent(req.params.title)
  const deleted = knowledge.deleteDocument(title)
  res.json({ ok: true, deleted })
})

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL TRIGGERS
// ─────────────────────────────────────────────────────────────────────────────

// POST /trigger/onboard — manually trigger onboarding (testing)
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

// POST /trigger/zoom-transcript — manually upload a Zoom VTT transcript
app.post('/trigger/zoom-transcript', async (req, res) => {
  const { secret, title, content } = req.body

  if (secret !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'Invalid secret' })
  if (!title || !content) return res.status(400).json({ error: 'title and content required' })

  try {
    const result = await zoom.addTranscriptFromText(title, content)
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// GET /cron/poll — Vercel cron endpoint to poll Google Sheets
app.get('/cron/poll', async (req, res) => {
  const auth = req.headers['x-cron-secret'] || req.query.secret
  if (auth !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Unauthorized' })

  try {
    await cronJobs.pollForNewHires()
    res.json({ ok: true, time: new Date().toISOString() })
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
  console.log('  ISTV AI Department Slack Bot v2')
  console.log('  The Shipping Department — AI Engine of ISTV')
  console.log('═'.repeat(55))
  console.log(`  Port: ${PORT}`)
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`)
  console.log('═'.repeat(55))
  console.log('  Features:')
  console.log('  ✓ Onboarding automation (channel, welcome, channels)')
  console.log('  ✓ DLOA detection + Claude analysis')
  console.log('  ✓ DLOA → Monday.com sync')
  console.log('  ✓ RAG knowledge base (department docs + transcripts)')
  console.log('  ✓ @mention Q&A in any channel')
  console.log('  ✓ DM Q&A for new hires')
  console.log('  ✓ Zoom transcript webhook → knowledge base')
  console.log('  ✓ Make.com webhook → auto-onboarding')
  console.log('═'.repeat(55) + '\n')

  // Seed knowledge base with department docs
  try {
    await knowledge.seedDepartmentDocs()
  } catch {}

  // Register cron jobs
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_CRON === 'true') {
    cronJobs.registerCronJobs()
    console.log('✅ Cron jobs active\n')
  } else {
    console.log('⚠️  Cron jobs disabled (set ENABLE_CRON=true to enable locally)\n')
  }
})

module.exports = app
