import { isProtectedHeader, LIMITS } from './limits.ts'
import type {
  AnalyzePayload,
  ApplyResult,
  CellLookup,
  Confidence,
  IssueCategory,
  ParsedTable,
  Suggestion,
} from './types.ts'

const AI_CATEGORIES = new Set<IssueCategory>(['inconsistent', 'suspicious', 'normalization'])
const CONFIDENCE = new Set<Confidence>(['high', 'medium', 'low'])
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function cellKey(rowIndex: number, columnIndex: number): string {
  return `${rowIndex}:${columnIndex}`
}

export function lookupFromTable(table: ParsedTable): CellLookup {
  return {
    headers: table.headers,
    get(rowIndex, column) {
      const columnIndex = table.headers.indexOf(column)
      const row = table.rows[rowIndex]
      if (columnIndex < 0 || !row) return null
      return { value: row[columnIndex] ?? '', truncated: false }
    },
  }
}

export function lookupFromPayload(payload: AnalyzePayload): CellLookup {
  const byIndex = new Map(payload.rows.map((row) => [row.rowIndex, row]))
  return {
    headers: payload.headers,
    get(rowIndex, column) {
      const columnIndex = payload.headers.indexOf(column)
      const row = byIndex.get(rowIndex)
      if (columnIndex < 0 || !row) return null
      const cell = row.cells[columnIndex]
      if (!cell) return null
      return cell
    },
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function validateAiSuggestionList(
  items: unknown,
  lookup: CellLookup,
): { suggestions: Suggestion[]; rejected: number } {
  if (!Array.isArray(items)) {
    return { suggestions: [], rejected: 0 }
  }

  const accepted: Suggestion[] = []
  let rejected = 0
  const capped = items.slice(0, LIMITS.aiMaxSuggestions)
  rejected += Math.max(0, items.length - capped.length)

  for (const item of capped) {
    const suggestion = validateOne(item, lookup)
    if (!suggestion) {
      rejected += 1
      continue
    }
    accepted.push(suggestion)
  }

  const byCell = new Map<string, Suggestion>()
  const kept: Suggestion[] = []
  for (const suggestion of accepted) {
    if (suggestion.columnIndex === null) {
      rejected += 1
      continue
    }
    const key = cellKey(suggestion.rowIndex, suggestion.columnIndex)
    const existing = byCell.get(key)
    if (!existing) {
      byCell.set(key, suggestion)
      kept.push(suggestion)
      continue
    }
    rejected += 1
    if (CONFIDENCE_RANK[suggestion.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      const index = kept.indexOf(existing)
      if (index >= 0) kept[index] = suggestion
      byCell.set(key, suggestion)
    }
  }

  return { suggestions: kept, rejected }
}

function validateOne(item: unknown, lookup: CellLookup): Suggestion | null {
  if (!isRecord(item)) return null
  const rowIndex = item.rowIndex
  const column = readString(item.column)
  const originalValue = readString(item.originalValue)
  const proposedValue = readString(item.proposedValue)
  const category = readString(item.category)
  const explanation = readString(item.explanation)?.trim() ?? null
  const confidence = readString(item.confidence)

  if (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 0) return null
  if (!column || !lookup.headers.includes(column)) return null
  if (originalValue === null || proposedValue === null || !category || !explanation || !confidence) {
    return null
  }
  if (!AI_CATEGORIES.has(category as IssueCategory)) return null
  if (!CONFIDENCE.has(confidence as Confidence)) return null
  if (isProtectedHeader(column)) return null
  if (explanation.length > LIMITS.aiMaxExplanationChars) return null
  if (proposedValue.length === 0 || proposedValue.length > LIMITS.aiMaxProposedChars) return null
  if (/[\r\n]/.test(proposedValue)) return null
  if (/ignore (all|any|previous|above) instructions/i.test(proposedValue)) return null

  const cell = lookup.get(rowIndex, column)
  if (!cell || cell.truncated) return null
  if (cell.value !== originalValue) return null
  if (proposedValue === originalValue) return null

  const columnIndex = lookup.headers.indexOf(column)
  return {
    id: `ai:${rowIndex}:${columnIndex}`,
    source: 'ai',
    category: category as IssueCategory,
    rowIndex,
    columnIndex,
    column,
    originalValue,
    proposedValue,
    explanation,
    confidence: confidence as Confidence,
    acceptsInBulk: false,
  }
}

export function mergeSuggestions(deterministic: Suggestion[], ai: Suggestion[]): Suggestion[] {
  const occupied = new Set(
    deterministic
      .filter((suggestion) => suggestion.proposedValue !== null && suggestion.columnIndex !== null)
      .map((suggestion) => cellKey(suggestion.rowIndex, suggestion.columnIndex ?? -1)),
  )
  const filtered = ai.filter((suggestion) => {
    if (suggestion.source !== 'ai' || suggestion.acceptsInBulk) return false
    if (suggestion.columnIndex === null || suggestion.proposedValue === null) return false
    return !occupied.has(cellKey(suggestion.rowIndex, suggestion.columnIndex))
  })
  return [...deterministic, ...filtered]
}

export function applyAccepted(
  rows: string[][],
  suggestions: Suggestion[],
  acceptedIds: ReadonlySet<string>,
): ApplyResult {
  const next = rows.map((row) => row.slice())
  const conflicts: string[] = []
  const grouped = new Map<string, Suggestion[]>()

  for (const suggestion of suggestions) {
    if (!acceptedIds.has(suggestion.id)) continue
    if (suggestion.proposedValue === null || suggestion.columnIndex === null) continue
    const key = cellKey(suggestion.rowIndex, suggestion.columnIndex)
    const group = grouped.get(key) ?? []
    group.push(suggestion)
    grouped.set(key, group)
  }

  for (const group of grouped.values()) {
    const first = group[0]
    if (!first || first.columnIndex === null || first.proposedValue === null) continue
    const proposals = new Set(group.map((suggestion) => suggestion.proposedValue))
    const originals = new Set(group.map((suggestion) => suggestion.originalValue))
    if (proposals.size > 1 || originals.size > 1) {
      conflicts.push(
        `Two accepted changes target row ${first.rowIndex + 1} ${first.column}. Neither was applied.`,
      )
      continue
    }
    const row = next[first.rowIndex]
    if (!row || first.columnIndex >= row.length) {
      conflicts.push(`An accepted change does not match a cell in this file.`)
      continue
    }
    if ((row[first.columnIndex] ?? '') !== first.originalValue) {
      conflicts.push(
        `The accepted change for row ${first.rowIndex + 1} ${first.column} no longer matches the original cell.`,
      )
      continue
    }
    row[first.columnIndex] = first.proposedValue
  }

  return { rows: next, conflicts }
}

export function acceptedIdSet(decisions: Record<string, 'accepted' | 'rejected'>): Set<string> {
  return new Set(
    Object.entries(decisions)
      .filter(([, decision]) => decision === 'accepted')
      .map(([id]) => id),
  )
}
