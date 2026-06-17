require('dotenv').config()
const slack = require('./slack')
const claudeAI = require('./claude')
const registry = require('./registry')

// In-memory session state: userId -> { questionIndex, answers, hire }
const sessions = {}

const QUESTIONS = [
  {
    id: 'contract_upwork',
    text: '👋 Welcome to the ISTV AI Department. This questionnaire takes about 3 minutes.\n\n*Question 1 of 8*\n\nIs your contract signed and payment set up on Upwork?',
    type: 'buttons',
    options: [
      { text: '✅ Yes, all set', value: 'yes', style: 'primary' },
      { text: '❌ Not yet', value: 'no', style: 'danger' }
    ]
  },
  {
    id: 'slack_profile',
    text: '*Question 2 of 8*\n\nHave you completed your full Slack profile?\n\n*Required:* professional photo · exact job title · phone with country code · timezone · typical working hours (EST) · department: AI Department · manager: Tyler Mills',
    type: 'buttons',
    options: [
      { text: '✅ Fully complete', value: 'yes', style: 'primary' },
      { text: '🔄 Still setting it up', value: 'partial' },
      { text: '❓ Need help', value: 'help' }
    ]
  },
  {
    id: 'read_onboarding_guide',
    text: '*Question 3 of 8*\n\nHave you read the full ISTV AI Department Onboarding Guide?\n\n_Everything about the role, culture, and 90-day expectations is in there. It must be read before day one._',
    type: 'buttons',
    options: [
      { text: '✅ Yes, read it', value: 'yes', style: 'primary' },
      { text: '📖 Not yet', value: 'no' }
    ]
  },
  {
    id: 'read_knowledge_capture',
    text: '*Question 4 of 8*\n\nHave you read the Knowledge Capture Standard?\n\n_Documentation is non-negotiable. Every system you build must be documented from day one — well enough that someone else could take it over in one working day._',
    type: 'buttons',
    options: [
      { text: '✅ Yes, read it', value: 'yes', style: 'primary' },
      { text: '📖 Not yet', value: 'no' }
    ]
  },
  {
    id: 'software_access',
    text: '*Question 5 of 8*\n\nHave you confirmed access to all required tools?\n\n• Slack ✅\n• Monday.com\n• Claude (Tyler provides team access)\n• GitHub\n• Google Calendar — subscribe to team member calendars on day one',
    type: 'buttons',
    options: [
      { text: '✅ All working', value: 'yes', style: 'primary' },
      { text: '⚠️ Some still missing', value: 'partial' }
    ]
  },
  {
    id: 'dloa_understood',
    text: '*Question 6 of 8*\n\nDo you understand the DLOA (Daily List of Activities) requirement?\n\n• Post in *#sd-dloa-tyler* every day by *5pm EST*\n• No reminders after today — it\'s your responsibility\n• Missing it is taken seriously\n\n*Format:*\n```EOD Date: [date]\nRole: [your role]\nTasks Completed Today:\n• [X min] task description\nBlockers: [none or describe]\nTomorrow: [what you\'re working on]```',
    type: 'buttons',
    options: [
      { text: '✅ Understood', value: 'yes', style: 'primary' },
      { text: '❓ I have questions', value: 'questions' }
    ]
  },
  {
    id: 'working_hours',
    text: '*Question 7 of 8*\n\nWhat are your typical working hours?\n\n_Include your local timezone AND the EST equivalent. This goes in your Slack profile._\n\n*Reply in this chat with your answer* — e.g. "9am–6pm GMT+2 / 3am–12pm EST"',
    type: 'text'
  },
  {
    id: 'first_project',
    text: '*Question 8 of 8 — last one*\n\nWhat is your first project or area of focus?\n\n_Tyler confirms this in your first meeting. Write what you understand so far, or "TBD — meeting Tyler today"._\n\n*Reply in this chat with your answer.*',
    type: 'text'
  }
]

async function startQuestionnaire(hire) {
  sessions[hire.slackId] = { questionIndex: 0, answers: {}, hire }
  await sendQuestion(hire.slackId)
}

