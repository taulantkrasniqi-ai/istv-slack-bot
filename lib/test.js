require('dotenv').config()

const slack = require('./slack')
const messages = require('./messages')
const onboarding = require('./onboarding')
const sheets = require('./sheets')

// ── Run specific tests ────────────────────────────────────────────────────────
async function runTests() {
  const test = process.argv[2] || 'all'
  console.log(`\n🧪 Running test: ${test}\n`)

  if (test === 'slack' || test === 'all') {
    await testSlackConnection()
  }

  if (test === 'sheets' || test === 'all') {
    await testSheetsConnection()
  }

  if (test === 'profile') {
    await testProfileCheck()
  }

  if (test === 'onboard') {
    await testOnboarding()
  }

  if (test === 'dm') {
    await testDM()
  }
}

async function testSlackConnection() {
  console.log('Testing Slack connection...')
  try {
    const result = await slack.client.auth.test()
    console.log(`✅ Slack connected as: ${result.user} (${result.team})`)
  } catch (err) {
    console.error('❌ Slack connection failed:', err.message)
    console.log('   Check: SLACK_BOT_TOKEN in your .env')
  }
}

async function testSheetsConnection() {
  console.log('Testing Google Sheets connection...')
  try {
    const roster = await sheets.getHiredRoster()
    console.log(`✅ Google Sheets connected. Hired Roster has ${roster.length} rows.`)
    if (roster.length > 0) {
      console.log(`   First hire: ${roster[0]['Name'] || '(no name)'}`)
    }
  } catch (err) {
    console.error('❌ Sheets connection failed:', err.message)
    console.log('   Check: GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY')
  }
}

async function testProfileCheck() {
  const userId = process.env.TAULANT_SLACK_ID
  if (!userId) {
    console.log('❌ Set TAULANT_SLACK_ID in .env to test profile check')
    return
  }
  console.log(`Testing profile check for ${userId}...`)
  try {
    const result = await slack.checkSlackProfile(userId)
    console.log('Profile result:', result)
  } catch (err) {
    console.error('❌ Profile check failed:', err.message)
  }
}

async function testOnboarding() {
  console.log('Testing full onboarding flow with TEST hire...')
  console.log('⚠️  This will create a real Slack channel. Make sure this is a test workspace.')

  const testHire = {
    name: 'Test Hire',
    role: 'AI Tools Deployment Engineer',
    slackId: process.env.TAULANT_SLACK_ID || '',
    email: 'test@insidesuccess.com',
    startDate: new Date().toLocaleDateString('en-US')
  }

  try {
    const result = await onboarding.onboardNewHire(testHire)
    console.log('Result:', JSON.stringify(result, null, 2))
  } catch (err) {
    console.error('❌ Onboarding test failed:', err.message)
  }
}

async function testDM() {
  const userId = process.env.TAULANT_SLACK_ID
  if (!userId) {
    console.log('❌ Set TAULANT_SLACK_ID in .env to test DM')
    return
  }
  console.log(`Sending test DM to ${userId}...`)
  try {
    await slack.sendDM(userId, '🤖 Test message from ISTV Onboarding Bot. If you see this, the bot is working correctly.')
    console.log('✅ DM sent')
  } catch (err) {
    console.error('❌ DM failed:', err.message)
  }
}

runTests().catch(console.error)
