import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { findDeterministicIssues } from './deterministic.ts'
import { decodeCsvBytes, parseCsvText, validateUpload } from './parseCsv.ts'

function text(value: string): ArrayBuffer {
  return new TextEncoder().encode(value).buffer
}

describe('upload validation', () => {
  it('rejects non-csv extensions, empty files, and files over 1 MB', () => {
    expect(validateUpload({ name: 'book.xlsx', size: 20 })).toMatch(/\.csv/)
    expect(validateUpload({ name: 'empty.csv', size: 0 })).toMatch(/empty/i)
    expect(validateUpload({ name: 'big.CSV', size: 1_048_577 })).toMatch(/1 MB/)
    expect(validateUpload({ name: 'ok.csv', size: 128 })).toBeNull()
  })
})

describe('decodeCsvBytes', () => {
  it('strips a UTF-8 BOM and rejects UTF-16 or invalid UTF-8', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('city,name\nLima,Ana\n')])
    const decoded = decodeCsvBytes(bom.buffer)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.value.startsWith('city')).toBe(true)

    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00]).buffer
    expect(decodeCsvBytes(utf16).ok).toBe(false)
    expect(decodeCsvBytes(new Uint8Array([0xff, 0x00]).buffer).ok).toBe(false)
    expect(decodeCsvBytes(text('city\nLima\n')).ok).toBe(true)
  })
})

describe('parseCsvText', () => {
  it('parses quotes, commas, CRLF, and empty cells', () => {
    const csv = 'name,notes\r\n"Ada, Lovelace","line1\r\nline2"\r\nBen,\r\n'
    const parsed = parseCsvText(csv)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.headers).toEqual(['name', 'notes'])
    expect(parsed.value.rows[0]).toEqual(['Ada, Lovelace', 'line1\r\nline2'])
    expect(parsed.value.rows[1]).toEqual(['Ben', ''])
  })

  it('rejects broken quotes, ragged rows, duplicate headers, and blank headers', () => {
    expect(parseCsvText('name,notes\n"Ada,Lovelace\n').ok).toBe(false)
    const ragged = parseCsvText('a,b\n1,2,3\n')
    expect(ragged.ok).toBe(false)
    if (!ragged.ok) expect(ragged.error).toMatch(/Row 1/)
    expect(parseCsvText('city,city\nA,B\n').ok).toBe(false)
    expect(parseCsvText('name,\nAda,x\n').ok).toBe(false)
    expect(parseCsvText('name, city\nAda,Lima\n').ok).toBe(false)
  })

  it('rejects files over the demo row limit', () => {
    const lines = ['name', ...Array.from({ length: 201 }, (_, index) => `Person ${index}`)]
    const parsed = parseCsvText(lines.join('\n'))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(/200/)
  })

  it('parses the bundled sample, including the quoted comma and formula', () => {
    const csv = readFileSync(new URL('../public/sample-customers.csv', import.meta.url), 'utf8')
    const parsed = parseCsvText(csv)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.rows).toHaveLength(13)
    expect(parsed.value.rows[1]?.[6]).toBe('Quoted, with comma')
    expect(parsed.value.rows[4]?.[2]).toBe('')
    expect(parsed.value.rows[6]?.[6]).toBe('=HYPERLINK("http://evil.example","open")')
    expect(parsed.value.rows[8]?.[4]).toBe(' pending ')
  })
})

describe('sample findings', () => {
  it('flags demo issues without inventing replacements or editing identifiers', () => {
    const csv = readFileSync(new URL('../public/sample-customers.csv', import.meta.url), 'utf8')
    const parsed = parseCsvText(csv)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const findings = findDeterministicIssues(parsed.value)

    expect(findings.every((finding) => finding.source === 'deterministic')).toBe(true)
    expect(findings.filter((finding) => finding.category === 'duplicate')).toHaveLength(3)
    expect(findings.find((finding) => finding.rowIndex === 0 && finding.column === 'full_name')?.proposedValue).toBe(
      'Ana Ruiz',
    )
    expect(findings.find((finding) => finding.rowIndex === 2 && finding.column === 'status')?.proposedValue).toBe(
      'active',
    )
    expect(findings.find((finding) => finding.rowIndex === 6 && finding.column === 'city')?.proposedValue).toBe('Lima')
    expect(findings.find((finding) => finding.rowIndex === 4 && finding.column === 'email')).toMatchObject({
      category: 'missing',
      proposedValue: null,
    })
    expect(findings.find((finding) => finding.originalValue === 'CDMX' && finding.proposedValue !== null)).toBeUndefined()
    expect(findings.filter((finding) => finding.column === 'id' && finding.proposedValue !== null)).toEqual([])
    expect(findings.filter((finding) => finding.column === 'email' && finding.proposedValue !== null)).toEqual([])
    expect(findings.find((finding) => finding.rowIndex === 1 && finding.column === 'email')?.proposedValue).toBeNull()
  })
})
