export const LIMITS = {
  maxFileBytes: 1_048_576,
  maxDataRows: 200,
  maxColumns: 20,
  maxCellChars: 2_000,
  maxHeaderChars: 80,
  aiMaxRows: 40,
  aiMaxCellChars: 180,
  aiMaxSuggestions: 15,
  aiDailyRequests: 10,
  aiMaxPayloadChars: 80_000,
  aiMaxProposedChars: 300,
  aiMaxExplanationChars: 400,
} as const

const PROTECTED_EXACT = new Set([
  'uuid',
  'guid',
  'ssn',
  'sin',
  'email',
  'e_mail',
  'phone',
  'telephone',
  'mobile',
  'account',
  'account_number',
  'accountnumber',
])

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** Identifier-like columns. Suggestions may flag them, never rewrite them. */
export function isProtectedHeader(header: string): boolean {
  const key = normalizeHeader(header)
  return key === 'id' || key.endsWith('_id') || PROTECTED_EXACT.has(key)
}

export function isEmailHeader(header: string): boolean {
  const key = normalizeHeader(header)
  return key === 'email' || key === 'e_mail'
}
