import { describe, expect, it } from 'vitest'
import { countFormulaCells, neutralizeFormula, toCsv } from './exportCsv.ts'
import { parseCsvText } from './parseCsv.ts'
import { applyAccepted } from './suggestions.ts'
import type { Suggestion } from './types.ts'

describe('formula-safe export', () => {
  it('preserves negative numbers and guards formula-like expressions', () => {
    expect(neutralizeFormula('-12.00')).toBe('-12.00')
    expect(neutralizeFormula('-2')).toBe('-2')
    expect(neutralizeFormula('-1+2')).toBe("'-1+2")
    expect(neutralizeFormula('=1+1')).toBe("'=1+1")
    expect(neutralizeFormula(' =1+1')).toBe("' =1+1")
    expect(neutralizeFormula('@cmd')).toBe("'@cmd")
  })

  it('keeps column order and quoting while guarding formulas', () => {
    const csv = toCsv(
      ['name', 'notes'],
      [
        ['Ada, Jr', '=1+1'],
        ['ok', '-2'],
      ],
    )
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const parsed = parseCsvText(csv.slice(1))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.headers).toEqual(['name', 'notes'])
    expect(parsed.value.rows[0]).toEqual(['Ada, Jr', "'=1+1"])
  })

  it('exports accepted edits only, then guards formula-like results', () => {
    const rows = [['keep'], ['=cmd']]
    const suggestion: Suggestion = {
      id: 'edit',
      source: 'deterministic',
      category: 'whitespace',
      rowIndex: 0,
      columnIndex: 0,
      column: 'name',
      originalValue: 'keep',
      proposedValue: '=SUM(A1)',
      explanation: 'Accepted edit',
      confidence: 'high',
      acceptsInBulk: true,
    }
    const untouched = applyAccepted(rows, [suggestion], new Set())
    expect(toCsv(['name'], untouched.rows)).toContain("'=cmd")
    expect(untouched.rows[0]?.[0]).toBe('keep')

    const applied = applyAccepted(rows, [suggestion], new Set(['edit']))
    expect(applied.rows[0]?.[0]).toBe('=SUM(A1)')
    expect(toCsv(['name'], applied.rows)).toContain("'=SUM(A1)")
    expect(countFormulaCells(['name'], applied.rows)).toBe(2)
    expect(rows[0]?.[0]).toBe('keep')
  })
})
