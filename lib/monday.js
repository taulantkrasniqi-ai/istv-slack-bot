require('dotenv').config()
const axios = require('axios')
const Anthropic = require('@anthropic-ai/sdk')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MONDAY_API = 'https://api.monday.com/v2'

// ── Execute Monday.com GraphQL query ─────────────────────────────────────────
async function mondayQuery(query, variables = {}) {
  const response = await axios.post(
    MONDAY_API,
    { query, variables },
    {
      headers: {
        Authorization: process.env.MONDAY_API_KEY,
        'Content-Type': 'application/json',
        'API-Version': '2024-01'
      }
    }
  )
  if (response.data.errors) {
    throw new Error(`Monday API error: ${JSON.stringify(response.data.errors)}`)
  }
  return response.data.data
}

// ── Extract structured data from DLOA using Claude ───────────────────────────
async function extractDLOAData(dloaText, hireName) {
  const prompt = `Extract structured data from this DLOA (Daily List of Activities) posted by ${hireName}.

DLOA text:
${dloaText}

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "date": "YYYY-MM-DD or the date mentioned",
  "role": "their role if mentioned",
  "tasks": [
    { "description": "task description", "minutes": estimated_minutes_as_number }
  ],
  "blockers": ["blocker 1", "blocker 2"],
  "tomorrow": ["tomorrow task 1", "tomorrow task 2"]
}

If a field can't be determined, use empty array [] or empty string "".
For minutes, estimate based on time mentioned (e.g. "45 min" = 45, "1 hr" = 60, "1.5 hrs" = 90).`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = response.content[0].text.trim()
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch (err) {
    console.error('DLOA extraction failed:', err.message)
    return { date: '', role: '', tasks: [], blockers: [], tomorrow: [] }
  }
}

// ── Find items on Monday board by name ────────────────────────────────────────
async function findBoardItems(boardId, searchText) {
  const query = `
    query ($boardId: ID!, $searchText: String!) {
      boards(ids: [$boardId]) {
        items_page(limit: 50) {
          items {
            id
            name
            column_values { id value text }
          }
        }
      }
    }
  `
  try {
    const data = await mondayQuery(query, { boardId: String(boardId), searchText })
    return data?.boards?.[0]?.items_page?.items || []
  } catch (err) {
    console.error('Monday findBoardItems error:', err.message)
    return []
  }
}

// ── Create a new item on Monday board ────────────────────────────────────────
async function createBoardItem(boardId, itemName, groupId = null) {
  const query = groupId
    ? `mutation ($boardId: ID!, $groupId: String!, $name: String!) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $name) { id name }
      }`
    : `mutation ($boardId: ID!, $name: String!) {
        create_item(board_id: $boardId, item_name: $name) { id name }
      }`

  const variables = groupId
    ? { boardId: String(boardId), groupId, name: itemName }
    : { boardId: String(boardId), name: itemName }

  try {
    const data = await mondayQuery(query, variables)
    return data?.create_item
  } catch (err) {
    console.error('Monday createBoardItem error:', err.message)
    return null
  }
}

// ── Update item status on Monday board ───────────────────────────────────────
async function updateItemStatus(itemId, statusColumnId, status) {
  const query = `
    mutation ($itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
  `
  try {
    await mondayQuery(query, {
      itemId: String(itemId),
      columnId: statusColumnId,
      value: JSON.stringify({ label: status })
    })
    return true
  } catch (err) {
    console.error('Monday updateItemStatus error:', err.message)
    return false
  }
}

// ── Main: Sync a DLOA to Monday.com ──────────────────────────────────────────
async function syncDLOAToMonday(dloaText, hire) {
  if (!process.env.MONDAY_API_KEY || !process.env.MONDAY_BOARD_ID) {
    console.log('⚠️ Monday.com not configured — skipping DLOA sync')
    return { ok: false, reason: 'not_configured' }
  }

  const boardId = process.env.MONDAY_BOARD_ID
  console.log(`📋 Syncing DLOA to Monday for ${hire.name}...`)

  try {
    // Extract structured data from DLOA
    const data = await extractDLOAData(dloaText, hire.name)
    const results = { tasksUpdated: 0, tasksMissed: 0, blockersCreated: 0, tomorrowCreated: 0 }

    // Get existing board items
    const existingItems = await findBoardItems(boardId)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    // ── 1. Mark completed tasks as Done ──────────────────────────────────────
    for (const task of data.tasks || []) {
      const match = existingItems.find(item =>
        item.name.toLowerCase().includes(task.description.toLowerCase().substring(0, 20))
      )
      if (match) {
        await updateItemStatus(match.id, 'status', 'Done')
        results.tasksUpdated++
        console.log(`  ✅ Marked done: ${match.name}`)
      } else {
        // Create new item tagged as "From DLOA" if not found
        const newItem = await createBoardItem(boardId, `[DLOA] ${task.description}`)
        if (newItem) {
          await updateItemStatus(newItem.id, 'status', 'Done')
          results.tasksMissed++
          console.log(`  ➕ Created from DLOA: ${task.description}`)
        }
      }
    }

    // ── 2. Create blocker items ───────────────────────────────────────────────
    for (const blocker of data.blockers || []) {
      if (blocker.trim()) {
        const item = await createBoardItem(boardId, `🚨 BLOCKER [${hire.name}]: ${blocker}`)
        if (item) {
          await updateItemStatus(item.id, 'status', 'Stuck')
          results.blockersCreated++
          console.log(`  🚨 Created blocker: ${blocker}`)
        }
      }
    }

    // ── 3. Create tomorrow's tasks ────────────────────────────────────────────
    for (const task of data.tomorrow || []) {
      if (task.trim()) {
        const item = await createBoardItem(boardId, `[${hire.name}] ${task}`)
        if (item) {
          await updateItemStatus(item.id, 'status', 'To Do')
          results.tomorrowCreated++
          console.log(`  📅 Created for tomorrow: ${task}`)
        }
      }
    }

    console.log(`✅ Monday sync complete for ${hire.name}:`, results)
    return { ok: true, ...results, extracted: data }
  } catch (err) {
    console.error('Monday sync error:', err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = { syncDLOAToMonday, extractDLOAData, findBoardItems, createBoardItem }
