// ─── ISTV AI DEPARTMENT — SLACK CHANNEL CONFIGURATION ──────────────────────
// Every new hire gets added to ALL of these channels automatically.
// Personal onboarding channel is created separately with naming:
//   sd-[role-slug]-[firstname]
// e.g. sd-operations-dagim, sd-designer-manula, sd-knowledge-ekata

// ── Universal channels — every single new hire, no exceptions ──────────────
const UNIVERSAL_CHANNELS = [
  { name: 'sd-main-tyler',                        reason: 'Primary department channel — everyone must be here' },
  { name: 'sd-recruiting-ai-taulant',             reason: 'Recruiting and HR — everyone must be here' },
  { name: 'sd-notion-knowledge-layer-adrian',     reason: 'Company-wide knowledge layer — everyone must be here' },
  { name: 'sd-dloa-tyler',                        reason: 'Daily DLOA submissions — everyone posts here' },
  { name: 'sd-github-tyler',                      reason: 'GitHub activity and code — everyone must be here' },
  { name: 'sd-idea-dump-tyler',                   reason: 'Ideas and experiments — everyone must be here' },
  { name: 'sd-feature-docs-sri',                  reason: 'Feature documentation — everyone must be here' },
  { name: 'sd-intercom-customer-service-saqlain', reason: 'Customer service context — everyone must be here' },
  { name: 'sd-deployment-jaya',                   reason: 'Deployments and infrastructure — everyone must be here' },
  { name: 'sd-sales-syed',                        reason: 'Sales context — everyone must be here' },
  { name: 'sd-all-meeting-transcripts-recordings-tyler', reason: 'All meeting recordings — everyone must be here' },
  { name: 'sd-eat-that-frog-tyler',               reason: 'Priority tasks and deep work — everyone must be here' },
  { name: 'sd-index',                             reason: 'Department index and navigation — everyone must be here' },
  { name: 'sd-random-convos-tyler',               reason: 'Team social channel — everyone must be here' },
  { name: 'sd-crm-ghl-deo',                       reason: 'CRM and GHL context — everyone must be here' },
  { name: 'sd-operations-katching',               reason: 'Operations updates — everyone must be here' },
  { name: 'sd-mr-moe',                            reason: 'Mr Moe AI assistant channel — everyone must be here' },
]

// ── Role slug mapping — used for personal channel naming ────────────────────
const ROLE_SLUGS = {
  'AI Chief of Staff Assistant':                    'chiefofstaff',
  'AI-native Operations Engineer Generalist':       'operations',
  'AI Knowledge Systems Engineer':                  'knowledge',
  'AI Tools Deployment Engineer':                   'deployment',
  'AI Designer':                                    'designer',
  'Other':                                          'ai',
}

// ── Generate personal onboarding channel name ────────────────────────────────
// Format: sd-[role-slug]-[firstname-lowercase]
// Examples: sd-operations-dagim, sd-designer-manula, sd-knowledge-ekata
function getPersonalChannelName(hire) {
  const roleSlug = ROLE_SLUGS[hire.role] || 'ai'
  const firstName = hire.firstName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 20)
  return `sd-${roleSlug}-${firstName}`
}

// ── Get all channel names to add a new hire to ───────────────────────────────
function getAllChannelNames(hire) {
  return UNIVERSAL_CHANNELS.map(c => c.name)
}

module.exports = {
  UNIVERSAL_CHANNELS,
  ROLE_SLUGS,
  getPersonalChannelName,
  getAllChannelNames,
}
