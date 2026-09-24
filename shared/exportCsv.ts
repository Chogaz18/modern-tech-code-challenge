import Papa from 'papaparse'

const FORMULA_START = /^[\t\r\n ]*[=+\-@]/
const NEGATIVE_NUMBER = /^-\d+(?:\.\d+)?$/

export function needsFormulaGuard(value: string): boolean {
  if (NEGATIVE_NUMBER.test(value.trim())) return false

  return FORMULA_START.test(value)
}

/** Prefix formula-like cells so spreadsheets treat them as text. */
export function neutralizeFormula(value: string): string {
  return needsFormulaGuard(value) ? `'${value}` : value
}

export function toCsv(headers: string[], rows: string[][]): string {
  const csv = Papa.unparse({
    fields: headers.map(neutralizeFormula),
    data: rows.map((row) => row.map(neutralizeFormula)),
  })
  return `\uFEFF${csv}`
}

export function countFormulaCells(headers: string[], rows: string[][]): number {
  let count = 0
  for (const header of headers) if (needsFormulaGuard(header)) count += 1
  for (const row of rows) {
    for (const cell of row) if (needsFormulaGuard(cell)) count += 1
  }
  return count
}
