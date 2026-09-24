<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../labels.ts'
import type { Decision, IssueCategory, Suggestion } from '../../shared/types.ts'

const props = defineProps<{
  suggestions: Suggestion[]
  decisions: Record<string, Decision>
  filter: IssueCategory | 'all'
}>()

const emit = defineEmits<{
  'update:filter': [value: IssueCategory | 'all']
  accept: [id: string]
  reject: [id: string]
}>()

const options = computed(() => {
  const present = CATEGORY_ORDER.filter((category) =>
    props.suggestions.some((suggestion) => suggestion.category === category),
  )
  return [
    { id: 'all' as const, label: 'All', count: props.suggestions.length },
    ...present.map((category) => ({
      id: category,
      label: CATEGORY_LABELS[category],
      count: props.suggestions.filter((suggestion) => suggestion.category === category).length,
    })),
  ]
})

const visible = computed(() => {
  const items = props.suggestions.filter((suggestion) => props.filter === 'all' || suggestion.category === props.filter)
  return [...items].sort((a, b) => {
    const decisionRank = (suggestion: Suggestion) => {
      const decision = props.decisions[suggestion.id]
      if (!decision) return 0
      return decision === 'accepted' ? 1 : 2
    }
    return decisionRank(a) - decisionRank(b) || a.rowIndex - b.rowIndex || a.column.localeCompare(b.column)
  })
})

function confidenceLabel(suggestion: Suggestion): string {
  return suggestion.confidence[0]?.toUpperCase() + suggestion.confidence.slice(1)
}

function showSpaces(value: string): string {
  return value.replace(/^ +| +$/g, (spaces) => '·'.repeat(spaces.length))
}
</script>

<template>
  <section id="review" class="panel queue" aria-labelledby="review-title">
    <div class="panel-head">
      <h2 id="review-title">Review queue</h2>
      <p>Accept a suggestion to include it in the download. Reject it to leave the original cell alone. Leading and trailing spaces are shown as ·.</p>
    </div>
    <div class="filters" role="group" aria-label="Filter findings by type">
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        class="chip"
        :aria-pressed="filter === option.id"
        @click="emit('update:filter', option.id)"
      >
        {{ option.label }} <span class="chip-count">{{ option.count }}</span>
      </button>
    </div>
    <ol v-if="visible.length" class="cards">
      <li
        v-for="suggestion in visible"
        :key="suggestion.id"
        class="card"
        :data-decision="decisions[suggestion.id] ?? 'pending'"
      >
        <div class="card-top">
          <p class="card-title">
            Row {{ suggestion.rowIndex + 1 }}
            <span aria-hidden="true">·</span>
            {{ suggestion.column }}
          </p>
          <div class="badges">
            <span class="badge" :data-source="suggestion.source">
              {{ suggestion.source === 'ai' ? 'AI' : 'Rule' }}
            </span>
            <span class="badge quiet">{{ CATEGORY_LABELS[suggestion.category] }}</span>
            <span class="badge quiet">{{ confidenceLabel(suggestion) }} confidence</span>
          </div>
        </div>
        <div class="values">
          <p>
            <span class="value-label">Original</span>
            <code v-if="suggestion.originalValue !== ''">{{ showSpaces(suggestion.originalValue) }}</code>
            <span v-else class="empty">Empty</span>
          </p>
          <p>
            <span class="value-label">Proposed</span>
            <code v-if="suggestion.proposedValue !== null">{{ showSpaces(suggestion.proposedValue) }}</code>
            <span v-else class="empty">No replacement</span>
          </p>
        </div>
        <p class="reason">{{ suggestion.explanation }}</p>
        <div class="card-actions">
          <button
            type="button"
            class="button small primary"
            :disabled="suggestion.proposedValue === null"
            :aria-pressed="decisions[suggestion.id] === 'accepted'"
            @click="emit('accept', suggestion.id)"
          >
            Accept
          </button>
          <button
            type="button"
            class="button small"
            :aria-pressed="decisions[suggestion.id] === 'rejected'"
            @click="emit('reject', suggestion.id)"
          >
            Reject
          </button>
          <span v-if="suggestion.acceptsInBulk" class="fine">Safe to accept with other rule cleanups</span>
          <span v-else-if="suggestion.source === 'ai'" class="fine">Needs an explicit decision</span>
          <span v-else class="fine">Review only</span>
        </div>
      </li>
    </ol>
    <p v-else class="fine">No findings in this filter.</p>
  </section>
</template>
