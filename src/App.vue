<script setup lang="ts">
import OverviewPanel from './components/OverviewPanel.vue'
import PreviewTable from './components/PreviewTable.vue'
import ReviewQueue from './components/ReviewQueue.vue'
import UploadPanel from './components/UploadPanel.vue'
import { useClearRow } from './composables/useClearRow.ts'

const {
  limits,
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
} = useClearRow()
</script>

<template>
  <a v-if="table" class="skip" href="#review">Skip to review queue</a>
  <div class="shell">
    <header class="topbar">
      <div>
        <h1 class="brand">ClearRow</h1>
        <p class="tagline">Review every cleanup before it touches the file.</p>
      </div>
    </header>

    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <p v-if="notice" class="banner" role="status">{{ notice }}</p>

    <UploadPanel
      v-if="!table"
      :busy="status === 'parsing'"
      max-file-label="1 MB"
      :max-rows="limits.maxDataRows"
      :max-columns="limits.maxColumns"
      @select="loadFile"
      @sample="loadSample"
    />

    <template v-else>
      <section class="toolbar" aria-label="Review actions">
        <div class="file-meta">
          <p class="file-name">{{ fileName }}</p>
          <p>{{ table.rows.length }} rows · {{ table.headers.length }} columns</p>
        </div>
        <div class="actions">
          <button
            type="button"
            class="button primary"
            :disabled="ai.state !== 'ready' || status === 'analyzing'"
            aria-describedby="ai-status"
            @click="analyze"
          >
            {{ status === 'analyzing' ? 'Analyzing…' : 'Analyze with AI' }}
          </button>
          <button type="button" class="button" :disabled="safePending === 0 || status === 'analyzing'" @click="acceptSafe">
            Accept safe cleanups
            <span v-if="safePending">({{ safePending }})</span>
          </button>
          <button type="button" class="button" :disabled="status === 'analyzing'" @click="download">Download CSV</button>
          <button type="button" class="button ghost" @click="reset">Start over</button>
        </div>
        <p id="ai-status" class="fine">{{ ai.message }}</p>
        <label class="toggle">
          <input v-model="showCleaned" type="checkbox" />
          <span>Preview accepted edits</span>
        </label>
        <p v-if="preview" class="fine">
          Downloads include accepted edits only and prefix {{ preview.formulaCells }} formula-like cell{{
            preview.formulaCells === 1 ? '' : 's'
          }}
          that start with =, +, -, or @.
        </p>
      </section>

      <OverviewPanel :suggestions="suggestions" :decisions="decisions" />

      <div class="workspace" :aria-busy="status === 'analyzing'">
        <PreviewTable
          v-if="preview"
          :headers="preview.headers"
          :rows="preview.rows"
          :original-rows="preview.originalRows"
          :show-cleaned="showCleaned"
          :suggestions="suggestions"
        />
        <ReviewQueue
          :suggestions="suggestions"
          :decisions="decisions"
          :filter="filter"
          @update:filter="filter = $event"
          @accept="accept"
          @reject="reject"
        />
      </div>
    </template>
  </div>
</template>
