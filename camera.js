import { facePose, paintAvatar } from './camera-avatar.js?v=20261022-9';
import { createFocusTracker } from './camera-focus.js?v=20261023-2';
import { paintCameraDebug } from './camera-debug.js?v=20261023-1';
import { loadCameraInference } from './camera-inference.js?v=20261023-1';
// Raw frames stay off-screen; only derived behavior and tracking state reach the UI.
const focusTracker = createFocusTracker();
let reason = null;
let diagnostics = null;
const video = document.createElement('video');
video.autoplay = true;
video.muted = true;
video.playsInline = true;
video.setAttribute('aria-hidden', 'true');
video.className = 'cam-analysis-video';
let avatarPose = null;
let fallbackDetector, fallbackAttempted = false, fallbackLoading = false;
let stream, worker, loop, watchdog, loadingDeadline;
let enabled = false, tracking = false, status = 'off', message = '얼굴 인식으로 학습 시작';
let ready = false, inFlight = false, lastResult = 0, revision = 0, lastVideoTime = -1;
let focusPanel, focusOrigin, previousFocus;
let morphFrame;
let manuallyPaused = false;
let companionUntil=0;
function cameraVisible(){return !document.hidden || performance.now()<companionUntil;}
export function setCameraCompanion(durationMs){
  companionUntil=performance.now()+Math.max(0,Math.min(30000,durationMs));
  if(enabled && !cameraVisible())setStatus('paused','화면을 벗어났습니다 · 일시정지');
}
export const cameraController = crypto.randomUUID();
export function cameraState() { return { enabled, tracking, status, message, reason, manuallyPaused }; }
export function toggleCameraPause() {
  if (!enabled) return;
  manuallyPaused = !manuallyPaused;
  focusTracker.reset(); diagnostics = null;
  setStatus('scanning', '얼굴을 다시 확인하는 중…');
}
export function openCameraFocus(origin) {
  if (focusPanel) return;
  const template = document.querySelector('#camera-focus-template');
  if (!template) return;
  previousFocus = document.activeElement;
  focusOrigin = origin.getBoundingClientRect();
  focusPanel = template.content.firstElementChild.cloneNode(true);
  const subject = document.querySelector('[data-study-subject]');
  focusPanel.querySelector('[data-focus-subject]').textContent = subject?.selectedOptions[0]?.textContent || '학습';
  document.body.append(focusPanel);
  document.querySelector('.app').inert = true;
  document.documentElement.classList.add('camera-focus-open');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const panel = focusPanel;
    panel.classList.add('is-morphing');
    const target = panel.querySelector('.cam-viewport').getBoundingClientRect();
    const frame = document.createElement('div');
    frame.className = 'cam-morph-frame';
    frame.setAttribute('aria-hidden', 'true');
    for (const corner of origin.querySelectorAll('.cam-corner')) frame.append(corner.cloneNode(true));
    const face = origin.querySelector('.cam-face')?.cloneNode(true);
    if (face) frame.append(face);
    document.body.append(frame); morphFrame = frame;
    const geometry = rect => ({ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, fill: 'both', easing: 'ease-out' });
    if (face) {
      const destination = Math.min(target.width, target.height) * 120 / 320;
      face.style.strokeWidth = '4';
      face.animate([
        { width: '48px', height: '48px', strokeWidth: '5.75', transform: 'translate(-50%,-50%) scale(1)' },
        { width: `${destination}px`, height: `${destination}px`, transform: 'translate(-50%,-50%) scale(1.1,.92)', offset: .7 },
        { width: `${destination}px`, height: `${destination}px`, transform: 'translate(-50%,-50%) scale(.96,1.05)', offset: .86 },
        { width: `${destination}px`, height: `${destination}px`, transform: 'translate(-50%,-50%) scale(1)' },
      ], { duration: 900, fill: 'forwards', easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    for (const corner of frame.querySelectorAll('.cam-corner')) corner.animate([{ width: '19px', height: '19px' }, { width: '40px', height: '40px' }], { duration: 900, fill: 'forwards', easing: 'cubic-bezier(.22,.68,.1,1)' });
    frame.animate([geometry(focusOrigin), geometry(target)], { duration: 900, fill: 'forwards', easing: 'cubic-bezier(.22,.68,.1,1)' }).finished.then(() => {
      if (panel.dataset.closing) { frame.remove(); return; }
      panel.classList.remove('is-morphing');
      frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished.then(() => frame.remove()).catch(() => frame.remove());
      if (morphFrame === frame) morphFrame = null;
    }).catch(() => { if (!panel.dataset.closing) panel.classList.remove('is-morphing'); frame.remove(); });
  }
  focusPanel.querySelector('.cam-end').focus();
}
export async function closeCameraFocus() {
  const panel = focusPanel;
  if (!panel) return;
  panel.dataset.closing = 'true';
  const currentFrame = morphFrame?.getBoundingClientRect();
  const currentCorner = morphFrame?.querySelector('.cam-corner')?.getBoundingClientRect().width;
  focusPanel = null;
  for (const animation of morphFrame?.getAnimations() || []) animation.cancel();
  morphFrame?.remove(); morphFrame = null;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const viewport = panel.querySelector('.cam-viewport');
    const source = currentFrame || viewport.getBoundingClientRect();
    const origin = document.querySelector('.app > main [data-camera-toggle]');
    const target = origin?.getBoundingClientRect() || focusOrigin;
    const frame = document.createElement('div');
    frame.className = 'cam-morph-frame';
    frame.setAttribute('aria-hidden', 'true');
    for (const corner of viewport.querySelectorAll('.cam-corner')) frame.append(corner.cloneNode(true));
    const face = origin?.querySelector('.cam-face')?.cloneNode(true);
    if (face) frame.append(face);
    document.body.append(frame);
    panel.classList.add('is-morphing');
    const timing = { duration: 650, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' };
    const geometry = rect => ({ top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 350, fill: 'forwards', easing: 'ease-out' });
    for (const corner of frame.querySelectorAll('.cam-corner')) corner.animate([{ width: `${currentCorner || 35}px`, height: `${currentCorner || 35}px` }, { width: '19px', height: '19px' }], timing);
    if (face) face.animate([{ opacity: 0, transform: 'translate(-50%,-50%) scale(1.4)' }, { opacity: 0, offset: .55 }, { opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }], timing);
    await frame.animate([geometry(source), geometry(target)], timing).finished.catch(() => {});
    frame.remove();
  }
  panel.remove(); document.querySelector('.app').inert = false;
  document.documentElement.classList.remove('camera-focus-open');
  previousFocus?.focus(); paint();
}

function paint() {
  const root = focusPanel?.querySelector('[data-camera]') || document.querySelector('.app > main [data-camera]');
  if (!root) return;
  root.dataset.state = status;
  root.dataset.reason = reason || '';
  root.classList.toggle('is-open', enabled);
  const mount = root.querySelector('[data-camera-video]');
  paintAvatar(mount, avatarPose, tracking, manuallyPaused ? 'manual-paused' : status);
  root.querySelector('[data-camera-status]').textContent = message;
  const toggle = root.querySelector('[data-camera-toggle]');
  toggle?.setAttribute('aria-label', enabled ? '스터디캠 실행 중' : '얼굴 인식으로 학습 시작');
  root.querySelector('[data-camera-resolution]').textContent = enabled && video.videoWidth ? 'AVATAR · 기기 내 인식' : '';
  if (focusPanel) paintCameraDebug(root, diagnostics, cameraState());
}
function setStatus(next, text, active = false) {
  if (manuallyPaused && next !== 'error' && next !== 'off') {
    next = 'paused'; text = '수동 일시정지 · 재개 버튼을 눌러 주세요'; active = false;
  }
  const changed = tracking !== active || status !== next || message !== text;
  status = next; message = text; tracking = active; paint();
  if (changed) window.dispatchEvent(new Event('study:camera-changed'));
}
export function stopCamera(text = '얼굴 인식으로 학습 시작', error = false) {
  revision++;
  enabled = false; ready = false; inFlight = false; manuallyPaused = false;
  lastVideoTime = -1;
  clearTimeout(loop); clearInterval(watchdog); clearTimeout(loadingDeadline);
  worker?.terminate(); worker = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null;
  video.remove(); avatarPose = null;
  fallbackDetector?.close(); fallbackDetector = null;
  fallbackAttempted = fallbackLoading = false;
  focusTracker.reset(); diagnostics = null; reason = null;
  setStatus(error ? 'error' : 'off', text);
}
function recognitionError(detail = '') {
  ready = false; inFlight = false;
  worker?.terminate(); worker = null;
  clearTimeout(loop); clearInterval(watchdog); clearTimeout(loadingDeadline);
  // Preserve the avatar; never start crediting time without successful detection.
  avatarPose = null;
  focusTracker.reset(); diagnostics = null; reason = 'unknown';
  fallbackDetector?.close(); fallbackDetector = null;
  console.error('Study camera initialization failed:', detail);
  setStatus('error', '인식 엔진을 준비하지 못했습니다 · 종료 후 다시 시작해 주세요');
}
function acceptResult(data) {
  inFlight = false;
  const now = performance.now(); lastResult = now;
  if (manuallyPaused || !cameraVisible() || stream?.getVideoTracks()[0]?.muted) return;
  // Worker sends only the three points needed by the avatar, never the full face mesh.
  const points = data.landmarks;
  avatarPose = points ? facePose({ 1: points[0], 33: points[1], 263: points[2] }) : null;
  const stale = !Number.isFinite(data.time) || now - data.time > 3000;
  const decision = focusTracker.update(stale ? null : data.signals, now);
  diagnostics = focusTracker.getDebug();
  reason = decision.reason;
  setStatus(decision.status, decision.message, decision.tracking);
}
async function recoverRecognition(token, detail) {
  if (token !== revision || !enabled || fallbackLoading) return;
  if (fallbackAttempted) { recognitionError(detail); return; }
  fallbackAttempted = fallbackLoading = true; ready = false; inFlight = false; avatarPose = null;
  focusTracker.reset(); diagnostics = null; reason = 'unknown';
  worker?.terminate(); worker = null; clearTimeout(loadingDeadline);
  console.warn('Study camera worker fallback:', detail);
  setStatus('scanning', '호환 모드로 행동 인식을 준비하는 중…');
  loadingDeadline = setTimeout(() => { if (token === revision) recognitionError('Fallback timed out'); }, 60000);
  try {
    const detector = await loadCameraInference(document.createElement('canvas'));
    if (token !== revision || !enabled || status === 'error') { detector.close(); return; }
    fallbackDetector = detector; ready = true; lastResult = performance.now();
    clearTimeout(loadingDeadline);
    setStatus('scanning', '얼굴을 확인하는 중…');
  } catch (error) { if (token === revision) recognitionError(error.message); }
  finally { if (token === revision) fallbackLoading = false; }
}
async function frame(token) {
  if (!enabled || token !== revision) return;
  if (ready && !inFlight && cameraVisible() && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    inFlight = true;
    try {
      if (fallbackDetector) {
        const bitmap = await createImageBitmap(video);
        let result;
        try {
          if (token !== revision || !enabled) return;
          result = await fallbackDetector.detect(bitmap, performance.now());
        } finally { bitmap.close(); }
        if (token !== revision || !enabled) return;
        acceptResult(result);
      } else {
        const bitmap = await createImageBitmap(video);
        if (token !== revision) { bitmap.close(); return; }
        worker.postMessage({ type: 'frame', bitmap, time: performance.now() }, [bitmap]);
      }
    } catch (error) { inFlight = false; void recoverRecognition(token, error.message); }
  }
  if (!enabled || token !== revision) return;
  loop = setTimeout(() => frame(token), 200);
}
export async function startCamera() {
  if (enabled) return false;
  const token = ++revision;
  enabled = true;
  setStatus('opening', '카메라 권한을 확인하는 중…');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    const incoming = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } } });
    if (token !== revision) { incoming.getTracks().forEach(track => track.stop()); return false; }
    stream = incoming; video.srcObject = stream;
    document.body.append(video);
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => { if (token === revision) stopCamera('카메라 연결이 끊겼습니다. 다시 켜 주세요.', true); });
      track.addEventListener('mute', () => { if (token === revision) { focusTracker.reset(); diagnostics = null; setStatus('paused', '카메라 영상 중단 · 일시정지'); } });
    }
    await video.play();
    if (token !== revision) return false;
    setStatus('scanning', '카메라 연결됨 · AI 행동 인식 준비 중…');
    try { worker = new Worker(new URL('./camera-worker.js?v=20261023-1', import.meta.url)); }
    catch (error) {
      // A blocked/unsupported Worker must still try the complete inference pipeline.
      void recoverRecognition(token, error.message);
    }
    if (worker) {
      worker.onerror = error => { error.preventDefault(); void recoverRecognition(token, error.message); };
      worker.onmessage = ({ data }) => {
        if (token !== revision || fallbackAttempted) return;
        if (data.type === 'error') { void recoverRecognition(token, `${data.stage}: ${data.message}`); return; }
        if (data.type === 'ready') { ready = true; clearTimeout(loadingDeadline); lastResult = performance.now(); }
        if (data.type !== 'result') return;
        acceptResult(data);
      };
      worker.postMessage({ type: 'init' });
      loadingDeadline = setTimeout(() => { void recoverRecognition(token, 'Worker initialization timed out'); }, 60000);
    }
    watchdog = setInterval(() => {
      if (ready && performance.now() - lastResult > 3000) {
        focusTracker.reset(); diagnostics = null;
        setStatus('paused', '카메라 인식 응답 없음 · 일시정지');
        if (!fallbackAttempted) void recoverRecognition(token, 'Worker stopped responding');
      }
    }, 1000);
    void frame(token);
    return true;
  } catch (error) {
    if (token !== revision) return false;
    const messages = { NotAllowedError: '카메라 권한을 허용한 뒤 다시 켜 주세요.', NotFoundError: '연결된 웹캠을 찾지 못했습니다.', NotReadableError: '다른 앱의 카메라 사용을 종료하고 다시 켜 주세요.' };
    stopCamera(messages[error.name] || '카메라를 켜지 못했습니다. HTTPS와 브라우저 권한을 확인해 주세요.', true);
    return false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (!enabled) return;
  if(document.hidden && cameraVisible())return;
  lastVideoTime = -1;
  focusTracker.reset(); diagnostics = null;
  setStatus(document.hidden ? 'paused' : 'scanning', document.hidden ? '화면을 벗어났습니다 · 일시정지' : '얼굴을 다시 확인하는 중…');
});
window.addEventListener('study:navigated', () => {
  if (!document.querySelector('.app > main [data-camera]') && enabled) stopCamera();
  if (!document.querySelector('.app > main [data-camera]') && focusPanel) void closeCameraFocus();
  paint();
});
document.addEventListener('keydown', event => {
  if (!focusPanel) return;
  if (event.key === 'Tab') {
    const buttons = [...focusPanel.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault();
    buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  }
  if (event.key === 'Escape') focusPanel.querySelector('.cam-end').click();
});
window.addEventListener('pagehide', () => stopCamera());
paint();
