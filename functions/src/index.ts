import { defineSecret, defineString } from 'firebase-functions/params'
import { setGlobalOptions } from 'firebase-functions/v2'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { chargeDailyQuota } from '../../shared/analysisQuota.ts'
import { AnalyzeRejected, secureAnalyze } from '../../shared/secureAnalyze.ts'
import { firestoreQuotaDb } from './firestoreQuota.ts'

const modelApiKey = defineSecret('MODEL_API_KEY')
const aiProvider = defineString('AI_PROVIDER', { default: 'openai' })
const aiModel = defineString('AI_MODEL', { default: 'gpt-4o-mini' })

setGlobalOptions({ region: 'us-central1', maxInstances: 5 })

function providerName(): 'openai' | 'anthropic' | 'gemini' {
  const provider = aiProvider.value().trim().toLowerCase()

  if (provider === 'anthropic') return 'anthropic'
  if (provider === 'gemini') return 'gemini'
  return 'openai'
}

function configuredKey(): string {
  try {
    return modelApiKey.value().trim()
  } catch {
    return (process.env.MODEL_API_KEY ?? '').trim()
  }
}

function modelName(): string {
  const configured = aiModel.value().trim()
  if (configured) return configured
  return providerName() === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini'
}

async function completeWithModel(system: string, user: string): Promise<string> {
  const key = configuredKey()
  if (!key) throw new Error('UNCONFIGURED')

  const provider = providerName()
  if (provider === 'anthropic') return completeAnthropic(key, modelName(), system, user)
  if (provider === 'gemini') return completeGemini(key, modelName(), system, user)
  return completeOpenAi(key, modelName(), system, user)
}


async function completeGemini(
  key: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(25_000),
      headers: {
        'x-goog-api-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: 'application/json',
        },
      }),
    },
  )

  if (!response.ok) {
    throw new Error(`GEMINI_${response.status}`)
  }

  const body: unknown = await response.json()
  const candidates =
    body && typeof body === 'object' && 'candidates' in body
      ? body.candidates
      : null

  const firstCandidate = Array.isArray(candidates) ? candidates[0] : null
  const parts = firstCandidate?.content?.parts
  const content = Array.isArray(parts)
    ? parts
        .map((part: unknown) =>
          part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
            ? part.text
            : '',
        )
        .join('')
        .trim()
    : ''

  if (!content) throw new Error('GEMINI_EMPTY')
  return content
}

async function completeOpenAi(key: string, model: string, system: string, user: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(25_000),
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!response.ok) {
    let providerCode = 'unknown'

    try {
      const body: unknown = await response.json()

      if (body && typeof body === 'object' && 'error' in body) {
        const error = body.error
        if (error && typeof error === 'object' && 'code' in error) {
          if (typeof error.code === 'string') providerCode = error.code
        }
      }
    } catch {
      // Conservamos el estado HTTP si la respuesta no es JSON.
    }

    throw new Error(`OPENAI_${response.status}_${providerCode}`)
  }
  const body: unknown = await response.json()
  const content =
    body &&
    typeof body === 'object' &&
    'choices' in body &&
    Array.isArray(body.choices)
      ? body.choices[0]?.message?.content
      : null
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('OPENAI_EMPTY')
  }
  return content
}

async function completeAnthropic(
  key: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(25_000),
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!response.ok) {
    throw new Error(`ANTHROPIC_${response.status}`)
  }
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('content' in body) || !Array.isArray(body.content)) {
    throw new Error('ANTHROPIC_EMPTY')
  }
  const text = body.content
    .filter((block): block is { type: string; text: string } => {
      return (
        !!block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      )
    })
    .map((block) => block.text)
    .join('\n')
    .trim()
  if (!text) throw new Error('ANTHROPIC_EMPTY')
  return text
}

const callableOptions = {
  secrets: [modelApiKey],
  timeoutSeconds: 60,
  memory: '256MiB' as const,
  invoker: 'public' as const,
}

// Availability only. The UI calls this before anonymous sign-in, and it does not spend quota.
export const aiStatus = onCall(callableOptions, () => {
  return {
    available: configuredKey() !== '',
    provider: providerName(),
  }
})

export const analyzeCsv = onCall(callableOptions, async (request) => {
  try {
    console.info('analyzeCsv: started', {
      authenticated: Boolean(request.auth?.uid),
    })

    const result = await secureAnalyze({
      uid: request.auth?.uid,
      data: request.data,
      modelConfigured: configuredKey() !== '',

      charge: async (uid) => {
        console.info('analyzeCsv: charging quota')
        await chargeDailyQuota(firestoreQuotaDb(), uid)
        console.info('analyzeCsv: quota granted')
      },

      complete: async (system, user) => {
        console.info('analyzeCsv: calling model')
        const response = await completeWithModel(system, user)
        console.info('analyzeCsv: model responded')
        return response
      },
    })

    console.info('analyzeCsv: completed')
    return result
  } catch (error) {
    // No registrar request.data, system, user ni la API key.
    console.error('analyzeCsv: failed', {
      type: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown error',
    })

    if (error instanceof AnalyzeRejected) {
      throw new HttpsError(error.status, error.message)
    }

    throw error
  }
})
