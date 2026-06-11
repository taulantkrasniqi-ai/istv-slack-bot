require('dotenv').config()
const axios = require('axios')
const knowledge = require('./knowledge')

// ── Parse VTT transcript into clean text ──────────────────────────────────────
function parseVTT(vttContent) {
  const lines = vttContent.split('\n')
  const textLines = []
  let prevSpeaker = null
  let prevText = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Skip WEBVTT header and empty lines and timestamp lines
    if (!line || line === 'WEBVTT' || line.match(/^\d+$/) || line.includes('-->')) continue

    // Detect speaker pattern: "Speaker Name: text"
    const speakerMatch = line.match(/^([^:]+):\s*(.+)$/)
    if (speakerMatch) {
      const speaker = speakerMatch[1].trim()
      const text = speakerMatch[2].trim()

      // Deduplicate consecutive identical lines (VTT often repeats)
      if (speaker === prevSpeaker && text === prevText) continue

      textLines.push(`${speaker}: ${text}`)
      prevSpeaker = speaker
      prevText = text
    } else if (line.length > 2) {
      // Plain text line without speaker label
      if (line !== prevText) {
        textLines.push(line)
        prevText = line
      }
    }
  }

  return textLines.join('\n')
}

// ── Download transcript from Zoom API ─────────────────────────────────────────
async function downloadTranscript(downloadUrl, accessToken) {
  try {
    const response = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'text'
    })
    return response.data
  } catch (err) {
    console.error('Failed to download Zoom transcript:', err.message)
    return null
  }
}

// ── Process a Zoom recording.completed webhook ────────────────────────────────
async function handleZoomWebhook(payload) {
  try {
    const { event, payload: data } = payload

    // Only handle recording completed events
    if (event !== 'recording.completed') {
      console.log(`Zoom event ignored: ${event}`)
      return { ok: true, ignored: true }
    }

    const recording = data?.object
    if (!recording) return { ok: false, error: 'No recording object in payload' }

    const meetingTopic = recording.topic || 'Untitled Meeting'
    const meetingDate = recording.start_time
      ? new Date(recording.start_time).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : new Date().toLocaleDateString('en-US')

    const participants = recording.participants?.map(p => p.name).filter(Boolean) || []
    const participantStr = participants.length > 0 ? ` — Participants: ${participants.join(', ')}` : ''

    console.log(`🎥 Zoom recording completed: "${meetingTopic}" on ${meetingDate}`)

    // Find transcript file in recording files
    const transcriptFile = recording.recording_files?.find(f =>
      f.file_type === 'TRANSCRIPT' || f.file_extension === 'VTT'
    )

    if (!transcriptFile) {
      console.log('⚠️ No transcript file found in recording')
      return { ok: true, message: 'No transcript file in this recording' }
    }

    // Download the VTT transcript
    const accessToken = process.env.ZOOM_OAUTH_TOKEN
    const rawVTT = await downloadTranscript(transcriptFile.download_url, accessToken)

    if (!rawVTT) {
      return { ok: false, error: 'Failed to download transcript' }
    }

    // Parse VTT to clean text
    const cleanText = parseVTT(rawVTT)

    if (cleanText.length < 100) {
      console.log('⚠️ Transcript too short, skipping')
      return { ok: true, message: 'Transcript too short to be useful' }
    }

    // Add to knowledge base
    const docTitle = `Meeting: ${meetingTopic} (${meetingDate})`
    const chunksAdded = await knowledge.addDocument(
      docTitle,
      cleanText,
      'transcript',
      {
        meetingTopic,
        meetingDate,
        participants,
        meetingId: recording.id,
        duration: recording.duration
      }
    )

    console.log(`✅ Transcript added to knowledge base: ${docTitle} (${chunksAdded} chunks)`)

    return {
      ok: true,
      title: docTitle,
      chunksAdded,
      participants,
      textLength: cleanText.length
    }
  } catch (err) {
    console.error('Zoom webhook handler error:', err.message)
    return { ok: false, error: err.message }
  }
}

// ── Verify Zoom webhook signature ─────────────────────────────────────────────
function verifyZoomWebhook(req) {
  // Zoom uses a verification token in the header
  const token = req.headers['x-zm-signature'] || req.headers['authorization']
  const expected = process.env.ZOOM_VERIFICATION_TOKEN

  if (!expected) return true  // Skip verification in dev if not set

  // For URL validation challenge
  if (req.body?.event === 'endpoint.url_validation') {
    return true  // Always allow validation
  }

  return token === expected || token === `Bearer ${expected}`
}

// ── Manually add a VTT transcript file (for testing / manual upload) ──────────
async function addTranscriptFromText(title, vttContent, metadata = {}) {
  const cleanText = parseVTT(vttContent)
  if (cleanText.length < 50) {
    return { ok: false, error: 'Transcript content too short' }
  }
  const chunksAdded = await knowledge.addDocument(title, cleanText, 'transcript', metadata)
  return { ok: true, title, chunksAdded }
}

module.exports = { handleZoomWebhook, verifyZoomWebhook, parseVTT, addTranscriptFromText }
