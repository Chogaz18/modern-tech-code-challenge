export type IssueCategory =
  | 'missing'
  | 'duplicate'
  | 'whitespace'
  | 'casing'
  | 'inconsistent'
  | 'suspicious'
  | 'normalization'

export type Confidence = 'high' | 'medium' | 'low'
export type SuggestionSource = 'deterministic' | 'ai'
export type Decision = 'accepted' | 'rejected'

export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

export interface Suggestion {
  id: string
  source: SuggestionSource
  category: IssueCategory
  rowIndex: number
  columnIndex: number | null
  column: string
  originalValue: string
  proposedValue: string | null
  explanation: string
  confidence: Confidence
  acceptsInBulk: boolean
}

export interface AnalyzeCell {
  value: string
  truncated: boolean
}

export interface AnalyzeRow {
  rowIndex: number
  cells: AnalyzeCell[]
}

export interface AnalyzePayload {
  headers: string[]
  rows: AnalyzeRow[]
}

export interface CellLookup {
  headers: string[]
  get(rowIndex: number, column: string): { value: string; truncated: boolean } | null
}

export interface ApplyResult {
  rows: string[][]
  conflicts: string[]
}
