// ─── ISTV Slack Bot — Stress & Security Test Suite ──────────────────────────
// Usage: node lib/stress.js
// No real API keys needed. HTTP tests spawn a local server on port 3099.
// ─────────────────────────────────────────────────────────────────────────────

'use strict'

const http = require('http')
const { spawn } = require('child_process')
const { createHmac } = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ── Test runner state ─────────────────────────────────────────────────────────
let passed = 0, failed = 0
const securityFindings = []
const bugFindings = []
const perfFindings = []

function assert(name, condition, detail = '') {
  if (condition) {
    process.stdout.write(`  ✅ ${name}\n`)
    passed++
  } else {
    process.stdout.write(`  ❌ FAIL — ${name}${detail ? ': ' + detail : ''}\n`)
    failed++
  }
}

function security(name, detail) {
  process.stdout.write(`  🔴 SECURITY: ${name}\n     ${detail}\n`)
  securityFindings.push({ name, detail })
}

function bug(name, detail) {
  process.stdout.write(`  🟡 BUG: ${name}\n     ${detail}\n`)
  bugFindings.push({ name, detail })
}

function perf(name, detail) {
  process.stdout.write(`  🔵 PERF: ${name}\n     ${detail}\n`)
  perfFindings.push({ name, detail })
}

function section(title) {
  process.stdout.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n`)
}

// ── Inlined pure functions (avoids importing modules with API client init) ────

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

function chunkText(text, size = 800, overlap = 100) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size - overlap
  }
  return chunks
}

// ── channels.js is pure — safe to require ────────────────────────────────────
const channels = require('./channels')

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — looksLikeDLOA()
// ─────────────────────────────────────────────────────────────────────────────
section('1 / looksLikeDLOA() — Pure function')

// True positives
assert('eod (lowercase)',          looksLikeDLOA('eod update for today'))
assert('EOD (uppercase)',           looksLikeDLOA('EOD — wrapped up the PR'))
assert('tasks completed',           looksLikeDLOA('Tasks completed: 3'))
assert('TASKS COMPLETED',           looksLikeDLOA('TASKS COMPLETED: 3'))
assert('blockers',                  looksLikeDLOA('No blockers today'))
assert('tomorrow',                  looksLikeDLOA('Tomorrow I will finish the API'))
assert('role + date combo',         looksLikeDLOA('Role: Engineer\nDate: 2026-06-17'))
assert('mixed case tomorrow',       looksLikeDLOA('Tomorrow: finish deploy'))
assert('eod mid-sentence',          looksLikeDLOA('Here is my eod report'))

// True negatives
assert('empty string → false',     !looksLikeDLOA(''))
assert('null → false',             !looksLikeDLOA(null))
assert('undefined → false',        !looksLikeDLOA(undefined))
assert('random message → false',   !looksLikeDLOA('Hey, can someone help me with Notion?'))
assert('role: without date: → false', !looksLikeDLOA('My role: is great'))
assert('date: without role: → false', !looksLikeDLOA('date: 2026-06-17'))

// False positive surface — document as bugs
const falsePositiveWord = 'videod'  // contains 'eod'
if (looksLikeDLOA(`I ${falsePositiveWord} the meeting`)) {
  bug(
    `looksLikeDLOA() false positive: words containing "eod"`,
    `"${falsePositiveWord}" triggers detection. includes('eod') is a substring match. ` +
    `Words like "hoed", "toed", "videod" all false-trigger.`
  )
} else {
  assert('"videod" does not false-positive', true)
}

const falsePositiveWord2 = 'methodology'  // does NOT contain 'eod' — just a check
assert('"methodology" does not false-positive', !looksLikeDLOA('Pure methodology discussion'))

// Stress: very large input
const bigText = 'A'.repeat(50000) + ' eod '
const t0 = Date.now()
looksLikeDLOA(bigText)
const elapsed = Date.now() - t0
assert(`50k char input processed in <50ms (took ${elapsed}ms)`, elapsed < 50)

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — chunkText()
// ─────────────────────────────────────────────────────────────────────────────
section('2 / chunkText() — Pure function')

// Empty string
const emptyChunks = chunkText('')
assert('empty string → [] (zero chunks)', emptyChunks.length === 0)
if (emptyChunks.length === 0) {
  bug(
    'addDocument with empty content silently adds 0 chunks',
    'chunkText("") returns []. Calling addDocument("title","") stores nothing and ' +
    'returns 0 — no error thrown. Knowledge base seeding could silently fail for empty docs.'
  )
}

// Shorter than chunk size
const shortText = 'Hello world'
const shortChunks = chunkText(shortText)
assert('text shorter than chunk size → 1 chunk', shortChunks.length === 1)
assert('short chunk contains full text', shortChunks[0] === shortText)

// Exactly chunk size
const exactText = 'X'.repeat(800)
assert('text exactly chunk size → 1 chunk', chunkText(exactText).length === 1)

// One byte over
const oneOver = 'X'.repeat(801)
const oneOverChunks = chunkText(oneOver)
assert('text chunk+1 bytes → 2 chunks', oneOverChunks.length === 2)
assert('second chunk of 801-char text is 101 chars', oneOverChunks[1].length === 101)

// Overlap: second chunk should start at byte 700 (800 - 100)
const numbered = Array.from({ length: 1600 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('')
const numberedChunks = chunkText(numbered)
assert('overlap: second chunk starts at offset 700', numberedChunks[1] === numbered.slice(700, 1500))

// Count chunks for known-size input
const text10k = 'A'.repeat(10000)
// Expected: ceil((10000 - 100) / (800 - 100)) + 1 — but let's just count and verify > 10
const chunks10k = chunkText(text10k)
const expectedChunks = Math.ceil((10000 - 800) / (800 - 100)) + 1
assert(`10k chars → ~${expectedChunks} chunks (got ${chunks10k.length})`, chunks10k.length === expectedChunks)

// Last chunk covers end of text
assert('last chunk ends at text end', chunks10k[chunks10k.length - 1] === text10k.slice((chunks10k.length - 1) * (800 - 100)))

// Chunk size < overlap → infinite loop risk
// We do NOT call chunkText with size <= overlap because it causes an infinite loop.
// Document this as a bug instead.
bug(
  'chunkText() infinite loop: size <= overlap',
  'If size - overlap <= 0, start never advances and the while loop runs forever. ' +
  'Callers pass size and overlap directly — no guard in the function. ' +
  'Example: chunkText(text, 50, 100) → infinite loop.'
)

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — getPersonalChannelName()
// ─────────────────────────────────────────────────────────────────────────────
section('3 / getPersonalChannelName() — channels.js')

const cases = [
  { role: 'AI Chief of Staff Assistant',            firstName: 'Alice',  expected: 'sd-chiefofstaff-alice' },
  { role: 'AI-native Operations Engineer Generalist', firstName: 'Bob',  expected: 'sd-operations-bob' },
  { role: 'AI Knowledge Systems Engineer',           firstName: 'Carol', expected: 'sd-knowledge-carol' },
  { role: 'AI Tools Deployment Engineer',            firstName: 'Dave',  expected: 'sd-deployment-dave' },
  { role: 'AI Designer',                             firstName: 'Eve',   expected: 'sd-designer-eve' },
  { role: 'Unknown Role',                            firstName: 'Frank', expected: 'sd-ai-frank' },
  { role: '',                                        firstName: 'Gary',  expected: 'sd-ai-gary' },
]

for (const c of cases) {
  const got = channels.getPersonalChannelName({ role: c.role, firstName: c.firstName })
  assert(`role "${c.role || '(empty)'}" → ${c.expected}`, got === c.expected,
    `got "${got}"`)
}

// Special chars in first name
const specialResult = channels.getPersonalChannelName({ role: 'AI Designer', firstName: 'Jo-sé' })
assert('special chars stripped from firstName', specialResult === 'sd-designer-jos',
  `got "${specialResult}"`)

// Uppercase first name
const upperResult = channels.getPersonalChannelName({ role: 'AI Designer', firstName: 'MARIA' })
assert('uppercase firstName lowercased', upperResult === 'sd-designer-maria')

// Very long first name (>20 chars)
const longFirst = 'Abcdefghijklmnopqrstuvwxyz'  // 26 chars
const longResult = channels.getPersonalChannelName({ role: 'AI Designer', firstName: longFirst })
assert('firstName truncated to 20 chars', longResult === 'sd-designer-abcdefghijklmnopqrst'.slice(0, 'sd-designer-'.length + 20),
  `got "${longResult}"`)

// Empty first name
const emptyResult = channels.getPersonalChannelName({ role: 'AI Designer', firstName: '' })
assert('empty firstName → sd-designer- (valid but odd)',
  emptyResult === 'sd-designer-', `got "${emptyResult}"`)

// Numbers in first name
const numResult = channels.getPersonalChannelName({ role: 'AI Designer', firstName: 'J4y4' })
assert('numbers in firstName preserved', numResult === 'sd-designer-j4y4')

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — getAllChannelNames()
// ─────────────────────────────────────────────────────────────────────────────
section('4 / getAllChannelNames() — channels.js')

const allNames = channels.getAllChannelNames({})
assert('returns exactly 11 channels', allNames.length === 11, `got ${allNames.length}`)

const required = [
  'sd-main-tyler',
  'sd-recruiting-ai-taulant',
  'sd-notion-knowledge-layer-adrian',
  'sd-dloa-tyler',
  'sd-github-tyler',
  'sd-idea-dump-tyler',
  'sd-system-admin-tyler',
  'sd-feature-docs-sri',
  'sd-intercom-customer-service-saqlain',
  'sd-deployment-jaya',
  'sd-sales-syed',
]
for (const ch of required) {
  assert(`contains ${ch}`, allNames.includes(ch))
}

// No duplicates
const unique = new Set(allNames)
assert('no duplicate channel names', unique.size === allNames.length)

// All names are valid Slack channel names (lowercase, no spaces, no @#)
for (const ch of allNames) {
  assert(`"${ch}" is valid Slack channel name format`,
    /^[a-z0-9-_]{1,80}$/.test(ch))
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Security Analysis (static)
// ─────────────────────────────────────────────────────────────────────────────
section('5 / Security Analysis — Static')

security(
  'verifySlackSignature() bypassed when SLACK_SIGNING_SECRET not set',
  'api/index.js:27 — if(!signingSecret) return true. Any unsigned request is accepted ' +
  'in environments missing this env var. If deployed to Vercel without SLACK_SIGNING_SECRET, ' +
  'anyone can POST fake Slack events and trigger onboarding, DLOA analysis, or DMs.'
)

security(
  'Hardcoded backdoor secret in /trigger/onboard',
  'api/index.js:418 — accepts secret === "istv-trigger-2026" in addition to WEBHOOK_SECRET. ' +
  'This literal is burned into git history forever. Anyone with repo read access can trigger ' +
  'arbitrary onboarding (creates real Slack channels, sends DMs, hits Google Sheets).'
)

security(
  'Knowledge base API requires only WEBHOOK_SECRET — no per-route auth',
  'api/index.js:362-408 — /knowledge GET/POST/DELETE all use x-api-key === WEBHOOK_SECRET. ' +
  'The same secret that protects Make.com webhooks also gives full read/write/delete access ' +
  'to the RAG knowledge store. Compromise of WEBHOOK_SECRET = full knowledge base access.'
)

security(
  'Timestamp replay window is 5 minutes — standard but worth noting',
  'api/index.js:34 — Slack signature validation rejects requests older than 300s. ' +
  'This is the Slack-recommended value. No issue, but confirm clock sync on Vercel.'
)

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Bug Analysis (static)
// ─────────────────────────────────────────────────────────────────────────────
section('6 / Bug Analysis — Static')

bug(
  'handleNewMember: empty real_name matches first roster entry',
  'api/index.js:252 — name matching uses str.includes(firstName) where firstName = ' +
  'user.real_name.split(" ")[0]. If real_name is "" then split gives [""], and ' +
  '"".split(" ")[0] = "" and anyString.includes("") === true. Result: any new workspace ' +
  'member with no display name is matched to the FIRST hire in the roster and onboarded ' +
  'as them. Fix: guard with if (!user.real_name) return before roster lookup.'
)

bug(
  'sheets.js: getAuth() crashes if GOOGLE_PRIVATE_KEY is undefined',
  'lib/sheets.js:10 — process.env.GOOGLE_PRIVATE_KEY.replace(...). If env var missing, ' +
  'this throws TypeError: Cannot read properties of undefined (reading "replace"). ' +
  'This crashes ALL Sheets operations silently through the try/catch in onboarding.js ' +
  '— onboarding succeeds (channel, DM, admin alert) but tracker is never updated. ' +
  'New hire will be repeatedly re-onboarded on every poll cycle.'
)

bug(
  'sendDayOneMessages: date format mismatch causes messages to never send',
  'lib/cron.js:143 — today formatted as "Jun 17, 2026". Sheet stores dates in unknown ' +
  'format (could be "6/17/2026", "2026-06-17", or "Jun 17, 2026"). ' +
  'startDate.includes(today) will only match if the sheet format is a superset of the ' +
  'formatted string. Mismatch = day-one messages silently never fire.'
)

bug(
  'store.json race condition on concurrent addDocument calls',
  'lib/knowledge.js:51-76 — addDocument is async but loadStore/saveStore are synchronous. ' +
  'Two concurrent calls both call loadStore() → get same snapshot → modify independently → ' +
  'both call saveStore() → second write wins, first changes lost. Example: two hires post ' +
  'DLOAs simultaneously. One DLOA is silently dropped from the knowledge base.'
)

bug(
  'addToAllChannels exported after module.exports = {...} in slack.js',
  'lib/slack.js:146 vs 159/213 — module.exports is set on line 146 without addToAllChannels ' +
  'or buildChannelMap. They are patched on later with module.exports.addToAllChannels = ... ' +
  'This works at runtime but means destructured imports like ' +
  'const { addToAllChannels } = require("./slack") on line 146 would get undefined.'
)

bug(
  'searchKnowledge skips all chunks on Claude JSON parse failure',
  'lib/knowledge.js:113-118 — if Claude returns malformed JSON (not matching /\\[[\\d,\\s]+\\]/), ' +
  'all chunks in that batch are scored 0 and get filtered out by score > 0. ' +
  'An entire batch of 30 chunks silently disappears from search results.'
)

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Performance Analysis (static)
// ─────────────────────────────────────────────────────────────────────────────
section('7 / Performance Analysis — Static')

perf(
  'searchKnowledge makes ceil(N/30) Claude API calls per query',
  'lib/knowledge.js:90 — with 100 docs × avg 5 chunks = 500 chunks → 17 Claude API calls ' +
  'per search. Every @mention and DM triggers a search. 10 active onboardees posting DLOAs ' +
  'simultaneously = 10 × (17 search + 1 answer) = 180 Claude API calls in one minute. ' +
  'Add Monday.com sync per DLOA: could easily hit Anthropic rate limits.'
)

perf(
  'store.json is read and written on every addDocument call (synchronous I/O)',
  'lib/knowledge.js:52,72 — fs.readFileSync + fs.writeFileSync inside addDocument. ' +
  'As the knowledge base grows (100+ docs × 5 chunks = 500+ JSON objects), each write ' +
  'serializes and writes the entire file. At 500 chunks × ~200 bytes avg = ~100KB per write. ' +
  'Not a problem now, but grows linearly with every DLOA added.'
)

perf(
  'buildChannelMap called on every addToAllChannels invocation',
  'lib/slack.js:193 — calls conversations.list (paginated) on every onboarding. ' +
  'No caching. In a large workspace with many channels, this paginates multiple times. ' +
  'Consider caching with a 10-minute TTL.'
)

perf(
  'knowledge.seedDepartmentDocs() re-seeds on every server restart',
  'api/index.js:490 — called unconditionally at startup. Each doc is re-chunked and ' +
  're-stored (deduped by title). With Vercel cold starts on every request, this runs ' +
  'frequently in serverless mode and adds ~500ms latency to first requests.'
)

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — HTTP Endpoint Tests (requires server)
// ─────────────────────────────────────────────────────────────────────────────
section('8 / HTTP Endpoint Tests')

const TEST_PORT = 3099
const TEST_SECRET = 'stress-test-secret-xyz'

function request(opts, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: opts.path,
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    }
    const req = http.request(options, res => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function buildSlackSignature(secret, body, ts) {
  const sigBase = `v0:${ts}:${body}`
  const hmac = createHmac('sha256', secret).update(sigBase).digest('hex')
  return `v0=${hmac}`
}

async function runHttpTests(serverProcess) {
  // Wait for server to be ready
  await new Promise(resolve => setTimeout(resolve, 2000))

  section('8a / Health & Root Endpoints')

  try {
    const health = await request({ path: '/health' })
    assert('GET /health → 200', health.status === 200)
    assert('GET /health → ok:true', health.body.ok === true)

    const root = await request({ path: '/' })
    assert('GET / → 200', root.status === 200)
    assert('GET / → has version field', typeof root.body.version === 'string')
    assert('GET / → lists features array', Array.isArray(root.body.features))
  } catch (e) {
    assert('Health endpoints reachable', false, e.message)
  }

  section('8b / /webhook/new-hire — Auth boundary')

  try {
    const noSecret = await request({ path: '/webhook/new-hire', method: 'POST' },
      { name: 'Test Hire', role: 'AI Designer' })
    assert('POST /webhook/new-hire — missing secret → 403', noSecret.status === 403)

    const wrongSecret = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: 'wrong-secret', name: 'Test Hire', role: 'AI Designer' })
    assert('POST /webhook/new-hire — wrong secret → 403', wrongSecret.status === 403)

    const missingName = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: TEST_SECRET, role: 'AI Designer' })
    assert('POST /webhook/new-hire — missing name → 400', missingName.status === 400)

    const missingRole = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: TEST_SECRET, name: 'Test Hire' })
    assert('POST /webhook/new-hire — missing role → 400', missingRole.status === 400)
  } catch (e) {
    assert('/webhook/new-hire auth tests reachable', false, e.message)
  }

  section('8c / /trigger/onboard — Backdoor secret')

  try {
    const backdoor = await request({ path: '/trigger/onboard', method: 'POST' },
      { secret: 'istv-trigger-2026', name: 'Backdoor Test', role: 'AI Designer' })
    // This should either succeed (500 because Slack token is fake) or 403
    // If it reaches the onboarding logic (not 403) the backdoor is confirmed
    if (backdoor.status !== 403) {
      security(
        '/trigger/onboard: hardcoded backdoor confirmed active',
        `Server accepted secret "istv-trigger-2026" (not WEBHOOK_SECRET). ` +
        `Responded ${backdoor.status} — got past auth to onboarding logic.`
      )
      assert('POST /trigger/onboard backdoor → should be 403', false,
        `got ${backdoor.status} — backdoor secret "istv-trigger-2026" is live`)
    } else {
      assert('POST /trigger/onboard backdoor secret → 403', true)
    }

    const wrongTrigger = await request({ path: '/trigger/onboard', method: 'POST' },
      { secret: 'totally-wrong', name: 'Test', role: 'AI Designer' })
    assert('POST /trigger/onboard — wrong secret → 403', wrongTrigger.status === 403)
  } catch (e) {
    assert('/trigger/onboard tests reachable', false, e.message)
  }

  section('8d / /knowledge — API key boundary')

  try {
    const noKey = await request({ path: '/knowledge' })
    assert('GET /knowledge — no x-api-key → 403', noKey.status === 403)

    const wrongKey = await request({ path: '/knowledge', headers: { 'x-api-key': 'wrong' } })
    assert('GET /knowledge — wrong x-api-key → 403', wrongKey.status === 403)

    const noKeySearch = await request({ path: '/knowledge/search', method: 'POST' },
      { query: 'test' })
    assert('POST /knowledge/search — no auth → 403', noKeySearch.status === 403)

    // Valid key — should return 200 (knowledge base may be empty)
    const validKey = await request({
      path: '/knowledge',
      headers: { 'x-api-key': TEST_SECRET }
    })
    assert('GET /knowledge — correct x-api-key → 200', validKey.status === 200)
    assert('GET /knowledge — has ok field', validKey.body.ok === true)
    assert('GET /knowledge — has count field', typeof validKey.body.count === 'number')
  } catch (e) {
    assert('/knowledge auth tests reachable', false, e.message)
  }

  section('8e / /slack/events — URL verification & signature')

  try {
    // URL verification challenge (no signature needed by Slack spec)
    const challenge = await request({ path: '/slack/events', method: 'POST' },
      { type: 'url_verification', challenge: 'test-challenge-abc' })
    assert('POST /slack/events URL verification → 200', challenge.status === 200)
    assert('POST /slack/events URL verification → echoes challenge',
      challenge.body.challenge === 'test-challenge-abc')

    // No signing secret in env → should return 401 (missing signature headers)
    const noSig = await request({ path: '/slack/events', method: 'POST' },
      { type: 'event_callback', event: { type: 'message' } })
    // If SLACK_SIGNING_SECRET is not set in test env, verifySlackSignature returns true
    // meaning unsigned requests are accepted — document that
    if (noSig.status === 200) {
      security(
        '/slack/events: accepts requests with no Slack signature headers',
        `When SLACK_SIGNING_SECRET is not set in env, verifySlackSignature() returns true. ` +
        `Server responded 200 to a request with no x-slack-signature header. ` +
        `Any HTTP client can fake Slack events.`
      )
    } else {
      assert('POST /slack/events — no signature → 401', noSig.status === 401)
    }
  } catch (e) {
    assert('/slack/events tests reachable', false, e.message)
  }

  section('8f / Input validation & edge cases')

  try {
    // Extremely large payload to /webhook/new-hire
    const bigName = 'A'.repeat(10000)
    const bigPayload = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: 'wrong', name: bigName, role: 'AI Designer' })
    assert('10k-char name in webhook payload — server responds (no crash)', bigPayload.status !== 0)

    // SQL/script injection chars in name
    const injectionName = "'; DROP TABLE hires; --"
    const injection = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: 'wrong', name: injectionName, role: 'AI Designer' })
    assert('SQL injection in name — server responds (not 500)', injection.status !== 500)

    // Unicode in name
    const unicodeName = '田中 太郎'
    const unicode = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: 'wrong', name: unicodeName, role: 'AI Designer' })
    assert('Unicode name in webhook — server responds (not 500)', unicode.status !== 500)

    // Deeply nested JSON (prototype pollution probe)
    const pollutionAttempt = await request({ path: '/webhook/new-hire', method: 'POST' },
      { secret: 'wrong', '__proto__': { admin: true }, name: 'Test' })
    assert('Prototype pollution probe — server responds safely', pollutionAttempt.status !== 500)

    // GET to a POST-only endpoint
    const wrongMethod = await request({ path: '/webhook/new-hire', method: 'GET' })
    assert('GET /webhook/new-hire (wrong method) — 404', wrongMethod.status === 404)

    // Unknown endpoint
    const unknown = await request({ path: '/api/v1/does-not-exist' })
    assert('Unknown route → 404', unknown.status === 404)
  } catch (e) {
    assert('Edge case tests reachable', false, e.message)
  }

  section('8g / Concurrency — parallel requests')

  try {
    const N = 20
    const start = Date.now()
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request({ path: '/health' }).catch(() => ({ status: 0 }))
      )
    )
    const elapsed = Date.now() - start
    const allOk = results.every(r => r.status === 200)
    assert(`${N} concurrent GET /health all return 200`, allOk,
      `${results.filter(r => r.status !== 200).length} failures`)
    assert(`${N} concurrent requests completed in <2000ms (took ${elapsed}ms)`, elapsed < 2000)

    // Concurrent knowledge add (triggers race condition in store.json)
    const concurrent = await Promise.all([
      request({ path: '/knowledge/search', method: 'POST',
        headers: { 'x-api-key': TEST_SECRET } }, { query: 'test query 1' }),
      request({ path: '/knowledge/search', method: 'POST',
        headers: { 'x-api-key': TEST_SECRET } }, { query: 'test query 2' }),
      request({ path: '/knowledge', headers: { 'x-api-key': TEST_SECRET } }),
    ])
    assert('Concurrent knowledge reads — all respond (no crash)',
      concurrent.every(r => r.status === 200 || r.status === 500))
  } catch (e) {
    assert('Concurrency tests reachable', false, e.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Race condition demo (in-process)
// ─────────────────────────────────────────────────────────────────────────────
section('9 / Race Condition Demo — store.json')

const tmpStore = path.join(os.tmpdir(), `istv-stress-store-${Date.now()}.json`)

function loadTmpStore() {
  try { return JSON.parse(fs.readFileSync(tmpStore, 'utf8')) } catch { return { documents: [] } }
}
function saveTmpStore(store) {
  fs.writeFileSync(tmpStore, JSON.stringify(store))
}

// Simulate two concurrent addDocument calls (inlined logic from knowledge.js)
function fakeChunkText(text, size = 800, overlap = 100) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size - overlap
  }
  return chunks
}

async function fakeAddDocument(title, content) {
  // This mirrors knowledge.js addDocument but without the Claude embedding step
  const store = loadTmpStore()
  const chunks = fakeChunkText(content)
  store.documents = store.documents.filter(d => d.title !== title)
  for (let i = 0; i < chunks.length; i++) {
    store.documents.push({ id: `${i}`, title, chunk: chunks[i] })
  }
  // Simulate async work (e.g. Claude embedding) before save
  await new Promise(r => setTimeout(r, 10))
  saveTmpStore(store)
  return chunks.length
}

// Init empty store
saveTmpStore({ documents: [] })

// Fire two concurrent adds
await Promise.all([
  fakeAddDocument('Doc A', 'Content A '.repeat(10)),
  fakeAddDocument('Doc B', 'Content B '.repeat(10)),
])

const finalStore = loadTmpStore()
const docTitles = [...new Set(finalStore.documents.map(d => d.title))]
const raceLost = docTitles.length < 2

if (raceLost) {
  bug(
    `Race condition confirmed: concurrent addDocument — only ${docTitles.length}/2 docs saved`,
    `One write overwrote the other. Titles present: [${docTitles.join(', ')}]. ` +
    `Fix: use a write queue or atomic file operations (write-then-rename).`
  )
  assert('Race condition: both docs saved (expected to FAIL)', !raceLost)
} else {
  assert('Race condition: both docs saved correctly', true)
}

// Cleanup
try { fs.unlinkSync(tmpStore) } catch {}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN: spawn server and run HTTP tests
// ─────────────────────────────────────────────────────────────────────────────

let serverProcess = null

async function startServer() {
  const serverEnv = {
    ...process.env,
    PORT: String(TEST_PORT),
    NODE_ENV: 'test',
    ENABLE_CRON: 'false',
    WEBHOOK_SECRET: TEST_SECRET,
    CRON_SECRET: 'test-cron',
    SLACK_BOT_TOKEN: 'xoxb-test-fake-token',
    SLACK_SIGNING_SECRET: '',  // intentionally blank — security test
    GOOGLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'test@test.iam.gserviceaccount.com',
    GOOGLE_SHEET_ID: 'fake-sheet-id',
    ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    MONDAY_API_KEY: 'fake',
    MONDAY_BOARD_ID: '0',
    ZOOM_VERIFICATION_TOKEN: 'fake',
    ADMIN_CHANNEL_ID: '',
    TAULANT_SLACK_ID: '',
    TYLER_SLACK_ID: '',
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '../api/index.js')], {
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let started = false
    proc.stdout.on('data', d => {
      if (!started && d.toString().includes('ISTV AI Department')) {
        started = true
        resolve(proc)
      }
    })
    proc.stderr.on('data', d => {
      // Suppress noise but don't fail — some modules log warnings to stderr
    })
    proc.on('error', reject)
    proc.on('exit', code => {
      if (!started) reject(new Error(`Server exited with code ${code} before becoming ready`))
    })

    // Timeout fallback
    setTimeout(() => {
      if (!started) {
        // Server may have started but log output different — try to proceed
        resolve(proc)
      }
    }, 3000)
  })
}

process.stdout.write('\n🚀 Starting test server on port ' + TEST_PORT + '...\n')

try {
  serverProcess = await startServer()
  await runHttpTests(serverProcess)
} catch (err) {
  process.stdout.write(`\n⚠️  Could not start server: ${err.message}\n`)
  process.stdout.write('   HTTP tests skipped. Run manually: node api/index.js\n')
} finally {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FINAL REPORT
// ─────────────────────────────────────────────────────────────────────────────
section('FINAL REPORT')

process.stdout.write(`\n  Tests:    ${passed} passed, ${failed} failed\n`)
process.stdout.write(`  Security: ${securityFindings.length} finding(s)\n`)
process.stdout.write(`  Bugs:     ${bugFindings.length} finding(s)\n`)
process.stdout.write(`  Perf:     ${perfFindings.length} finding(s)\n`)

if (securityFindings.length) {
  process.stdout.write('\n  Security findings:\n')
  securityFindings.forEach((f, i) => process.stdout.write(`  ${i + 1}. ${f.name}\n`))
}
if (bugFindings.length) {
  process.stdout.write('\n  Bug findings:\n')
  bugFindings.forEach((f, i) => process.stdout.write(`  ${i + 1}. ${f.name}\n`))
}
if (perfFindings.length) {
  process.stdout.write('\n  Perf findings:\n')
  perfFindings.forEach((f, i) => process.stdout.write(`  ${i + 1}. ${f.name}\n`))
}

process.stdout.write('\n')
process.exit(failed > 0 ? 1 : 0)