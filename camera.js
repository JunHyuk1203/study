// Camera frames stay in this document/worker; only a boolean state reaches the timer.
const video = document.createElement('video');
video.autoplay = true;
video.muted = true;
video.playsInline = true;
video.setAttribute('aria-label', '웹캠 실시간 미리보기');
let stream, worker, loop, watchdog, loadingDeadline;
let enabled = false, tracking = false, status = 'off', message = '얼굴 인식으로 학습 시작';
let ready = false, inFlight = false, lastResult = 0, presenceSince = null, absentSince = null, revision = 0;
let focusPanel, focusOrigin, previousFocus;
let morphFrame;
export const cameraController = crypto.randomUUID();
export function cameraState() { return { enabled, tracking, status }; }
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
    if (face) face.animate([{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }, { opacity: 0, transform: 'translate(-50%,-50%) scale(1.4)' }], { duration: 230, fill: 'forwards' });
    for (const corner of frame.querySelectorAll('.cam-corner')) corner.animate([{ width: '19px', height: '19px' }, { width: '40px', height: '40px' }], { duration: 900, fill: 'forwards', easing: 'cubic-bezier(.22,.68,.1,1)' });
    frame.animate([geometry(focusOrigin), geometry(target)], { duration: 900, fill: 'forwards', easing: 'cubic-bezier(.22,.68,.1,1)' }).finished.then(() => {
      panel.classList.remove('is-morphing');
      frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished.then(() => frame.remove()).catch(() => frame.remove());
      if (morphFrame === frame) morphFrame = null;
    }).catch(() => { panel.classList.remove('is-morphing'); frame.remove(); });
  }
  focusPanel.querySelector('.cam-end').focus();
}
export async function closeCameraFocus() {
  const panel = focusPanel;
  if (!panel) return;
  focusPanel = null;
  morphFrame?.remove(); morphFrame = null;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const inset = `inset(${focusOrigin.top}px ${Math.max(0, innerWidth - focusOrigin.right)}px ${Math.max(0, innerHeight - focusOrigin.bottom)}px ${focusOrigin.left}px round 20px)`;
    await panel.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }, { clipPath: inset, opacity: .6 }], { duration: 350, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
  }
  panel.remove(); document.querySelector('.app').inert = false;
  document.documentElement.classList.remove('camera-focus-open');
  previousFocus?.focus(); paint();
}

function paint() {
  const root = focusPanel?.querySelector('[data-camera]') || document.querySelector('.app > main [data-camera]');
  if (!root) return;
  root.dataset.state = status;
  root.classList.toggle('is-open', enabled);
  const mount = root.querySelector('[data-camera-video]');
  if (enabled && video.parentNode !== mount) mount.append(video);
  root.querySelector('[data-camera-status]').textContent = message;
  const toggle = root.querySelector('[data-camera-toggle]');
  toggle?.setAttribute('aria-label', enabled ? '스터디캠 실행 중' : '얼굴 인식으로 학습 시작');
  root.querySelector('[data-camera-resolution]').textContent = enabled && video.videoWidth ? `LIVE · ${video.videoWidth} × ${video.videoHeight}` : '';
}
function setStatus(next, text, active = false) {
  const changed = tracking !== active || status !== next;
  status = next; message = text; tracking = active; paint();
  if (changed) window.dispatchEvent(new Event('study:camera-changed'));
}
export function stopCamera(text = '얼굴 인식으로 학습 시작', error = false) {
  revision++;
  enabled = false; ready = false; inFlight = false;
  clearTimeout(loop); clearInterval(watchdog); clearTimeout(loadingDeadline);
  worker?.terminate(); worker = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null;
  presenceSince = absentSince = null;
  setStatus(error ? 'error' : 'off', text);
}
function recognitionError() {
  ready = false; inFlight = false;
  worker?.terminate(); worker = null;
  clearTimeout(loop); clearInterval(watchdog); clearTimeout(loadingDeadline);
  // Keep the live preview visible even when model loading or inference fails.
  setStatus('error', '얼굴 인식 연결 실패 · 시간 일시정지 · 종료 후 다시 시작해 주세요');
}
async function frame(token) {
  if (!enabled || token !== revision) return;
  if (ready && !inFlight && !document.hidden && video.readyState >= 2) {
    inFlight = true;
    try {
      const bitmap = await createImageBitmap(video);
      if (token !== revision) { bitmap.close(); return; }
      worker.postMessage({ type: 'frame', bitmap, time: performance.now() }, [bitmap]);
    } catch { stopCamera('카메라 영상을 읽지 못했습니다. 다시 켜 주세요.', true); return; }
  }
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
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => { if (token === revision) stopCamera('카메라 연결이 끊겼습니다. 다시 켜 주세요.', true); });
      track.addEventListener('mute', () => { if (token === revision) { presenceSince = absentSince = null; setStatus('paused', '카메라 영상 중단 · 일시정지'); } });
    }
    await video.play();
    if (token !== revision) return false;
    setStatus('scanning', '카메라 연결됨 · 얼굴 인식 준비 중…');
    worker = new Worker(new URL('./camera-worker.js?v=20261021-10', import.meta.url));
    worker.onerror = () => { if (token === revision) recognitionError(); };
    worker.onmessage = ({ data }) => {
      if (token !== revision) return;
      if (data.type === 'error') { console.error('Study camera detector:', data.stage, data.message); recognitionError(); return; }
      if (data.type === 'ready') { ready = true; clearTimeout(loadingDeadline); lastResult = performance.now(); }
      if (data.type !== 'result') return;
      inFlight = false;
      const now = performance.now(); lastResult = now;
      if (document.hidden || stream?.getVideoTracks()[0]?.muted) return;
      if (data.present) {
        absentSince = null;
        presenceSince ??= now;
        if (now - presenceSince >= 2000) setStatus('tracking', '얼굴 인식됨 · 자리 비움 감지 중', true);
        else if (!tracking) setStatus('scanning', '얼굴 확인 중 · 잠시 그대로 있어 주세요');
        else setStatus('tracking', '얼굴 인식됨 · 자리 비움 감지 중', true);
      } else {
        presenceSince = null; absentSince ??= now;
        if (!tracking || now - absentSince >= 5000) setStatus('paused', '얼굴을 찾지 못했습니다 · 일시정지');
        else setStatus('warning', '얼굴을 찾는 중 · 5초 후 일시정지', true);
      }
    };
    worker.postMessage({ type: 'init' });
    loadingDeadline = setTimeout(() => { if (token === revision) recognitionError(); }, 60000);
    watchdog = setInterval(() => {
      if (ready && performance.now() - lastResult > 3000) {
        presenceSince = absentSince = null;
        setStatus('paused', '카메라 인식 응답 없음 · 일시정지');
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
  presenceSince = absentSince = null;
  setStatus(document.hidden ? 'paused' : 'scanning', document.hidden ? '화면을 벗어났습니다 · 일시정지' : '얼굴을 다시 확인하는 중…');
});
window.addEventListener('study:navigated', () => {
  if (!document.querySelector('.app > main [data-camera]') && enabled) stopCamera();
  if (!document.querySelector('.app > main [data-camera]') && focusPanel) void closeCameraFocus();
  paint();
});
document.addEventListener('keydown', event => {
  if (!focusPanel) return;
  if (event.key === 'Tab') { event.preventDefault(); focusPanel.querySelector('.cam-end').focus(); }
  if (event.key === 'Escape') focusPanel.querySelector('.cam-end').click();
});
window.addEventListener('pagehide', () => stopCamera());
paint();
