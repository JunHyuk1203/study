import { firebaseConfig } from './firebase-config.js';

let currentUser = null;
let services;
let registering = false;
let resolved = false;

export function getAuthUser() { return currentUser; }

function message(text, error = false) {
  const status = document.querySelector('[data-auth-status]');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('is-error', error);
  status.hidden = !text;
}

function paintAccount() {
  for (const node of document.querySelectorAll('[data-account-loading]')) node.hidden = resolved;
  if (!resolved) return;
  const name = currentUser?.displayName || '회원';
  for (const avatar of document.querySelectorAll('.profile-dot, [data-auth-avatar]')) avatar.textContent = currentUser ? name.slice(0, 1).toUpperCase() : '·';
  for (const node of document.querySelectorAll('[data-auth-name]')) node.textContent = name;
  for (const node of document.querySelectorAll('[data-auth-email]')) node.textContent = currentUser?.email || '';
  for (const node of document.querySelectorAll('[data-guest-account]')) node.hidden = Boolean(currentUser);
  for (const node of document.querySelectorAll('[data-member-account]')) node.hidden = !currentUser;
  for (const node of document.querySelectorAll('[data-email-state]')) node.textContent = currentUser?.emailVerified ? '인증된 이메일' : '이메일 미인증';
  const verify = document.querySelector('[data-auth-action="verify-email"]');
  if (verify) verify.hidden = !currentUser || currentUser.emailVerified;
}

function friendlyError(error) {
  const messages = {
    'auth/invalid-credential': '이메일 또는 비밀번호를 확인해 주세요.',
    'auth/user-not-found': '이메일 또는 비밀번호를 확인해 주세요.',
    'auth/wrong-password': '이메일 또는 비밀번호를 확인해 주세요.',
    'auth/email-already-in-use': '이미 사용 중인 이메일입니다. 로그인해 주세요.',
    'auth/weak-password': '비밀번호는 12자 이상으로 입력해 주세요.',
    'auth/password-does-not-meet-requirements': '비밀번호는 12자 이상으로 입력해 주세요.',
    'auth/invalid-email': '이메일 주소를 확인해 주세요.',
    'auth/too-many-requests': '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
    'auth/network-request-failed': '인터넷 연결을 확인해 주세요.',
    'auth/popup-blocked': 'Google 로그인 팝업이 차단되었습니다. 팝업을 허용한 뒤 다시 시도해 주세요.',
    'auth/popup-closed-by-user': 'Google 로그인이 취소되었습니다.',
    'auth/cancelled-popup-request': '이미 로그인 창이 열려 있습니다.',
    'auth/unauthorized-domain': '현재 주소에서 로그인을 사용할 수 없습니다. 등록된 서비스 주소에서 다시 시도해 주세요.',
    'auth/account-exists-with-different-credential': '이 이메일로 가입한 기존 로그인 방법을 사용해 주세요.',
    'auth/operation-not-allowed': '현재 로그인 방법을 사용할 수 없습니다.',
    'auth/web-storage-unsupported': '브라우저에서 사이트 저장소를 허용한 뒤 다시 시도해 주세요.',
  };
  return messages[error?.code] || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

async function initialize() {
  const [appSdk, authSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js'),
  ]);
  const app = appSdk.getApps()[0] ?? appSdk.initializeApp(firebaseConfig);
  const auth = authSdk.getAuth(app);
  auth.languageCode = 'ko';
  await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
  services = { ...authSdk, auth };
  authSdk.onAuthStateChanged(auth, user => {
    currentUser = user;
    resolved = true;
    paintAccount();
    if (!registering) window.dispatchEvent(new Event('study:auth-changed'));
  });
  await auth.authStateReady();
  currentUser = auth.currentUser;
  resolved = true;
  paintAccount();
  for (const button of document.querySelectorAll('[data-auth-form] [type="submit"], [data-auth-action="google"]')) button.disabled = false;
  return services;
}

