import { dailyQuotaMessage, isUsableUid, type QuotaCharge } from './analysisQuota.ts'
import { parseAnalyzePayload, runAnalysis, type ModelClient } from './analyze.ts'
import type { Suggestion } from './types.ts'

export type AnalyzeRejectionStatus =
  | 'unauthenticated'
  | 'resource-exhausted'
  | 'failed-precondition'
  | 'invalid-argument'
  | 'internal'

export class AnalyzeRejected extends Error {
  readonly status: AnalyzeRejectionStatus

  constructor(status: AnalyzeRejectionStatus, message: string) {
    super(message)
    this.name = 'AnalyzeRejected'
    this.status = status
  }
}

export type AnalyzeCsvResponse = {
  suggestions: Array<
    Pick<
      Suggestion,
      'rowIndex' | 'column' | 'originalValue' | 'proposedValue' | 'category' | 'explanation' | 'confidence'
    >
  >
  rejected: number
  rowsConsidered: number
}

export type SecureAnalyzeInput = {
  uid: string | undefined
  data: unknown
  modelConfigured: boolean
  charge: (uid: string) => Promise<QuotaCharge>
  complete: ModelClient['complete']
}

export const UNAUTHENTICATED_MESSAGE = 'Sign in is required before AI analysis.'

const UNCONFIGURED_MESSAGE = 'AI analysis is unavailable because no model API key is configured.'

/**
 * Auth and the daily quota run before the model client.
 * Invalid or unsigned requests do not reserve quota.
 * A reserved request stays reserved even when the model call fails.
 */
export async function secureAnalyze(input: SecureAnalyzeInput): Promise<AnalyzeCsvResponse> {
  if (!isUsableUid(input.uid)) {
    throw new AnalyzeRejected('unauthenticated', UNAUTHENTICATED_MESSAGE)
  }
  if (!input.modelConfigured) {
    throw new AnalyzeRejected('failed-precondition', UNCONFIGURED_MESSAGE)
  }

  const parsed = parseAnalyzePayload(input.data)
  if (!parsed.ok) {
    throw new AnalyzeRejected('invalid-argument', parsed.message)
  }

  const reservation = await input.charge(input.uid)
  if (reservation === 'exhausted') {
    throw new AnalyzeRejected('resource-exhausted', dailyQuotaMessage())
  }

  const result = await runAnalysis(parsed.payload, { complete: input.complete })
  if (!result.ok) {
    throw new AnalyzeRejected(result.code === 'invalid_input' ? 'invalid-argument' : 'internal', result.message)
  }

  return {
    suggestions: result.suggestions.map((suggestion) => ({
      rowIndex: suggestion.rowIndex,
      column: suggestion.column,
      originalValue: suggestion.originalValue,
      proposedValue: suggestion.proposedValue,
      category: suggestion.category,
      explanation: suggestion.explanation,
      confidence: suggestion.confidence,
    })),
    rejected: result.rejected,
    rowsConsidered: result.rowsConsidered,
  }
}