async function sendQuestion(userId) {
  const session = sessions[userId]
  if (!session) return
  const q = QUESTIONS[session.questionIndex]
  if (!q) { await completeQuestionnaire(userId); return }

  if (q.type === 'buttons') {
    await slack.sendDM(userId, buildButtonBlock(q, userId))
  } else {
    await slack.sendDM(userId, q.text)
  }
}

function buildButtonBlock(q, userId) {
  return {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: q.text } },
      {
        type: 'actions',
        block_id: `q_${q.id}`,
        elements: q.options.map(opt => ({
          type: 'button',
          text: { type: 'plain_text', text: opt.text },
          value: JSON.stringify({ questionId: q.id, value: opt.value, userId }),
          action_id: `ans_${q.id}_${opt.value}`,
          ...(opt.style ? { style: opt.style } : {})
        }))
      }
    ]
  }
}

async function handleButtonResponse(userId, questionId, value) {
  const session = sessions[userId]
  if (!session) return

  session.answers[questionId] = value
  session.questionIndex++

  // Flag problem answers to admin immediately
  if (['no', 'partial', 'questions', 'help'].includes(value)) {
    const q = QUESTIONS.find(q => q.id === questionId)
    const adminChannel = process.env.ADMIN_CHANNEL_ID
    if (adminChannel && q) {
      const firstLine = q.text.split('\n').find(l => l && !l.startsWith('*Question'))
      await slack.postToChannel(adminChannel, {
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ *Onboarding flag* — <@${userId}> (${session.hire.name})\n*Item:* ${(firstLine || '').replace(/[*_]/g, '').substring(0, 80)}\n*Status:* ${value}`
          }
        }]
      }).catch(() => {})
    }
  }

  await sendQuestion(userId)
}

// Called from DM handler — returns true if it consumed the message
async function handleTextResponse(userId, text) {
  const session = sessions[userId]
  if (!session) return false
  const q = QUESTIONS[session.questionIndex]
  if (!q || q.type !== 'text') return false

  session.answers[q.id] = text
  session.questionIndex++
  await sendQuestion(userId)
  return true
}

async function completeQuestionnaire(userId) {
  const session = sessions[userId]
  if (!session) return
  const { hire, answers } = session

  // Store answers in registry
  registry.setQuestionnaireAnswers(hire.slackId, answers)

  await slack.sendDM(userId, {
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ *Done, ${hire.firstName}.*\n\nYour answers have been sent to Taulant. Fix anything flagged before day one.\n\nFrom here on, reply to this chat anytime if you have questions — I'll answer using department docs, onboarding guides, and meeting transcripts. I'm available 24/7.`
      }
    }]
  })

  // Post first project suggestion to hire's channel
  if (hire.channelId) {
    try {
      const suggestion = await claudeAI.suggestFirstProject(hire, answers)
      if (suggestion) {
        await slack.postToChannel(hire.channelId, {
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `💡 *First project suggestion for ${hire.firstName}:*\n${suggestion}`
            }
          }]
        })
      }
    } catch (err) {
      console.error('suggestFirstProject error:', err.message)
    }
  }

  const adminChannel = process.env.ADMIN_CHANNEL_ID
  if (adminChannel) {
    const summary = QUESTIONS.map(q => {
      const label = q.text.split('\n').find(l => l && !l.startsWith('*Question')) || q.id
      return `• ${label.replace(/[*_]/g, '').substring(0, 70)}\n  → _${answers[q.id] || 'no answer'}_`
    }).join('\n')

    await slack.postToChannel(adminChannel, {
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `📋 *Onboarding questionnaire complete*\n*${hire.name}* — ${hire.role}` }
        },
        { type: 'section', text: { type: 'mrkdwn', text: summary } }
      ]
    })
  }

  delete sessions[userId]
}

function isInQuestionnaire(userId) {
  return !!sessions[userId]
}

module.exports = { startQuestionnaire, handleButtonResponse, handleTextResponse, isInQuestionnaire }
