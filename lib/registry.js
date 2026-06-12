// In-memory hire registry — populated when /onboard is run.
// Lost on serverless cold start; cron functions will skip if empty (expected until a DB is added).

const hires = []

function addHire(hire) {
  const existing = hires.findIndex(h => h.slackId === hire.slackId)
  const entry = {
    name: hire.name || 'New Hire',
    firstName: hire.firstName || (hire.name || '').split(' ')[0],
    role: hire.role || 'AI Department',
    slackId: hire.slackId || '',
    channelId: hire.channelId || '',
    startDate: hire.startDate || new Date().toLocaleDateString('en-US'),
    daysSinceStart: 0
  }
  if (existing >= 0) {
    hires[existing] = entry
  } else {
    hires.push(entry)
  }
  console.log(`📋 Registry: ${entry.name} added (${hires.length} total)`)
}

function getActiveOnboardees() {
  const today = new Date()
  return hires.map(h => {
    const start = new Date(h.startDate)
    const days = isNaN(start.getTime()) ? 0 : Math.floor((today - start) / (1000 * 60 * 60 * 24))
    return { ...h, daysSinceStart: days }
  })
}

function getHireBySlackId(slackId) {
  return hires.find(h => h.slackId === slackId) || null
}

function removeHire(slackId) {
  const idx = hires.findIndex(h => h.slackId === slackId)
  if (idx >= 0) hires.splice(idx, 1)
}

module.exports = { addHire, getActiveOnboardees, getHireBySlackId, removeHire }
