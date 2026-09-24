import { initializeApp, type FirebaseApp } from 'firebase/app'
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth'
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions'

let app: FirebaseApp | null = null
let functions: Functions | null = null
let auth: Auth | null = null
let functionsEmulatorConnected = false
let authEmulatorConnected = false
let anonymousSignIn: Promise<void> | null = null

function env(name: keyof ImportMetaEnv): string {
  return (import.meta.env[name] ?? '').trim()
}

function firebaseApp(): FirebaseApp | null {
  const projectId = env('VITE_FIREBASE_PROJECT_ID')
  if (!projectId) return null
  if (!app) {
    app = initializeApp({
      apiKey: env('VITE_FIREBASE_API_KEY'),
      authDomain: env('VITE_FIREBASE_AUTH_DOMAIN'),
      projectId,
      appId: env('VITE_FIREBASE_APP_ID'),
    })
  }
  return app
}

export function getConfiguredFunctions(): Functions | null {
  const firebase = firebaseApp()
  if (!firebase) return null
  if (!functions) functions = getFunctions(firebase, 'us-central1')
  if (!functionsEmulatorConnected && env('VITE_USE_FUNCTIONS_EMULATOR') === 'true') {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001)
    functionsEmulatorConnected = true
  }
  return functions
}

function configuredAuth(): Auth | null {
  const firebase = firebaseApp()
  if (!firebase) return null
  if (!auth) auth = getAuth(firebase)
  if (!authEmulatorConnected && env('VITE_USE_FUNCTIONS_EMULATOR') === 'true') {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    authEmulatorConnected = true
  }
  return auth
}

function whenAuthReady(authInstance: Auth): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(authInstance, () => {
      unsubscribe()
      resolve()
    })
  })
}

export function ensureAnonymousUser(): Promise<void> {
  if (!anonymousSignIn) {
    anonymousSignIn = signInOnce().catch((error: unknown) => {
      anonymousSignIn = null
      throw error
    })
  }
  return anonymousSignIn
}

async function signInOnce(): Promise<void> {
  const authInstance = configuredAuth()
  if (!authInstance) throw new Error('UNCONFIGURED')
  await whenAuthReady(authInstance)
  if (!authInstance.currentUser) await signInAnonymously(authInstance)
}
