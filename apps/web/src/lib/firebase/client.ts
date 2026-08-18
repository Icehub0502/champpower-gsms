import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  getAuth,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDocs,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
} from 'firebase/firestore';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { FIREBASE_CONFIG, USE_EMULATORS } from './config';

export const app = initializeApp(FIREBASE_CONFIG);

export const auth = getAuth(app);

// This one line replaces the old app's `db.enablePersistence({ synchronizeTabs: true })`:
// writes queue locally when offline and flush automatically when the connection comes
// back, and multiple open tabs share one local cache instead of fighting over it.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const storage = getStorage(app);

if (USE_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}

// Dev-only escape hatch for one-off console seeding/debugging — never present in a
// production build since import.meta.env.DEV is false there.
if (import.meta.env.DEV) {
  (window as unknown as { __firebase: unknown }).__firebase = {
    app,
    auth,
    db,
    storage,
    collection,
    doc,
    setDoc,
    addDoc,
    deleteDoc,
    getDocs,
  };
}
