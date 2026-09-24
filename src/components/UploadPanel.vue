<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  busy: boolean
  maxFileLabel: string
  maxRows: number
  maxColumns: number
}>()

const emit = defineEmits<{
  select: [file: File, multiple: boolean]
  sample: []
}>()

const dragging = ref(false)

function onDrop(event: DragEvent) {
  dragging.value = false
  const files = event.dataTransfer?.files
  const file = files?.[0]
  if (!file) return
  emit('select', file, (files?.length ?? 0) > 1)
}

function onChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) emit('select', file, false)
  input.value = ''
}
</script>

<template>
  <section class="panel upload" aria-labelledby="upload-title">
    <div
      class="drop"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <p class="kicker">Start a review</p>
      <h2 id="upload-title">Bring in a CSV</h2>
      <p class="lede">
        Drop a file here, or browse. ClearRow checks the extension, size, UTF-8 encoding, headers, and shape before it
        shows a single cell.
      </p>
      <div class="actions">
        <label class="button primary">
          Browse CSV
          <input class="sr-only" type="file" accept=".csv,text/csv" :disabled="busy" @change="onChange" />
        </label>
        <button type="button" class="button" :disabled="busy" @click="emit('sample')">Load sample</button>
      </div>
      <p class="limits">
        Demo limit: UTF-8 <code>.csv</code> up to {{ maxFileLabel }}, {{ maxRows }} data rows, and {{ maxColumns }}
        columns. The sample includes duplicates, blank cells, casing, quoted commas, and formula-like values.
      </p>
    </div>
  </section>
</template>
