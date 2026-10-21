// Administrative CLI-only setup; never import this script from the website.
// Uses the same locally signed-in account as the pinned Firebase CLI; tokens never leave memory.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { getProjectDefaultAccount } = require('firebase-tools/lib/auth');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const { Client } = require('firebase-tools/lib/apiv2');
const { getAuthDomains, updateAuthDomains } = require('firebase-tools/lib/gcp/auth');

const project = 'study-junhyuk1203-20261021';
const account = getProjectDefaultAccount(process.cwd());
if (!account) throw new Error('Firebase CLI login is required');
await requireAuth({ project, nonInteractive: true, ...account });
const config = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));
const domains = [...new Set([...(await getAuthDomains(project)), ...config.auth.authorizedDomains])];
await updateAuthDomains(project, domains);
const client = new Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', auth: true });
await client.patch(`/admin/v2/projects/${project}/config`, {
  passwordPolicyConfig: {
    passwordPolicyEnforcementState: 'ENFORCE',
    passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12, maxPasswordLength: 128 } }],
  },
  emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
}, { queryParams: { updateMask: 'passwordPolicyConfig,emailPrivacyConfig' }, headers: { 'x-goog-user-project': project } });
const settings = (await client.get(`/admin/v2/projects/${project}/config`)).body;
const google = (await client.get(`/admin/v2/projects/${project}/defaultSupportedIdpConfigs/google.com`)).body;
console.log(JSON.stringify({
  project,
  emailPasswordEnabled: settings.signIn?.email?.enabled,
  googleEnabled: google.enabled,
  authorizedDomains: settings.authorizedDomains,
  passwordMinimum: settings.passwordPolicyConfig?.passwordPolicyVersions?.[0]?.customStrengthOptions?.minPasswordLength,
  emailEnumerationProtection: settings.emailPrivacyConfig?.enableImprovedEmailPrivacy,
}));
