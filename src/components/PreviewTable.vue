<script setup lang="ts">
import { computed } from 'vue'
import type { Suggestion } from '../../shared/types.ts'

const props = defineProps<{
  headers: string[]
  rows: string[][]
  originalRows: string[][]
  showCleaned: boolean
  suggestions: Suggestion[]
}>()

const byCell = computed(() => {
  const map = new Map<string, string[]>()
  for (const suggestion of props.suggestions) {
    if (suggestion.columnIndex === null) continue
    const key = `${suggestion.rowIndex}:${suggestion.columnIndex}`
    const labels = map.get(key) ?? []
    labels.push(suggestion.category)
    map.set(key, labels)
  }
  return map
})

const duplicateRows = computed(
  () => new Set(props.suggestions.filter((suggestion) => suggestion.category === 'duplicate').map((suggestion) => suggestion.rowIndex)),
)

function displayCell(value: string): string {
  return value.replace(/^ +| +$/g, (spaces) => '·'.repeat(spaces.length))
}

function cellLabel(rowIndex: number, columnIndex: number, value: string): string {
  const shown = value === '' ? 'Empty' : value
  const findings = byCell.value.get(`${rowIndex}:${columnIndex}`)
  if (!findings?.length) return shown
  return `${shown}. Findings: ${findings.join(', ')}`
}
</script>

<template>
  <section class="panel preview" aria-labelledby="preview-title">
    <div class="panel-head">
      <h2 id="preview-title">{{ showCleaned ? 'Preview with accepted edits' : 'Original data' }}</h2>
      <p>{{ rows.length }} data rows. Empty cells stay visible. Original rows are not overwritten in memory.</p>
    </div>
    <div class="table-scroll" tabindex="0" aria-labelledby="preview-title">
      <table class="grid">
        <caption class="sr-only">
          {{ showCleaned ? 'CSV preview after accepted edits' : 'Original CSV preview' }}
        </caption>
        <thead>
          <tr>
            <th class="row-num" scope="col">Row</th>
            <th v-for="header in headers" :key="header" scope="col">{{ header }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in rows" :key="rowIndex" :class="{ duplicate: duplicateRows.has(rowIndex) }">
            <th class="row-num" scope="row">
              {{ rowIndex + 1 }}
              <span v-if="duplicateRows.has(rowIndex)" class="mini">Dup</span>
            </th>
            <td
              v-for="(value, columnIndex) in row"
              :key="`${rowIndex}-${columnIndex}`"
              :class="{
                found: byCell.get(`${rowIndex}:${columnIndex}`),
                changed: showCleaned && value !== (originalRows[rowIndex]?.[columnIndex] ?? ''),
              }"
              :aria-label="cellLabel(rowIndex, columnIndex, value)"
            >
              <span v-if="value === ''" class="empty">Empty</span>
              <span v-else class="cell-text">{{ displayCell(value) }}</span>
              <span
                v-if="showCleaned && value !== (originalRows[rowIndex]?.[columnIndex] ?? '')"
                class="mini edit"
              >Edited</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
