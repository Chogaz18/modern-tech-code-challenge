import Papa from 'papaparse'
import { LIMITS } from './limits.ts'
import type { ParsedTable } from './types.ts'

export type Failure = { ok: false; error: string }
export type Success<T> = { ok: true; value: T }

const FILE_LIMIT_LABEL = '1 MB'

export function validateUpload(file: { name: string; size: number }): string | null {
  const name = file.name.trim()
  if (!name.toLowerCase().endsWith('.csv')) {
    return 'Choose a .csv file. Other spreadsheet formats are not supported in this demo.'
  }
  if (file.size <= 0) {
    return 'That file is empty.'
  }
  if (file.size > LIMITS.maxFileBytes) {
    return `That file is larger than ${FILE_LIMIT_LABEL}. This demo accepts CSV files up to ${FILE_LIMIT_LABEL}.`
  }
  return null
}

export function decodeCsvBytes(buffer: ArrayBuffer): Success<string> | Failure {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 2) {
    const isUtf16 =
      (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
    if (isUtf16) {
      return {
        ok: false,
        error: 'This file looks like UTF-16. Save it as UTF-8 and try again.',
      }
    }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    return { ok: true, value: text }
  } catch {
    return {
      ok: false,
      error: 'This file is not valid UTF-8. Save it as UTF-8 and try again.',
    }
  }
}

export function parseCsvText(text: string): Success<ParsedTable> | Failure {
  if (text.length > LIMITS.maxFileBytes) {
    return {
      ok: false,
      error: `That CSV is larger than ${FILE_LIMIT_LABEL}. This demo stops at ${FILE_LIMIT_LABEL}.`,
    }
  }

  const trimmed = text.trim()
  if (!trimmed) {
    return { ok: false, error: 'That CSV has no rows.' }
  }

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: ',',
  })

  const quoteError = result.errors.find((error) => error.type === 'Quotes')
  if (quoteError) {
    const rowLabel = typeof quoteError.row === 'number' ? ` near row ${quoteError.row + 1}` : ''
    return {
      ok: false,
      error: `The CSV has a broken quoted field${rowLabel}. Close the quote or remove the stray quotation mark.`,
    }
  }

  const matrix = result.data.filter((row) => row.some((cell) => cell.trim() !== ''))
  if (matrix.length === 0) {
    return { ok: false, error: 'That CSV has no rows.' }
  }

  const headers = matrix[0]?.map((cell) => cell) ?? []
  if (headers.length === 0) {
    return { ok: false, error: 'That CSV is missing a header row.' }
  }
  if (headers.length > LIMITS.maxColumns) {
    return {
      ok: false,
      error: `This file has ${headers.length} columns. The demo limit is ${LIMITS.maxColumns}.`,
    }
  }

  const seen = new Set<string>()
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index] ?? ''
    if (header.trim() === '') {
      return { ok: false, error: `Column ${index + 1} has a blank header.` }
    }
    if (header !== header.trim()) {
      return {
        ok: false,
        error: `The header "${header}" has surrounding spaces. Remove them and upload the file again.`,
      }
    }
    if (header.length > LIMITS.maxHeaderChars) {
      return {
        ok: false,
        error: `The header "${header.slice(0, 24)}…" is longer than ${LIMITS.maxHeaderChars} characters.`,
      }
    }
    if (seen.has(header)) {
      return { ok: false, error: `The header "${header}" appears more than once.` }
    }
    seen.add(header)
  }

  const rows = matrix.slice(1)
  if (rows.length === 0) {
    return { ok: false, error: 'The CSV has headers but no data rows.' }
  }
  if (rows.length > LIMITS.maxDataRows) {
    return {
      ok: false,
      error: `This file has ${rows.length} data rows. The demo limit is ${LIMITS.maxDataRows}.`,
    }
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? []
    if (row.length !== headers.length) {
      return {
        ok: false,
        error: `Row ${index + 1} has ${row.length} columns, but the header has ${headers.length}. Check for a missing comma or an unquoted line break.`,
      }
    }
    for (let column = 0; column < row.length; column += 1) {
      const value = row[column] ?? ''
      if (value.length > LIMITS.maxCellChars) {
        return {
          ok: false,
          error: `Row ${index + 1}, column "${headers[column]}", is longer than ${LIMITS.maxCellChars} characters.`,
        }
      }
    }
  }

  return { ok: true, value: { headers, rows } }
}
