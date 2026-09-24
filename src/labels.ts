import type { IssueCategory } from '../shared/types.ts'

export const CATEGORY_LABELS: Record<IssueCategory, string> = {
  missing: 'Missing',
  duplicate: 'Duplicates',
  whitespace: 'Whitespace',
  casing: 'Casing',
  inconsistent: 'Inconsistent',
  suspicious: 'Suspicious',
  normalization: 'Normalization',
}

export const CATEGORY_ORDER: IssueCategory[] = [
  'missing',
  'duplicate',
  'whitespace',
  'casing',
  'inconsistent',
  'suspicious',
  'normalization',
]
