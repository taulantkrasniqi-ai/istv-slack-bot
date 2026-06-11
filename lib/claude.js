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
Format: plain text, no bullets, under 80 words.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
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
      model: 'claude-sonnet-4-20250514',
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
  } catch (err) {
    console.error('Meeting summary failed:', err.message)
    return null
  }
}

// ── Suggest first project based on intake form ────────────────────────────────
async function suggestFirstProject(hire, currentProjects) {
  const prompt = `You are Tyler Mills, Chief of Staff at ISTV AI Department. 

New hire profile:
- Name: ${hire.name}
- Role: ${hire.role}
- Top skills: ${hire.topSkills || 'not specified'}
- AI experience: ${hire.aiExperience || 'not specified'}
- Excited to build: ${hire.excitedToBuild || 'not specified'}

Current department projects:
${currentProjects || 'Sales bot, customer service automation, knowledge layer, recruiting automation, content pipelines'}

Suggest the best first project for this person. Be specific. One paragraph, under 60 words. Focus on what they can contribute immediately given their background.`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    })
    return response.content[0].text
  } catch (err) {
    return null
  }
}

module.exports = {
  analyseDLOA,
  answerNewHireQuestion,
  generateWeeklySummary,
  answerMention,
  generateMeetingSummary,
  suggestFirstProject
}
