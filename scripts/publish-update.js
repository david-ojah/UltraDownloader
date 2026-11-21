// Publishes the latest release version to Firebase Realtime Database so that
// running copies of Ultra Downloader can check for the update immediately.
// This runs from GitHub Actions on release:published, using the
// FIREBASE_SERVICE_ACCOUNT repository secret. It never runs inside the app.
const admin = require('firebase-admin');

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://ultra-downloader-34593-default-rtdb.firebaseio.com';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not set');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL
});

async function main() {
  const tag = process.env.RELEASE_TAG || '';
  const version = tag.replace(/^v/i, '');
  if (!version) throw new Error('RELEASE_TAG is empty');

  const url =
    process.env.RELEASE_URL ||
    `https://github.com/david-ojah/UltraDownloader/releases/tag/${tag}`;

  await admin.database().ref('app/latest').set({
    version,
    url,
    publishedAt: admin.database.ServerValue.TIMESTAMP
  });

  console.log(`Published app/latest version ${version}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
