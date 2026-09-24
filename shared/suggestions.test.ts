import { describe, expect, it } from 'vitest'
import { findDeterministicIssues } from './deterministic.ts'
import { parseCsvText } from './parseCsv.ts'
import { applyAccepted, lookupFromTable, mergeSuggestions, validateAiSuggestionList } from './suggestions.ts'
import type { Suggestion } from './types.ts'

function table(csv: string) {
  const parsed = parseCsvText(csv)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

describe('deterministic cleanup', () => {
  it('does not bulk-accept a weak casing majority', () => {
    const findings = findDeterministicIssues(
      table('status\nYes\nYes\nYes\nyes\nyes\n'),
    )
    const change = findings.find((finding) => finding.proposedValue === 'Yes')
    expect(change).toMatchObject({ category: 'casing', confidence: 'medium', acceptsInBulk: false })
  })

  it('does not guess when casing is tied', () => {
    const findings = findDeterministicIssues(table('status\nYes\nYes\nyes\nyes\nYES\nYES\n'))
    expect(findings.filter((finding) => finding.category === 'casing' && finding.proposedValue !== null)).toEqual([])
  })

  it('trims free-text names without rewriting their case from a minority spelling', () => {
    const findings = findDeterministicIssues(
      table('full_name\n  Ana Ruiz  \nBen Ortiz\nCarla Díaz\nDiego Paredes\nana ruiz\n'),
    )
    expect(findings.find((finding) => finding.originalValue === '  Ana Ruiz  ')?.proposedValue).toBe('Ana Ruiz')
    expect(findings.find((finding) => finding.originalValue === 'ana ruiz')?.proposedValue).toBeUndefined()
  })

  it('flags duplicate rows without deleting them', () => {
    const findings = findDeterministicIssues(table('id,name\n1,Ana\n1,Ana\n2,Ben\n'))
    expect(findings.filter((finding) => finding.category === 'duplicate')).toHaveLength(2)
    expect(findings.filter((finding) => finding.category === 'duplicate').every((finding) => finding.proposedValue === null)).toBe(
      true,
    )
  })
})

describe('suggestion validation and application', () => {
  const parsed = table('id,city,notes\n10,CDMX,  hello  \n11,Lima,ok\n')

  it('rejects AI edits that miss the cell, mismatch the original, or touch identifiers', () => {
    const result = validateAiSuggestionList(
      [
        {
          rowIndex: 9,
          column: 'city',
          originalValue: 'CDMX',
          proposedValue: 'Mexico City',
          category: 'inconsistent',
          explanation: 'Missing row',
          confidence: 'high',
        },
        {
          rowIndex: 0,
          column: 'city',
          originalValue: 'cdmx',
          proposedValue: 'Mexico City',
          category: 'inconsistent',
          explanation: 'Wrong original',
          confidence: 'high',
        },
        {
          rowIndex: 0,
          column: 'id',
          originalValue: '10',
          proposedValue: '11',
          category: 'normalization',
          explanation: 'Do not touch ids',
          confidence: 'high',
        },
        {
          rowIndex: 0,
          column: 'city',
          originalValue: 'CDMX',
          proposedValue: 'Mexico City',
          category: 'inconsistent',
          explanation: 'Other rows use the long name.',
          confidence: 'low',
        },
        {
          rowIndex: 0,
          column: 'city',
          originalValue: 'CDMX',
          proposedValue: 'Mexico City',
          category: 'inconsistent',
          explanation: 'Supported by the Mexico City row.',
          confidence: 'medium',
        },
      ],
      lookupFromTable(parsed),
    )

    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({
      source: 'ai',
      confidence: 'medium',
      acceptsInBulk: false,
      proposedValue: 'Mexico City',
    })
    expect(result.rejected).toBe(4)
  })

  it('drops an AI suggestion when a deterministic edit already owns the cell', () => {
    const deterministic = findDeterministicIssues(parsed)
    const ai: Suggestion = {
      id: 'ai:0:2',
      source: 'ai',
      category: 'normalization',
      rowIndex: 0,
      columnIndex: 2,
      column: 'notes',
      originalValue: '  hello  ',
      proposedValue: 'hello!',
      explanation: 'Trim and punctuate.',
      confidence: 'low',
      acceptsInBulk: false,
    }
    const merged = mergeSuggestions(deterministic, [ai])
    expect(merged.some((suggestion) => suggestion.id === ai.id)).toBe(false)
    expect(merged.find((suggestion) => suggestion.column === 'notes')?.proposedValue).toBe('hello')
  })

  it('applies only accepted edits and leaves the original rows untouched', () => {
    const original = parsed.rows.map((row) => row.slice())
    const suggestions = findDeterministicIssues(parsed)
    const trim = suggestions.find((suggestion) => suggestion.column === 'notes' && suggestion.proposedValue === 'hello')
    expect(trim).toBeTruthy()
    if (!trim) return
    const applied = applyAccepted(parsed.rows, suggestions, new Set([trim.id]))
    expect(applied.conflicts).toEqual([])
    expect(applied.rows[0]?.[2]).toBe('hello')
    expect(applied.rows[1]).toEqual(original[1])
    expect(parsed.rows).toEqual(original)
  })

  it('does not let two accepted edits overwrite the same cell', () => {
    const first: Suggestion = {
      id: 'a',
      source: 'ai',
      category: 'inconsistent',
      rowIndex: 0,
      columnIndex: 1,
      column: 'city',
      originalValue: 'CDMX',
      proposedValue: 'Mexico City',
      explanation: 'One idea',
      confidence: 'medium',
      acceptsInBulk: false,
    }
    const second: Suggestion = { ...first, id: 'b', proposedValue: 'Ciudad de México', explanation: 'Another idea' }
    const applied = applyAccepted(parsed.rows, [first, second], new Set(['a', 'b']))
    expect(applied.conflicts[0]).toMatch(/Neither was applied/)
    expect(applied.rows[0]?.[1]).toBe('CDMX')
  })

  it('ignores accepted flags that do not propose a value', () => {
    const duplicate = findDeterministicIssues(table('id,name\n1,Ana\n1,Ana\n'))[0]
    expect(duplicate?.category).toBe('duplicate')
    if (!duplicate) return
    const source = [
      ['1', 'Ana'],
      ['1', 'Ana'],
    ]
    const applied = applyAccepted(source, [duplicate], new Set([duplicate.id]))
    expect(applied.rows).toEqual(source)
    expect(applied.conflicts).toEqual([])
  })
})
