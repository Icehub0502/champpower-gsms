// These keys are NOT secret — every Firebase web app ships them in the page.
// Access is controlled by Firestore Security Rules + custom claims, not by hiding this.
// Values come from Vite env vars so dev/staging/prod can point at different projects
// without editing source. See .env.example for the shape.
export const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
} as const;

export const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === 'true';
