require('dotenv').config()
const Anthropic = require('@anthropic-ai/sdk')
const knowledge = require('./knowledge')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Analyse a DLOA ────────────────────────────────────────────────────────────
async function analyseDLOA(hire, dloaText, previousDLOAs = []) {
  const context = previousDLOAs.length > 0
    ? `Previous DLOAs from this person:\n${previousDLOAs.slice(-3).join('\n---\n')}\n\n`
    : ''

  const prompt = `You are assessing a DLOA (Daily List of Activities) for Tyler Mills (Chief of Staff, ISTV AI Department).

${context}Today's DLOA from ${hire.name} (${hire.role}, day ${hire.daysSinceStart || '?'} of 90):

${dloaText}

Assess in 4 sentences max:
1. Is output appropriate for day ${hire.daysSinceStart || '?'} of 90?
2. Is documentation being done (system docs, decision logs)?
3. Any red flags — low output, vague tasks, repeated blockers, no docs?
4. One specific question Tyler should ask this person tomorrow if anything is off.

Be direct. Tyler has no patience for softening. If output is low, say it.
Format: plain text, no bullets, under 80 words.
End your response with a line exactly like: SCORE: 7/10`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 220,
      messages: [{ role: 'user', content: prompt }]
    })
    const fullText = response.content[0].text
    const scoreMatch = fullText.match(/SCORE:\s*(\d+)\/10/i)
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null
    const text = fullText.replace(/\n?SCORE:\s*\d+\/10\s*$/i, '').trim()
    return { text, score }
  } catch (err) {
    console.error('Claude DLOA analysis failed:', err.message)
    return null
  }
}

// ── Answer a new hire question using knowledge base ───────────────────────────
async function answerNewHireQuestion(question, hireName, hireRole) {
  // First search the knowledge base
  const { answer, sources } = await knowledge.answerFromKnowledge(question, hireName, hireRole)

  // Format with sources if available
  let formatted = answer
  if (sources.length > 0) {
    formatted += `\n\n_Sources: ${sources.join(', ')}_`
  }

  return formatted
}

// ── Generate weekly summary for Tyler and Taulant ─────────────────────────────
async function generateWeeklySummary(hire, weekDLOAs) {
  if (!weekDLOAs || weekDLOAs.length === 0) {
    return `No DLOAs posted this week. Needs immediate follow-up.`
  }

  const prompt = `Summarise this week's work for ${hire.name} (${hire.role}, day ${hire.daysSinceStart || '?'} of 90):

DLOAs this week (${weekDLOAs.length}/5 posted):
${weekDLOAs.join('\n---\n')}

Write a 3-sentence summary covering:
- Output level and consistency
- Documentation habits (system docs, decision logs)
- On track / at risk / off track for 90-day keeper decision

Direct and honest. Under 60 words.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
  } catch (err) {
    return `${weekDLOAs.length}/5 DLOAs posted this week. Manual review needed.`
  }
}

// ── Answer an @mention question in any channel ────────────────────────────────
async function answerMention(question, askerName, askerRole, channelContext = '') {
  const { answer, sources, chunksUsed } = await knowledge.answerFromKnowledge(
    question, askerName, askerRole
  )

  let response = answer

  if (sources.length > 0 && chunksUsed > 0) {
    response += `\n\n_Based on: ${sources.join(' · ')}_`
  }

  return response
}

// ── Generate meeting summary from transcript ──────────────────────────────────
async function generateMeetingSummary(transcriptText, meetingTitle) {
  const prompt = `Summarise this Zoom meeting transcript for the ISTV AI Department.

Meeting: ${meetingTitle}

Transcript:
${transcriptText.substring(0, 4000)}${transcriptText.length > 4000 ? '\n[truncated...]' : ''}

Extract:
1. Key decisions made (bullet points)
2. Action items with owner if mentioned (bullet points)
3. Open questions or blockers raised
4. One-sentence summary of the overall meeting

Be brief and direct. Total response under 200 words.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
  } catch (err) {
    console.error('Meeting summary failed:', err.message)
    return null
  }
}

// ── Suggest first project based on questionnaire answers ─────────────────────
async function suggestFirstProject(hire, answers) {
  const answersText = answers
    ? Object.entries(answers).map(([k, v]) => `- ${k}: ${v}`).join('\n')
    : 'No answers provided'

  const prompt = `You are Tyler Mills, Chief of Staff at ISTV AI Department.

New hire profile:
- Name: ${hire.name}
- Role: ${hire.role}

Onboarding questionnaire answers:
${answersText}

Current department projects: Sales bot, customer service automation, knowledge layer, recruiting automation, content pipelines

Suggest the best first project for this person. Be specific. One paragraph, under 60 words. Focus on what they can contribute immediately given their role and answers.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
  } catch (err) {
    return null
  }
}

// ── Summarise a Slack thread ──────────────────────────────────────────────────
async function summariseThread(channelName, messages) {
  const prompt = `Summarise this Slack thread from #${channelName} in 3 sentences, under 80 words. Be direct and factual.

Messages:
${messages.join('\n')}

TL;DR:`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text.trim()
  } catch (err) {
    console.error('summariseThread failed:', err.message)
    return null
  }
}

// ── Generate weekly knowledge digest from questions ───────────────────────────
async function generateKnowledgeDigest(questions) {
  if (!questions || questions.length === 0) return null

  const prompt = `Here are questions asked by new hires this week in the ISTV AI Department:

${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Identify the top 5 themes or topics these questions cluster around. Format as a numbered list with a short title and one-sentence description for each theme. Under 150 words total.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 250,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text.trim()
  } catch (err) {
    console.error('generateKnowledgeDigest failed:', err.message)
    return null
  }
}

// ── Summarise a channel's activity for EOD digest ────────────────────────────
async function summariseChannelActivity(channelName, messagesText) {
  const prompt = `Summarise today's activity in Slack channel #${channelName} for the ISTV AI Department daily digest.

Messages:
${messagesText.substring(0, 3000)}

Write 2–3 sentences covering: what was discussed or worked on, any decisions/blockers/actions, overall activity level. Direct and factual. Under 60 words.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
  } catch (err) {
    console.error(`Channel summary failed for #${channelName}:`, err.message)
    return null
  }
}

module.exports = {
  analyseDLOA,
  answerNewHireQuestion,
  generateWeeklySummary,
  answerMention,
  generateMeetingSummary,
  suggestFirstProject,
  summariseChannelActivity,
  summariseThread,
  generateKnowledgeDigest
}
