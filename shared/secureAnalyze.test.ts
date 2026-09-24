import { describe, expect, it, vi } from 'vitest'
import {
  chargeDailyQuota,
  quotaDocPath,
  type QuotaDb,
  type QuotaDocument,
  type QuotaRef,
  type QuotaSnapshot,
  type QuotaTransaction,
} from './analysisQuota.ts'
import { AnalyzeRejected, secureAnalyze } from './secureAnalyze.ts'

function payload() {
  return {
    headers: ['city'],
    rows: [{ rowIndex: 0, cells: [{ value: 'lima', truncated: false }] }],
  }
}

function emptyModel() {
  return '{"suggestions":[]}'
}

/**
 * Optimistic store: every concurrent transaction snapshots the document
 * before any of those snapshots can commit. A commit fails when the
 * snapshot version is stale, and the transaction function runs again.
 * Without that check, all concurrent callers would keep a count of 1.
 */
function createMemoryQuotaDb(contentionWidth = 1): QuotaDb & { countAt(path: string): number | undefined } {
  const docs = new Map<string, { count: number; version: number }>()
  let pending = 0
  let armed = contentionWidth > 1
  let gate: Promise<void> = Promise.resolve()
  let openGate: (() => void) | null = null

  function commit(seen: Map<string, number>, writes: Map<string, QuotaDocument>): boolean {
    for (const [path, version] of seen) {
      if ((docs.get(path)?.version ?? 0) !== version) return false
    }
    for (const [path, data] of writes) {
      docs.set(path, { count: data.count, version: (docs.get(path)?.version ?? 0) + 1 })
    }
    return true
  }

  return {
    countAt(path: string) {
      return docs.get(path)?.count
    },
    doc(path: string): QuotaRef {
      return { path }
    },
    async runTransaction<T>(update: (tx: QuotaTransaction) => Promise<T>): Promise<T> {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const seen = new Map<string, number>()
        const writes = new Map<string, QuotaDocument>()
        const result = await update({
          async get(ref): Promise<QuotaSnapshot> {
            const current = docs.get(ref.path)
            seen.set(ref.path, current?.version ?? 0)
            const count = current?.count
            if (attempt === 0 && armed) {
              pending += 1
              if (pending === 1) {
                gate = new Promise<void>((resolve) => {
                  openGate = resolve
                })
              }
              if (pending >= contentionWidth) {
                armed = false
                pending = 0
                openGate?.()
              }
              await gate
            }
            return {
              exists: count !== undefined,
              data: () => (count === undefined ? undefined : { count }),
            }
          },
          set(ref, data) {
            writes.set(ref.path, data)
          },
        })
        if (commit(seen, writes)) return result
      }
      throw new Error('transaction contention was not resolved')
    },
  }
}

describe('analyzeCsv authentication', () => {
  it('rejects an unauthenticated call before quota or the model', async () => {
    const charge = vi.fn(async () => 'charged' as const)
    const complete = vi.fn(async () => emptyModel())

    await expect(
      secureAnalyze({
        uid: undefined,
        data: payload(),
        modelConfigured: true,
        charge,
        complete,
      }),
    ).rejects.toMatchObject({
      status: 'unauthenticated',
      message: 'Sign in is required before AI analysis.',
    })

    await expect(
      secureAnalyze({
        uid: '',
        data: payload(),
        modelConfigured: true,
        charge,
        complete,
      }),
    ).rejects.toBeInstanceOf(AnalyzeRejected)

    expect(charge).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })

  it('does not reserve quota when the payload is invalid or the model key is missing', async () => {
    const charge = vi.fn(async () => 'charged' as const)
    const complete = vi.fn(async () => emptyModel())

    await expect(
      secureAnalyze({
        uid: 'anon-user',
        data: {},
        modelConfigured: true,
        charge,
        complete,
      }),
    ).rejects.toMatchObject({ status: 'invalid-argument' })

    await expect(
      secureAnalyze({
        uid: 'anon-user',
        data: payload(),
        modelConfigured: false,
        charge,
        complete,
      }),
    ).rejects.toMatchObject({ status: 'failed-precondition' })

    expect(charge).not.toHaveBeenCalled()
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('daily analysis quota', () => {
  it('stops at 10 requests for one uid on a UTC day and resets the next day', async () => {
    const db = createMemoryQuotaDb()
    const uid = 'anon-user'
    const day = new Date('2026-09-24T23:30:00.000Z')
    let modelCalls = 0
    const complete = async () => {
      modelCalls += 1
      return emptyModel()
    }
    const charge = (id: string) => chargeDailyQuota(db, id, day)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await secureAnalyze({ uid, data: payload(), modelConfigured: true, charge, complete })
    }

    await expect(
      secureAnalyze({ uid, data: payload(), modelConfigured: true, charge, complete }),
    ).rejects.toMatchObject({
      status: 'resource-exhausted',
      message: 'This sign-in has used all 10 AI analyses for the current UTC day. The limit resets at 00:00 UTC.',
    })

    expect(modelCalls).toBe(10)
    expect(db.countAt(quotaDocPath(uid, '2026-09-24'))).toBe(10)

    await secureAnalyze({
      uid: 'other-user',
      data: payload(),
      modelConfigured: true,
      charge,
      complete,
    })
    expect(db.countAt(quotaDocPath('other-user', '2026-09-24'))).toBe(1)

    const nextDay = new Date('2026-09-25T00:00:00.000Z')
    await secureAnalyze({
      uid,
      data: payload(),
      modelConfigured: true,
      charge: (id) => chargeDailyQuota(db, id, nextDay),
      complete,
    })
    expect(modelCalls).toBe(12)
    expect(db.countAt(quotaDocPath(uid, '2026-09-25'))).toBe(1)
  })

  it('charges the quota before calling the model and keeps the charge when the model fails', async () => {
    const db = createMemoryQuotaDb()
    const now = new Date('2026-09-24T12:00:00.000Z')
    const order: string[] = []

    await expect(
      secureAnalyze({
        uid: 'anon-user',
        data: payload(),
        modelConfigured: true,
        charge: async (uid) => {
          order.push('charge')
          return chargeDailyQuota(db, uid, now)
        },
        complete: async () => {
          order.push('model')
          throw new Error('provider down')
        },
      }),
    ).rejects.toMatchObject({ status: 'internal' })

    expect(order).toEqual(['charge', 'model'])
    expect(db.countAt(quotaDocPath('anon-user', '2026-09-24'))).toBe(1)
  })

  it('lets only 10 of 20 concurrent attempts through and does not call the model for the rest', async () => {
    const db = createMemoryQuotaDb(20)
    const now = new Date('2026-09-24T15:00:00.000Z')
    let modelCalls = 0

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        secureAnalyze({
          uid: 'anon-user',
          data: payload(),
          modelConfigured: true,
          charge: (uid) => chargeDailyQuota(db, uid, now),
          complete: async () => {
            modelCalls += 1
            return emptyModel()
          },
        }).then(
          () => 'ok' as const,
          (error: unknown) => {
            if (error instanceof AnalyzeRejected && error.status === 'resource-exhausted') return 'exhausted' as const
            throw error
          },
        ),
      ),
    )

    expect(results.filter((result) => result === 'ok')).toHaveLength(10)
    expect(results.filter((result) => result === 'exhausted')).toHaveLength(10)
    expect(modelCalls).toBe(10)
    expect(db.countAt(quotaDocPath('anon-user', '2026-09-24'))).toBe(10)
  })
})
