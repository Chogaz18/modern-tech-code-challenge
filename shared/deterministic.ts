import { isEmailHeader, isProtectedHeader } from './limits.ts'
import type { Confidence, ParsedTable, Suggestion } from './types.ts'

const PLACEHOLDERS = new Set([
  'n/a',
  'na',
  'null',
  'none',
  'nil',
  '-',
  '--',
  'unknown',
  'tbd',
])

interface CaseWinner {
  value: string
  confidence: Extract<Confidence, 'high' | 'medium'>
}

function displayRow(rowIndex: number): number {
  return rowIndex + 1
}

function hasLetter(value: string): boolean {
  return /\p{L}/u.test(value)
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toLowerCase())
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isCategorical(values: string[]): boolean {
  const nonEmpty = values.map((value) => value.trim()).filter((value) => value !== '')
  if (nonEmpty.length < 4) return false
  const keys = new Set(nonEmpty.map((value) => value.toLowerCase()))
  const averageLength = nonEmpty.reduce((sum, value) => sum + value.length, 0) / nonEmpty.length
  return keys.size <= 12 && keys.size / nonEmpty.length <= 0.75 && averageLength <= 28
}

function caseWinners(rows: string[][], columnIndex: number): Map<string, CaseWinner> | null {
  const trimmed = rows.map((row) => (row[columnIndex] ?? '').trim())
  if (!isCategorical(trimmed)) return null

  const groups = new Map<string, Map<string, number>>()
  for (const value of trimmed) {
    if (!value || !hasLetter(value)) continue
    const key = value.toLowerCase()
    const variants = groups.get(key) ?? new Map<string, number>()
    variants.set(value, (variants.get(value) ?? 0) + 1)
    groups.set(key, variants)
  }

  const winners = new Map<string, CaseWinner>()
  for (const [key, variants] of groups) {
    if (variants.size < 2) continue
    const ranked = [...variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const top = ranked[0]
    const second = ranked[1]
    if (!top || !second || top[1] === second[1] || top[1] < 2) continue
    const total = [...variants.values()].reduce((sum, count) => sum + count, 0)
    const share = top[1] / total
    if (share < 0.6) continue
    winners.set(key, {
      value: top[0],
      confidence: share >= 0.75 ? 'high' : 'medium',
    })
  }
  return winners
}

function push(target: Suggestion[], suggestion: Suggestion) {
  target.push(suggestion)
}

export function findDeterministicIssues(table: ParsedTable): Suggestion[] {
  const suggestions: Suggestion[] = []
  const winnersByColumn = table.headers.map((_, columnIndex) =>
    isProtectedHeader(table.headers[columnIndex] ?? '') ? null : caseWinners(table.rows, columnIndex),
  )

  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex] ?? []
    for (let columnIndex = 0; columnIndex < table.headers.length; columnIndex += 1) {
      const column = table.headers[columnIndex] ?? ''
      const raw = row[columnIndex] ?? ''
      const trimmed = raw.trim()
      const protectedColumn = isProtectedHeader(column)

      if (raw === '') {
        push(suggestions, {
          id: `det:missing:${rowIndex}:${columnIndex}`,
          source: 'deterministic',
          category: 'missing',
          rowIndex,
          columnIndex,
          column,
          originalValue: raw,
          proposedValue: null,
          explanation: `Row ${displayRow(rowIndex)} has no value in ${column}. ClearRow does not invent a replacement.`,
          confidence: 'high',
          acceptsInBulk: false,
        })
        continue
      }

      if (/^[=@]/.test(trimmed)) {
        push(suggestions, {
          id: `det:suspicious:${rowIndex}:${columnIndex}`,
          source: 'deterministic',
          category: 'suspicious',
          rowIndex,
          columnIndex,
          column,
          originalValue: raw,
          proposedValue: null,
          explanation: `Row ${displayRow(rowIndex)} ${column} starts with ${trimmed[0]}. It may be a spreadsheet formula. No value was changed; download still neutralizes formula-like cells.`,
          confidence: 'high',
          acceptsInBulk: false,
        })
      }

      if (protectedColumn) {
        if (raw !== trimmed) {
          push(suggestions, {
            id: `det:whitespace:${rowIndex}:${columnIndex}`,
            source: 'deterministic',
            category: 'whitespace',
            rowIndex,
            columnIndex,
            column,
            originalValue: raw,
            proposedValue: null,
            explanation: `${column} looks like an identifier, so surrounding spaces were flagged and left unchanged.`,
            confidence: 'high',
            acceptsInBulk: false,
          })
        }
        if (isPlaceholder(trimmed)) {
          push(suggestions, {
            id: `det:missing:${rowIndex}:${columnIndex}`,
            source: 'deterministic',
            category: 'missing',
            rowIndex,
            columnIndex,
            column,
            originalValue: raw,
            proposedValue: null,
            explanation: `${column} contains a placeholder (${trimmed}). ClearRow does not guess the real value.`,
            confidence: 'high',
            acceptsInBulk: false,
          })
        } else if (isEmailHeader(column) && !looksLikeEmail(trimmed)) {
          push(suggestions, {
            id: `det:suspicious:${rowIndex}:${columnIndex}`,
            source: 'deterministic',
            category: 'suspicious',
            rowIndex,
            columnIndex,
            column,
            originalValue: raw,
            proposedValue: null,
            explanation: `${column} does not look like an email address. It was flagged for review and not rewritten.`,
            confidence: 'medium',
            acceptsInBulk: false,
          })
        }
        continue
      }

      if (isPlaceholder(trimmed)) {
        push(suggestions, {
          id: `det:missing:${rowIndex}:${columnIndex}`,
          source: 'deterministic',
          category: 'missing',
          rowIndex,
          columnIndex,
          column,
          originalValue: raw,
          proposedValue: null,
          explanation: `${column} contains a placeholder (${trimmed}). ClearRow does not guess a replacement.`,
          confidence: 'high',
          acceptsInBulk: false,
        })
        continue
      }

      const winner = winnersByColumn[columnIndex]?.get(trimmed.toLowerCase())
      if (winner && winner.value !== trimmed) {
        push(suggestions, {
          id: `det:casing:${rowIndex}:${columnIndex}`,
          source: 'deterministic',
          category: 'casing',
          rowIndex,
          columnIndex,
          column,
          originalValue: raw,
          proposedValue: winner.value,
          explanation: `Most ${column} values with this spelling use “${winner.value}”. Surrounding spaces are removed with the case change.`,
          confidence: winner.confidence,
          acceptsInBulk: winner.confidence === 'high',
        })
        continue
      }

      if (raw !== trimmed) {
        push(suggestions, {
          id: `det:whitespace:${rowIndex}:${columnIndex}`,
          source: 'deterministic',
          category: 'whitespace',
          rowIndex,
          columnIndex,
          column,
          originalValue: raw,
          proposedValue: trimmed,
          explanation: `Remove spaces around this ${column} value.`,
          confidence: 'high',
          acceptsInBulk: true,
        })
      }
    }
  }

  const groups = new Map<string, number[]>()
  table.rows.forEach((row, rowIndex) => {
    const key = JSON.stringify(row)
    const matches = groups.get(key) ?? []
    matches.push(rowIndex)
    groups.set(key, matches)
  })

  for (const matches of groups.values()) {
    if (matches.length < 2) continue
    const labels = matches.map((rowIndex) => displayRow(rowIndex)).join(', ')
    for (const rowIndex of matches) {
      const preview = (table.rows[rowIndex] ?? []).join(' | ').slice(0, 140)
      push(suggestions, {
        id: `det:duplicate:${rowIndex}`,
        source: 'deterministic',
        category: 'duplicate',
        rowIndex,
        columnIndex: null,
        column: '(entire row)',
        originalValue: preview,
        proposedValue: null,
        explanation: `Rows ${labels} are exact copies. No row was deleted; keep the copy you want outside this automatic cleanup.`,
        confidence: 'high',
        acceptsInBulk: false,
      })
    }
  }

  return suggestions
}
