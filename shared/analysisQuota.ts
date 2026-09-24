import { LIMITS } from './limits.ts'

export type QuotaCharge = 'charged' | 'exhausted'

export type QuotaDocument = {
  count: number
  uid: string
  day: string
}

export type QuotaSnapshot = {
  exists: boolean
  data(): { count?: unknown } | undefined
}

export type QuotaRef = {
  path: string
}

export type QuotaTransaction = {
  get(ref: QuotaRef): Promise<QuotaSnapshot>
  set(ref: QuotaRef, data: QuotaDocument): void
}

/** Subset of the Firestore Admin client used to charge a daily quota. */
export type QuotaDb = {
  doc(path: string): QuotaRef
  runTransaction<T>(update: (tx: QuotaTransaction) => Promise<T>): Promise<T>
}

export function dailyQuotaMessage(): string {
  return `This sign-in has used all ${LIMITS.aiDailyRequests} AI analyses for the current UTC day. The limit resets at 00:00 UTC.`
}

export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function isUsableUid(uid: string | undefined): uid is string {
  return (
    typeof uid === 'string' &&
    uid.length > 0 &&
    uid.length <= 128 &&
    !uid.includes('/') &&
    !uid.includes('\0') &&
    uid !== '.' &&
    uid !== '..'
  )
}

export function quotaDocPath(uid: string, day: string): string {
  return `analysisQuota/${uid}/days/${day}`
}

function readCount(snapshot: QuotaSnapshot): number {
  if (!snapshot.exists) return 0
  const count = snapshot.data()?.count
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return 0
  return Math.floor(count)
}

/**
 * Reserves one analysis for this uid and UTC day.
 * The read and the increment run in one transaction, so overlapping calls
 * cannot all observe the same count and slip past the limit.
 * The reservation is committed before the caller may contact the model.
 */
export async function chargeDailyQuota(db: QuotaDb, uid: string, now = new Date()): Promise<QuotaCharge> {
  if (!isUsableUid(uid)) throw new Error('INVALID_UID')
  const day = utcDayKey(now)
  const ref = db.doc(quotaDocPath(uid, day))
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref)
    const count = readCount(snapshot)
    if (count >= LIMITS.aiDailyRequests) return 'exhausted'
    tx.set(ref, { count: count + 1, uid, day })
    return 'charged'
  })
}
