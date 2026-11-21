// Firebase Realtime Database listener used to notify running apps about a new
// release. Only the public web config lives here: the database rules allow
// public reads of `app/latest` and deny all client writes, so this file holds
// no secret. The GitHub release feed remains the source of truth; this
// listener only tells the app to check sooner than the polling fallback.
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, onValue } = require('firebase/database');

const firebaseConfig = {
  apiKey: 'AIzaSyAlC23KjEL2PWcnx0QgWVE_JucIwD8jpzU',
  authDomain: 'ultra-downloader-34593.firebaseapp.com',
  databaseURL: 'https://ultra-downloader-34593-default-rtdb.firebaseio.com',
  projectId: 'ultra-downloader-34593',
  storageBucket: 'ultra-downloader-34593.firebasestorage.app',
  messagingSenderId: '695130209205',
  appId: '1:695130209205:web:5c410b5aa3ae0fa4d7b7fc'
};

let app = null;
let db = null;

function init() {
  if (db) return true;
  if (!firebaseConfig.databaseURL) return false;
  try {
    app = initializeApp(firebaseConfig, 'ultra-downloader-notify');
    db = getDatabase(app);
    console.log('Firebase notify: initialized');
    return true;
  } catch (e) {
    console.error('Firebase notify: init failed:', e && e.message ? e.message : e);
    app = null;
    db = null;
    return false;
  }
}

// Subscribes to app/latest. The callback receives the raw value
// ({ version, url, publishedAt } or null). Returns an unsubscribe function.
// Any failure is swallowed: the periodic GitHub check still runs.
function subscribeLatest(handler) {
  if (!init()) return () => {};
  let unsubscribe = () => {};
  try {
    console.log('Firebase notify: listening on app/latest');
    unsubscribe = onValue(
      ref(db, 'app/latest'),
      (snapshot) => {
        const value = snapshot.val();
        console.log('Firebase notify: value', value ? JSON.stringify(value) : 'null');
        try { handler(value); } catch {}
      },
      (err) => {
        // Permission or network errors are expected offline; polling covers it.
        console.error('Firebase notify: listen error:', err && err.message ? err.message : err);
      }
    );
  } catch (e) {
    console.error('Firebase notify: subscribe failed:', e && e.message ? e.message : e);
    return () => {};
  }
  return () => {
    try { unsubscribe(); } catch {}
  };
}

module.exports = {
  subscribeLatest,
  firebaseConfig
};
