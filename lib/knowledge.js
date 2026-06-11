require('dotenv').config()
const fs = require('fs')
const path = require('path')
const Anthropic = require('@anthropic-ai/sdk')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const STORE_PATH = path.join(__dirname, '../knowledge/store.json')
const DOCS_PATH = path.join(__dirname, '../docs')
const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 100
const TOP_K = 5

// ── Load or init vector store ─────────────────────────────────────────────────
function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    }
  } catch {}
  return { documents: [] }
}

function saveStore(store) {
  const dir = path.dirname(STORE_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2))
}

// ── Chunk text into overlapping segments ─────────────────────────────────────
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + size))
    start += size - overlap
  }
  return chunks
}

// ── Get embedding from Anthropic ──────────────────────────────────────────────
async function getEmbedding(text) {
  // Anthropic doesn't yet have a public embeddings API endpoint like OpenAI.
  // We use a clever workaround: ask Claude to summarise the text into a
  // semantic fingerprint, then use character-level hashing for similarity.
  // When Anthropic releases embeddings, swap this out.
  // For now, we store the raw text and use Claude itself for semantic search.
  return null  // placeholder — see searchKnowledge for the actual approach
}

// ── Add a document to the knowledge base ─────────────────────────────────────
async function addDocument(title, content, type = 'document', metadata = {}) {
  console.log(`📚 Adding document to knowledge base: "${title}" (${type})`)
  const store = loadStore()
  const chunks = chunkText(content)
  const timestamp = new Date().toISOString()

  // Remove existing document with same title to prevent duplicates
  store.documents = store.documents.filter(d => d.title !== title)

  for (let i = 0; i < chunks.length; i++) {
    store.documents.push({
      id: `${Date.now()}-${i}`,
      title,
      type,        // 'document' | 'transcript' | 'dloa' | 'intake'
      chunk: chunks[i],
      chunkIndex: i,
      totalChunks: chunks.length,
      timestamp,
      metadata
    })
  }

  saveStore(store)
  console.log(`✅ Added ${chunks.length} chunks from "${title}"`)
  return chunks.length
}

// ── Search knowledge base using Claude as the semantic engine ─────────────────
async function searchKnowledge(query, topK = TOP_K) {
  const store = loadStore()
  if (store.documents.length === 0) return []

  // Build a prompt that asks Claude to rank chunks by relevance
  // We batch chunks to avoid token limits
  const allChunks = store.documents
  const BATCH = 30

  let allScored = []

  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH)
    const chunkList = batch.map((c, idx) =>
      `[${idx}] (${c.type}: ${c.title})\n${c.chunk}`
    ).join('\n\n---\n\n')

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Given this search query: "${query}"\n\nRate each chunk 0-10 for relevance. Return ONLY a JSON array of numbers, one per chunk, in order. Example: [8,2,0,5,7]\n\nChunks:\n${chunkList}`
        }]
      })

      const text = response.content[0].text.trim()
      const match = text.match(/\[[\d,\s]+\]/)
      if (match) {
        const scores = JSON.parse(match[0])
        scores.forEach((score, idx) => {
          if (idx < batch.length) {
            allScored.push({ ...batch[idx], score })
          }
        })
      }
    } catch (err) {
      // If scoring fails, include all chunks with score 0
      batch.forEach(c => allScored.push({ ...c, score: 0 }))
    }
  }

  return allScored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(c => c.score > 0)
}

// ── Answer a question using the knowledge base ────────────────────────────────
async function answerFromKnowledge(question, askerName = 'Someone', askerRole = '') {
  try {
    const relevant = await searchKnowledge(question)

    const contextBlock = relevant.length > 0
      ? relevant.map(c => `[From: ${c.title} (${c.type})]\n${c.chunk}`).join('\n\n---\n\n')
      : 'No specific documents found for this query.'

    const systemPrompt = `You are the ISTV AI Department knowledge assistant. You answer questions from team members using the department's documents, meeting transcripts, and DLOAs as your source of truth.

ISTV context:
- InsideSuccess TV: Netflix of Business TV. CEO: Rudy Mawer. Chief of Staff: Tyler Mills.
- The AI department is called The Shipping Department. We build AI tools for the whole company.
- High turnover by design. 90-day keeper/cut decision. DLOA required daily by 5pm EST.
- Documentation is non-negotiable. Joints not welds. Tyler gives vision, you figure out execution.
- Contact for onboarding: Taulant Krasniqi. Do NOT DM Tyler unless urgent.
- Tools: Slack (primary), Monday.com (project mgmt), Claude (AI), GitHub, Google Calendar.

The person asking is: ${askerName}${askerRole ? ` (${askerRole})` : ''}.

Answer directly and specifically using the provided context. If the context doesn't cover it, say so and tell them to message Taulant. Keep answers under 120 words. Be direct — Tyler's team has no time for corporate softening.`

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Context from knowledge base:\n\n${contextBlock}\n\n---\n\nQuestion: ${question}`
      }]
    })

    const answer = response.content[0].text
    const sources = [...new Set(relevant.map(c => c.title))].slice(0, 3)

    return { answer, sources, chunksUsed: relevant.length }
  } catch (err) {
    console.error('Knowledge base answer failed:', err.message)
    return {
      answer: `I couldn't access the knowledge base right now. Message Taulant in your onboarding channel for help.`,
      sources: [],
      chunksUsed: 0
    }
  }
}

// ── List all documents in the knowledge base ──────────────────────────────────
function listDocuments() {
  const store = loadStore()
  const seen = new Set()
  const docs = []
  store.documents.forEach(d => {
    const key = `${d.title}::${d.type}`
    if (!seen.has(key)) {
      seen.add(key)
      docs.push({ title: d.title, type: d.type, timestamp: d.timestamp })
    }
  })
  return docs
}

// ── Delete a document from the knowledge base ─────────────────────────────────
function deleteDocument(title) {
  const store = loadStore()
  const before = store.documents.length
  store.documents = store.documents.filter(d => d.title !== title)
  saveStore(store)
  return before - store.documents.length
}

// ── Seed with department docs (run once at startup) ───────────────────────────
async function seedDepartmentDocs() {
  if (!fs.existsSync(DOCS_PATH)) {
    fs.mkdirSync(DOCS_PATH, { recursive: true })
    console.log('📁 Created docs/ folder — add your department docs there')
    return
  }

  const files = fs.readdirSync(DOCS_PATH).filter(f => f.endsWith('.md') || f.endsWith('.txt'))
  for (const file of files) {
    const content = fs.readFileSync(path.join(DOCS_PATH, file), 'utf8')
    const title = file.replace(/\.(md|txt)$/, '').replace(/-/g, ' ')
    await addDocument(title, content, 'document')
  }
  console.log(`✅ Seeded ${files.length} department documents`)
}

// ── CLI: node lib/knowledge.js --seed ────────────────────────────────────────
if (require.main === module && process.argv.includes('--seed')) {
  seedDepartmentDocs().then(() => process.exit(0)).catch(console.error)
}

module.exports = { addDocument, searchKnowledge, answerFromKnowledge, listDocuments, deleteDocument, seedDepartmentDocs }
