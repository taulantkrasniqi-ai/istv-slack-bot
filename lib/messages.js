const PDF_URL = process.env.ONBOARDING_PDF_URL || 'https://drive.google.com/your-pdf-link'

// ── Welcome message posted in #onboarding channel ────────────────────────────
function welcomeMessage(hire) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Welcome to the AI Department, ${hire.firstName}. You made it through a process that cuts most people. Don't waste it.*`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Your role:* ${hire.role}\n*Start date:* ${hire.startDate}\n*Your manager:* Tyler Mills`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📄 *Read this first — your complete onboarding guide:*\n<${PDF_URL}|ISTV AI Department New Hire Onboarding Guide>\n\nEverything you need to know before, during, and after day one is in that document. Read it today.`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Your day one checklist:*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `☐ Read the AI Department Primer\n☐ Read the Knowledge Capture Standard\n☐ Read your Role Profile\n☐ Complete your Slack profile fully (photo, title, timezone, phone, responsibilities)\n☐ Confirm all software access is working\n☐ Confirm DLOA format with Tyler in your first meeting`
        }
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*First week expectations:*\n• Day 2: building starts. Not day 5. Day 2.\n• Every day by 5pm EST: post your DLOA in this channel\n• Friday EOD: submit your first status update\n• You are responsible for scheduling your 7-day, 14-day, and 30-day check-ins`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*What you are joining matters.* We are building a connected AI layer across the entire company. Not six disconnected tools. One system that compounds. Your work feeds the substrate and the substrate makes everyone's work smarter. That is the moat. You are part of building it from day one.\n\n*Let's go.*`
        }
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Questions? Message Taulant in this channel. Do not DM Tyler unless it is urgent. | This bot will remind you about your DLOA every day at 4:30pm EST.`
        }]
      }
    ]
  }
}

// ── DM sent to new hire when bot first contacts them ─────────────────────────
function newHireDM(hire) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hey ${hire.firstName} 👋 I'm the ISTV AI Department onboarding bot. I'll guide you through everything you need to do before and during your first week.`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Your personal onboarding channel has been created:* <#${hire.channelId}>\n\nEverything happens there. Check it now.`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Before day one, do these three things:*\n1. Read the onboarding guide: <${PDF_URL}|Click here>\n2. Fill out your intake form: <${process.env.ONBOARDING_FORM_URL || 'https://your-app.vercel.app'}|Click here>\n3. Complete your Slack profile (photo, title, timezone, phone, responsibilities)`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Reply to this DM anytime if you have questions. I'll do my best to answer. If I can't, I'll flag Taulant.`
        }
      }
    ]
  }
}

// ── Slack profile check message ───────────────────────────────────────────────
function profileIncompleteMessage(firstName, missing) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hey ${firstName} — your Slack profile is not complete yet. These fields are missing or empty:`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: missing.map(f => `• ${f}`).join('\n')
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `To fix it: click your profile picture in Slack → Edit Profile → fill in all fields.\n\nRequired fields: *professional photo, job title, phone number (with country code), timezone, department (AI Department), manager (Tyler Mills), typical working hours, responsibilities (200 chars max).*\n\nThis must be done before your first day.`
        }
      }
    ]
  }
}

function profileCompleteMessage(firstName) {
  return {
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✅ Nice one ${firstName} — Slack profile looks complete. You're all set on that front.`
      }
    }]
  }
}

// ── DLOA reminder ─────────────────────────────────────────────────────────────
function dloaReminder(firstName, channelId) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏰ *End of day reminder, ${firstName}.*\n\nPost your DLOA in <#${channelId}> (or in *#sd-dloa-tyler* if that's where Tyler confirmed) before you log off.\n\n*Format:*\n\`\`\`EOD Date: [date]\nRole: [your role]\nTasks Completed Today:\n• [X min] Task description\n• [X min] Task description\nBlockers: [none or describe]\nTomorrow: [what you're working on]\`\`\``
        }
      }
    ]
  }
}

function dloaMissingAlert(hire) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *DLOA missing* — <@${hire.slackId}> (${hire.name}) has not posted their DLOA today. It's past 6pm EST.`
        }
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Role: ${hire.role} | Channel: <#${hire.channelId}>` }]
      }
    ]
  }
}

// ── Day one morning message ───────────────────────────────────────────────────
function dayOneMessage(hire) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `☀️ *Good morning ${hire.firstName}. It's day one.*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*This morning — read these three documents:*\n• AI Department Primer\n• Knowledge Capture Standard\n• Your Role Profile\n\nTyler will send you the links if you don't have them. Message Taulant here if you're missing anything.`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*This afternoon — your first meeting with Tyler.*\nHe'll cover current priorities, your first project, and how the first week works. Come having read the documents above.`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Today by 5pm EST — post your first DLOA in this channel.*\nSame format, every day, no reminders needed after today.`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Starting tomorrow: building starts. Not next week. Tomorrow.`
        }
      }
    ]
  }
}

// ── Checkin reminders ─────────────────────────────────────────────────────────
function checkinReminder(hire, days) {
  const messages = {
    7: `It's been 7 days since ${hire.firstName} started. *7-day check-in is due.* ${hire.firstName}, please reach out to Taulant to schedule this. It's your responsibility to book it.`,
    14: `Two weeks in for ${hire.firstName}. *14-day check-in is due.* By now you should have: a working system doc, at least 2 decision log entries, and visible progress on your first project. ${hire.firstName}, book this with Taulant.`,
    30: `One month in for ${hire.firstName}. *30-day documentation audit and role fit assessment is due.* Tyler runs the handoff test. ${hire.firstName}, book this with Tyler directly.`,
    90: `*90-day keeper decision is due for ${hire.firstName} (${hire.role}).* @${process.env.TYLER_SLACK_ID} — keep or cut. This is the formal decision.`
  }
  return {
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📅 ${messages[days] || `Check-in reminder for ${hire.firstName} at day ${days}.`}`
      }
    }]
  }
}

// ── New hire alert for admins ─────────────────────────────────────────────────
function newHireAlert(hire) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🟢 *New hire onboarded automatically*`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Name:*\n${hire.name}` },
          { type: 'mrkdwn', text: `*Role:*\n${hire.role}` },
          { type: 'mrkdwn', text: `*Slack ID:*\n${hire.slackId || 'Pending intake form'}` },
          { type: 'mrkdwn', text: `*Start date:*\n${hire.startDate}` },
          { type: 'mrkdwn', text: `*Channel:*\n<#${hire.channelId}>` },
          { type: 'mrkdwn', text: `*Email:*\n${hire.email || 'Not yet captured'}` }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ Channel created\n✅ Welcome message posted\n✅ DM sent to new hire\n✅ Onboarding tracker updated\n⏳ Slack profile check: pending (runs in 24hrs)\n⏳ Intake form: pending`
        }
      }
    ]
  }
}

// ── DLOA analysis from Claude ─────────────────────────────────────────────────
function dloaAnalysisMessage(hire, analysis) {
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🤖 *DLOA analysis for ${hire.name} — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: analysis
        }
      }
    ]
  }
}

module.exports = {
  welcomeMessage,
  newHireDM,
  profileIncompleteMessage,
  profileCompleteMessage,
  dloaReminder,
  dloaMissingAlert,
  dayOneMessage,
  checkinReminder,
  newHireAlert,
  dloaAnalysisMessage
}
