// Only administer temporary browser-QA accounts created for this task.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const functionRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const cliAuth = require('firebase-tools/lib/auth');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const { Client } = require('firebase-tools/lib/apiv2');
const { initializeApp, deleteApp } = functionRequire('firebase-admin/app');
const { getAuth } = functionRequire('firebase-admin/auth');
const projectId = 'study-junhyuk1203-20261021';
const [action, email] = process.argv.slice(2);
if (!['verify', 'cleanup'].includes(action) || !/^qa-ui-\d+@example\.test$/.test(email || '')) throw new Error('Only explicit temporary QA accounts are permitted');
const account = cliAuth.getProjectDefaultAccount(process.cwd());
if (!account) throw new Error('Firebase CLI login required');
await requireAuth({ project: projectId, nonInteractive: true, ...account });
const app = initializeApp({ projectId, credential: { async getAccessToken() {
  const token = await cliAuth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  return { access_token: token.access_token, expires_in: token.expires_in || 3600 };
} } }, 'qa-manager');
try {
  const auth = getAuth(app);
  const user = await auth.getUserByEmail(email);
  if (user.email !== email) throw new Error('QA identity mismatch');
  if (action === 'verify') {
    await auth.updateUser(user.uid, { emailVerified: true });
    console.log('QA email verified.');
  } else {
    const client = new Client({ urlPrefix: 'https://firestore.googleapis.com', auth: true });
    const root = `/v1/projects/${projectId}/databases/study-data/documents`;
    const collections = await client.post(`${root}/users/${user.uid}:listCollectionIds`, { pageSize: 100 });
    for (const collectionId of collections.body.collectionIds || []) {
      const rows = await client.get(`${root}/users/${user.uid}/${collectionId}`, { queryParams: { pageSize: 100 } });
      for (const row of rows.body.documents || []) {
        if (!row.name.startsWith(`projects/${projectId}/databases/study-data/documents/users/${user.uid}/`)) throw new Error('QA cleanup path mismatch');
        await client.delete(`/v1/${row.name}`);
      }
    }
    const now = new Date(Date.now() + 9 * 3600000);
    now.setUTCDate(now.getUTCDate() - (now.getUTCDay() + 6) % 7);
    const week = now.toISOString().slice(0, 10);
    await client.delete(`${root}/leaderboards/${week}/entries/${user.uid}`);
    await client.delete(`${root}/users/${user.uid}`);
    await auth.deleteUser(user.uid);
    console.log('QA account and its study data removed.');
  }
} finally { await deleteApp(app); }
