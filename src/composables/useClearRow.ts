import { computed, onMounted, ref } from 'vue'
import { selectRowsForAnalysis } from '../../shared/analyze.ts'
import { findDeterministicIssues } from '../../shared/deterministic.ts'
import { countFormulaCells, toCsv } from '../../shared/exportCsv.ts'
import { LIMITS } from '../../shared/limits.ts'
import { decodeCsvBytes, parseCsvText, validateUpload } from '../../shared/parseCsv.ts'
import {
  acceptedIdSet,
  applyAccepted,
  cellKey,
  lookupFromTable,
  mergeSuggestions,
  validateAiSuggestionList,
} from '../../shared/suggestions.ts'
import type { Decision, IssueCategory, ParsedTable, Suggestion } from '../../shared/types.ts'
import { checkAiAvailability, initialAiAvailability, requestAiSuggestions, type AiAvailability } from '../lib/aiClient.ts'

export function useClearRow() {
  const table = ref<ParsedTable | null>(null)
  const fileName = ref('')
  const suggestions = ref<Suggestion[]>([])
  const decisions = ref<Record<string, Decision>>({})
  const status = ref<'idle' | 'parsing' | 'ready' | 'analyzing'>('idle')
  const error = ref('')
  const notice = ref('')
  const showCleaned = ref(false)
  const filter = ref<IssueCategory | 'all'>('all')
  const ai = ref<AiAvailability>(initialAiAvailability())

  const preview = computed(() => {
    if (!table.value) return null
    const applied = applyAccepted(table.value.rows, suggestions.value, acceptedIdSet(decisions.value))
    return {
      headers: table.value.headers,
      originalRows: table.value.rows,
      rows: showCleaned.value ? applied.rows : table.value.rows,
      formulaCells: countFormulaCells(table.value.headers, applied.rows),
    }
  })

  const safePending = computed(
    () =>
      suggestions.value.filter(
        (suggestion) => suggestion.acceptsInBulk && decisions.value[suggestion.id] === undefined,
      ).length,
  )

  onMounted(() => {
    void refreshAi()
  })

  async function refreshAi() {
    ai.value = await checkAiAvailability()
  }

  function adopt(nextTable: ParsedTable, name: string) {
    table.value = nextTable
    fileName.value = name
    suggestions.value = findDeterministicIssues(nextTable)
    decisions.value = {}
    showCleaned.value = false
    filter.value = 'all'
    status.value = 'ready'
    const count = suggestions.value.length
    notice.value =
      count === 0
        ? 'No deterministic issues found.'
        : `Found ${count} deterministic finding${count === 1 ? '' : 's'}. These come from rules, not from a model.`
  }

  async function loadFile(file: File, onlyFirst = false) {
    error.value = ''
    const metaError = validateUpload(file)
    if (metaError) {
      error.value = metaError
      return
    }
    status.value = 'parsing'
    try {
      const decoded = decodeCsvBytes(await file.arrayBuffer())
      if (!decoded.ok) {
        error.value = decoded.error
        status.value = table.value ? 'ready' : 'idle'
        return
      }
      const parsed = parseCsvText(decoded.value)
      if (!parsed.ok) {
        error.value = parsed.error
        status.value = table.value ? 'ready' : 'idle'
        return
      }
      adopt(parsed.value, file.name)
      if (onlyFirst) {
        notice.value = `Only one CSV can be reviewed at a time. ${notice.value}`
      }
    } catch {
      error.value = 'The file could not be read.'
      status.value = table.value ? 'ready' : 'idle'
    }
  }

  async function loadSample() {
    error.value = ''
    status.value = 'parsing'
    try {
      const response = await fetch('/sample-customers.csv')
      if (!response.ok) throw new Error('missing sample')
      const parsed = parseCsvText(await response.text())
      if (!parsed.ok) {
        error.value = parsed.error
        status.value = table.value ? 'ready' : 'idle'
        return
      }
      adopt(parsed.value, 'sample-customers.csv')
    } catch {
      error.value = 'The sample CSV could not be loaded.'
      status.value = table.value ? 'ready' : 'idle'
    }
  }

  function reset() {
    table.value = null
    fileName.value = ''
    suggestions.value = []
    decisions.value = {}
    showCleaned.value = false
    filter.value = 'all'
    status.value = 'idle'
    error.value = ''
    notice.value = ''
  }

  function accept(id: string) {
    const suggestion = suggestions.value.find((item) => item.id === id)
    if (!suggestion || suggestion.proposedValue === null || suggestion.columnIndex === null) return
    if (decisions.value[id] === 'accepted') {
      const next = { ...decisions.value }
      delete next[id]
      decisions.value = next
      return
    }
    const key = cellKey(suggestion.rowIndex, suggestion.columnIndex)
    const conflict = suggestions.value.find(
      (other) =>
        other.id !== id &&
        decisions.value[other.id] === 'accepted' &&
        other.columnIndex !== null &&
        cellKey(other.rowIndex, other.columnIndex) === key,
    )
    if (conflict) {
      error.value = `Reject the other accepted change for row ${suggestion.rowIndex + 1} ${suggestion.column} before accepting this one.`
      return
    }
    error.value = ''
    decisions.value = { ...decisions.value, [id]: 'accepted' }
  }

  function reject(id: string) {
    if (decisions.value[id] === 'rejected') {
      const next = { ...decisions.value }
      delete next[id]
      decisions.value = next
      return
    }
    decisions.value = { ...decisions.value, [id]: 'rejected' }
  }

  function acceptSafe() {
    const next = { ...decisions.value }
    let count = 0
    for (const suggestion of suggestions.value) {
      if (!suggestion.acceptsInBulk || suggestion.proposedValue === null || suggestion.columnIndex === null) continue
      if (next[suggestion.id]) continue
      const key = cellKey(suggestion.rowIndex, suggestion.columnIndex)
      const blocked = suggestions.value.some(
        (other) =>
          other.id !== suggestion.id &&
          next[other.id] === 'accepted' &&
          other.columnIndex !== null &&
          cellKey(other.rowIndex, other.columnIndex) === key,
      )
      if (blocked) continue
      next[suggestion.id] = 'accepted'
      count += 1
    }
    decisions.value = next
    error.value = ''
    notice.value =
      count === 0
        ? 'No safe deterministic cleanups are waiting.'
        : `Accepted ${count} safe deterministic cleanup${count === 1 ? '' : 's'}. Review-only flags stay unaccepted, and AI suggestions are never included here.`
  }

  async function analyze() {
    if (!table.value || ai.value.state !== 'ready') return
    status.value = 'analyzing'
    error.value = ''
    const payload = selectRowsForAnalysis(table.value, suggestions.value)
    const result = await requestAiSuggestions(payload)
    if (!table.value) return
    if (!result.ok) {
      status.value = 'ready'
      error.value = result.message
      if (result.code === 'unconfigured') {
        ai.value = {
          state: 'unconfigured',
          message: result.message,
        }
      }
      return
    }
    const validated = validateAiSuggestionList(result.suggestions, lookupFromTable(table.value))
    const deterministic = suggestions.value.filter((suggestion) => suggestion.source === 'deterministic')
    suggestions.value = mergeSuggestions(deterministic, validated.suggestions)
    const kept = new Set(suggestions.value.map((suggestion) => suggestion.id))
    decisions.value = Object.fromEntries(Object.entries(decisions.value).filter(([id]) => kept.has(id)))
    status.value = 'ready'
    const added = validated.suggestions.length
    const discarded = result.rejected + validated.rejected
    if (added === 0 && discarded === 0) {
      notice.value = `The model reviewed ${result.rowsConsidered} rows and did not suggest additional changes.`
      return
    }
    notice.value = `The model reviewed ${result.rowsConsidered} of ${table.value.rows.length} rows and added ${added} AI suggestion${added === 1 ? '' : 's'}.${
      discarded ? ` ${discarded} model response${discarded === 1 ? '' : 's'} did not match this file and ${discarded === 1 ? 'was' : 'were'} discarded.` : ''
    }`
  }

  function download() {
    if (!table.value) return
    const applied = applyAccepted(table.value.rows, suggestions.value, acceptedIdSet(decisions.value))
    if (applied.conflicts.length > 0) {
      error.value = applied.conflicts[0] ?? 'Those edits conflict.'
      return
    }
    const csv = toCsv(table.value.headers, applied.rows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'clearrow-cleaned.csv'
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    const guarded = countFormulaCells(table.value.headers, applied.rows)
    error.value = ''
    notice.value = guarded
      ? `Downloaded clearrow-cleaned.csv. ${guarded} formula-like cell${guarded === 1 ? '' : 's'} were prefixed so spreadsheets treat them as text.`
      : 'Downloaded clearrow-cleaned.csv with accepted edits only.'
  }

  return {
    limits: LIMITS,
    table,
    fileName,
    suggestions,
    decisions,
    status,
    error,
    notice,
    showCleaned,
    filter,
    ai,
    preview,
    safePending,
    loadFile,
    loadSample,
    reset,
    accept,
    reject,
    acceptSafe,
    analyze,
    download,
  }
}
