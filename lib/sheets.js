const { google } = require('googleapis')

const SHEET_ID = process.env.GOOGLE_SHEET_ID
const HIRED_ROSTER_TAB = 'Hired Roster'
const ONBOARDING_TRACKER_TAB = 'Onboarding Tracker'

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  )
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() })
}

// Read all rows from Hired Roster
async function getHiredRoster() {
  const sheets = getSheets()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HIRED_ROSTER_TAB}!A:Z`
  })
  const rows = res.data.values || []
  if (rows.length < 2) return []
  const headers = rows[0]
  return rows.slice(1).map((row, i) => {
    const obj = { _rowIndex: i + 2 }
    headers.forEach((h, j) => { obj[h] = row[j] || '' })
    return obj
  })
}

// Read onboarding tracker rows
async function getOnboardingTracker() {
  const sheets = getSheets()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${ONBOARDING_TRACKER_TAB}!A:Z`
  })
  const rows = res.data.values || []
  if (rows.length < 2) return []
  const headers = rows[0]
  return rows.slice(1).map((row, i) => {
    const obj = { _rowIndex: i + 2 }
    headers.forEach((h, j) => { obj[h] = row[j] || '' })
    return obj
  })
}

// Update a specific cell in Onboarding Tracker
async function updateOnboardingCell(rowIndex, columnLetter, value) {
  const sheets = getSheets()
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${ONBOARDING_TRACKER_TAB}!${columnLetter}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] }
  })
}

// Update a specific cell in Hired Roster
async function updateHiredRosterCell(rowIndex, columnLetter, value) {
  const sheets = getSheets()
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${HIRED_ROSTER_TAB}!${columnLetter}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] }
  })
}

// Add a new row to Onboarding Tracker
async function addOnboardingRow(hire) {
  const sheets = getSheets()
  const row = [
    hire.name,
    hire.role,
    hire.startDate,
    '', // Contract
    '', // Payment Setup
    'Yes', // Slack Account (already done if they're being onboarded)
    hire.slackId || '',
    '', // Personal Channel - will be updated after creation
    '', // Company Email
    '', // Monday
    '', // Claude
    '', // GitHub
    '', // Notion
    '', // Red Book
    '', // Slack Profile
    '', // DLOA
    '', // First Status Update
    '', // First System Doc
    '', // 7-day
    '', // 14-day
    '', // 30-day
    '0%', // Completion
    'Pending', // Keeper Decision
    ''  // Notes
  ]
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${ONBOARDING_TRACKER_TAB}!A:A`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  })
}

// Get all active onboardees (for DLOA reminders)
async function getActiveOnboardees() {
  const roster = await getOnboardingTracker()
  return roster.filter(r =>
    r['Keeper Decision'] === 'Pending' ||
    r['Keeper Decision'] === '' ||
    r['Current Status'] === 'Active'
  )
}

module.exports = {
  getHiredRoster,
  getOnboardingTracker,
  updateOnboardingCell,
  updateHiredRosterCell,
  addOnboardingRow,
  getActiveOnboardees
}
