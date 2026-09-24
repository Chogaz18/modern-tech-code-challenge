import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type DocumentReference, type Firestore } from 'firebase-admin/firestore'
import type { QuotaDb, QuotaRef } from '../../shared/analysisQuota.ts'

type StoredRef = QuotaRef & { ref: DocumentReference }

export function ensureAdminApp(): void {
  if (getApps().length === 0) initializeApp()
}

export function firestoreQuotaDb(): QuotaDb {
  ensureAdminApp()
  return wrapFirestore(getFirestore())
}

function wrapFirestore(db: Firestore): QuotaDb {
  return {
    doc(path: string): QuotaRef {
      const ref = db.doc(path)
      const stored: StoredRef = { path: ref.path, ref }
      return stored
    },
    runTransaction(update) {
      return db.runTransaction((tx) =>
        update({
          async get(quotaRef) {
            const snap = await tx.get(storedRef(quotaRef).ref)
            return {
              exists: snap.exists,
              data() {
                const raw = snap.data()
                if (!raw) return undefined
                return { count: raw.count }
              },
            }
          },
          set(quotaRef, data) {
            tx.set(storedRef(quotaRef).ref, data)
          },
        }),
      )
    },
  }
}

function storedRef(quotaRef: QuotaRef): StoredRef {
  if (!('ref' in quotaRef)) throw new Error('INVALID_QUOTA_REF')
  return quotaRef as StoredRef
}
