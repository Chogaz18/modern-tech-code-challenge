import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'
import { dailyQuotaMessage } from '../../shared/analysisQuota.ts'
import { LIMITS } from '../../shared/limits.ts'
import type { AnalyzePayload } from '../../shared/types.ts'
import { ensureAnonymousUser, getConfiguredFunctions } from './firebase.ts'

export type AiAvailability = {
  state: 'disabled' | 'checking' | 'ready' | 'unconfigured' | 'unreachable'
  message: string
}

export type AiRequestResult =
  | { ok: true; suggestions: unknown; rejected: number; rowsConsidered: number }
  | { ok: false; code: 'unconfigured' | 'invalid' | 'quota' | 'failed'; message: string }

const DISABLED_MESSAGE =
  'AI analysis is unavailable because Firebase is not configured. Findings on this page come from deterministic rules, not from a model.'

export function initialAiAvailability(): AiAvailability {
  if (!getConfiguredFunctions()) {
    return { state: 'disabled', message: DISABLED_MESSAGE }
  }
  return { state: 'checking', message: 'Checking whether AI analysis is configured.' }
}

export async function checkAiAvailability(): Promise<AiAvailability> {
  const functions = getConfiguredFunctions()
  if (!functions) return { state: 'disabled', message: DISABLED_MESSAGE }
  try {
    const call = httpsCallable<undefined, { available?: boolean }>(functions, 'aiStatus')
    const response = await call()
    if (response.data?.available) {
      return {
        state: 'ready',
        message: `AI analysis can send up to ${LIMITS.aiMaxRows} rows to your Firebase function. This anonymous sign-in can run ${LIMITS.aiDailyRequests} analyses per UTC day. ClearRow does not store the rows.`,
      }
    }
    return {
      state: 'unconfigured',
      message:
        'The Firebase function is deployed without a model key. Deterministic findings still work and are not model output.',
    }
  } catch {
    return {
      state: 'unreachable',
      message:
        'The AI function could not be reached. Deterministic review still works, and those findings were not produced by a model.',
    }
  }
}

function anonymousSignInMessage(error: unknown): string {
  if (error instanceof FirebaseError && error.code === 'auth/operation-not-allowed') {
    return 'Anonymous sign-in is turned off for this Firebase project, so AI analysis did not run. Enable the Anonymous provider in Firebase Authentication.'
  }
  if ((import.meta.env.VITE_USE_FUNCTIONS_EMULATOR ?? '').trim() === 'true') {
    return 'Anonymous sign-in failed, so AI analysis did not run. Start the Auth, Firestore, and Functions emulators together, then try again.'
  }
  return 'Anonymous sign-in failed, so AI analysis did not run. Enable the Anonymous provider in Firebase Authentication, then try again.'
}

export async function requestAiSuggestions(payload: AnalyzePayload): Promise<AiRequestResult> {
  const functions = getConfiguredFunctions()
  if (!functions) return { ok: false, code: 'unconfigured', message: DISABLED_MESSAGE }
  try {
    await ensureAnonymousUser()
  } catch (error) {
    return { ok: false, code: 'failed', message: anonymousSignInMessage(error) }
  }
  try {
    const call = httpsCallable<AnalyzePayload, { suggestions?: unknown; rejected?: unknown; rowsConsidered?: unknown }>(
      functions,
      'analyzeCsv',
    )
    const response = await call(payload)
    const rejected = typeof response.data?.rejected === 'number' ? response.data.rejected : 0
    const rowsConsidered = typeof response.data?.rowsConsidered === 'number' ? response.data.rowsConsidered : payload.rows.length
    return {
      ok: true,
      suggestions: response.data?.suggestions,
      rejected,
      rowsConsidered,
    }
  } catch (error) {
    if (error instanceof FirebaseError && error.code === 'functions/failed-precondition') {
      return {
        ok: false,
        code: 'unconfigured',
        message: 'AI analysis is unavailable because no model API key is configured.',
      }
    }
    if (error instanceof FirebaseError && error.code === 'functions/invalid-argument') {
      return {
        ok: false,
        code: 'invalid',
        message: 'The analysis request was rejected. No AI suggestions were added.',
      }
    }
    if (error instanceof FirebaseError && error.code === 'functions/resource-exhausted') {
      return {
        ok: false,
        code: 'quota',
        message: error.message || dailyQuotaMessage(),
      }
    }
    if (error instanceof FirebaseError && error.code === 'functions/unauthenticated') {
      return {
        ok: false,
        code: 'failed',
        message: 'Sign in is required before AI analysis. Anonymous sign-in did not complete.',
      }
    }
    return {
      ok: false,
      code: 'failed',
      message: 'AI analysis failed. Deterministic findings are unchanged and were not produced by a model.',
    }
  }
}
