<script setup lang="ts">
import { computed } from 'vue'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../labels.ts'
import type { Decision, Suggestion } from '../../shared/types.ts'

const props = defineProps<{
  suggestions: Suggestion[]
  decisions: Record<string, Decision>
}>()

const bars = computed(() => {
  const counts = CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    count: props.suggestions.filter((suggestion) => suggestion.category === category).length,
  })).filter((item) => item.count > 0)
  const max = Math.max(1, ...counts.map((item) => item.count))
  return counts.map((item) => ({ ...item, width: `${Math.round((item.count / max) * 100)}%` }))
})

const ruleCount = computed(() => props.suggestions.filter((suggestion) => suggestion.source === 'deterministic').length)
const aiCount = computed(() => props.suggestions.filter((suggestion) => suggestion.source === 'ai').length)
const accepted = computed(
  () =>
    props.suggestions.filter(
      (suggestion) => props.decisions[suggestion.id] === 'accepted' && suggestion.proposedValue !== null,
    ).length,
)
</script>

<template>
  <section class="panel overview" aria-labelledby="overview-title">
    <div class="overview-copy">
      <p class="kicker">Overview</p>
      <h2 id="overview-title">Findings by type</h2>
      <dl class="stats">
        <div>
          <dt>Rule findings</dt>
          <dd>{{ ruleCount }}</dd>
        </div>
        <div>
          <dt>AI suggestions</dt>
          <dd>{{ aiCount }}</dd>
        </div>
        <div>
          <dt>Accepted edits</dt>
          <dd>{{ accepted }}</dd>
        </div>
      </dl>
      <p class="fine">Rule findings are deterministic. They stay labeled as rules even after an AI pass.</p>
    </div>
    <div>
      <ul v-if="bars.length" class="chart">
        <li v-for="item in bars" :key="item.category">
          <span class="chart-label">{{ item.label }}</span>
          <span class="chart-track" aria-hidden="true">
            <span class="chart-fill" :data-category="item.category" :style="{ width: item.width }"></span>
          </span>
          <span class="chart-value">{{ item.count }}</span>
        </li>
      </ul>
      <p v-else class="fine">No findings yet.</p>
    </div>
  </section>
</template>