export const authReady = initialize().catch(error => {
  resolved = true;
  paintAccount();
  message('로그인을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.', true);
  return null;
});
const ready = authReady;

document.addEventListener('submit', async event => {
  const form = event.target.closest('[data-auth-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy === 'true') return;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const mode = form.dataset.authForm;
  const email = String(data.get('email') || '').trim();
  const password = String(data.get('password') || '');
  const displayName = String(data.get('displayName') || '').trim();
  if (mode === 'signup' && (password !== data.get('confirmPassword') || displayName.length < 2 || displayName.length > 20 || /[\p{Cc}\p{Cf}]/u.test(displayName))) {
    message(password !== data.get('confirmPassword') ? '두 비밀번호가 일치하지 않습니다.' : '닉네임은 2~20자로 입력해 주세요.', true);
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  const previousText = submit.textContent;
  form.dataset.busy = 'true';
  submit.disabled = true;
  submit.textContent = '처리 중…';
  message('');
  try {
    await ready;
    if (!services) throw new Error('Auth unavailable');
    const { auth } = services;
    if (mode === 'signup') {
      registering = true;
      const credential = await services.createUserWithEmailAndPassword(auth, email, password);
      let profileSaved = true;
      try { await services.updateProfile(credential.user, { displayName }); } catch { profileSaved = false; }
      currentUser = auth.currentUser;
      paintAccount();
      // Registration has already succeeded; later failures must not invite a duplicate signup.
      form.hidden = true;
      message(profileSaved ? '회원가입이 완료됐습니다. 계정 화면에서 이메일을 인증해 주세요.' : '회원가입이 완료됐습니다. 닉네임 저장은 완료하지 못했습니다.');
      document.querySelector('[data-auth-success]')?.removeAttribute('hidden');
    } else if (mode === 'reset') {
      await services.sendPasswordResetEmail(auth, email);
      message('해당 이메일로 가입한 계정이 있다면 비밀번호 재설정 메일이 발송됩니다.');
    } else {
      await services.signInWithEmailAndPassword(auth, email, password);
      window.location.assign('account.html');
    }
  } catch (error) {
    message(friendlyError(error), true);
  } finally {
    if (mode !== 'reset') {
      form.querySelector('[name="password"]').value = '';
      const confirmation = form.querySelector('[name="confirmPassword"]');
      if (confirmation) confirmation.value = '';
    }
    if (registering) {
      registering = false;
      window.dispatchEvent(new Event('study:auth-changed'));
    }
    form.dataset.busy = 'false';
    submit.disabled = false;
    submit.textContent = previousText;
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-auth-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.authAction;
  button.disabled = true;
  message('');
  try {
    await ready;
    if (!services) throw new Error('Auth unavailable');
    if (action === 'google') {
      const provider = new services.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await services.signInWithPopup(services.auth, provider);
      window.location.assign('account.html');
    } else if (action === 'logout') {
      await services.signOut(services.auth);
      message('로그아웃했습니다.');
    } else if (action === 'verify-email') {
      if (!services.auth.currentUser) throw new Error('Not signed in');
      await services.sendEmailVerification(services.auth.currentUser);
      message('인증 메일을 보냈습니다. 메일에서 인증한 뒤 인증 상태 확인을 눌러 주세요.');
    } else if (action === 'refresh-user') {
      if (!services.auth.currentUser) throw new Error('Not signed in');
      await services.reload(services.auth.currentUser);
      await services.auth.currentUser.getIdToken(true);
      currentUser = services.auth.currentUser;
      paintAccount();
      window.dispatchEvent(new Event('study:auth-changed'));
      message(currentUser.emailVerified ? '이메일 인증이 확인됐습니다.' : '이메일 인증이 아직 확인되지 않았습니다.');
    }
  } catch (error) {
    message(friendlyError(error), true);
  } finally {
    button.disabled = false;
  }
});

window.addEventListener('study:navigated', paintAccount);
window.addEventListener('study:page-prepared', paintAccount);
document.addEventListener('DOMContentLoaded', paintAccount);
