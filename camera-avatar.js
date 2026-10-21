const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const presentations = new WeakMap();

export function facePose(landmarks) {
  const nose = landmarks?.[1], left = landmarks?.[33], right = landmarks?.[263];
  if (![nose?.x, nose?.y, left?.x, left?.y, right?.x, right?.y].every(Number.isFinite)) return null;
  return {
    x: clamp((.5 - nose.x) * 70, -24, 24),
    y: clamp((nose.y - .5) * 45, -15, 15),
    roll: clamp(-Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI, -28, 28),
  };
}

export function paintAvatar(mount, pose, active, status = 'tracking') {
  if (!mount.querySelector('.cam-avatar')) {
    // Static artwork only. Camera pixels and facial landmarks never enter the DOM.
    mount.innerHTML = `<svg class="cam-avatar" viewBox="0 0 320 320" role="img" aria-label="스터디캠 졸라맨 아바타">
      <ellipse class="avatar-shadow" cx="160" cy="271" rx="65" ry="9"/>
      <g class="avatar-person" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M160 138v70m0-51-48 36m48-36 48 36m-48 15-32 55m32-55 32 55"/>
        <g class="avatar-head"><circle cx="160" cy="101" r="36"/><path class="avatar-eyes" d="M148 96v4m24-4v4"/><path d="M150 113q10 8 20 0"/></g>
      </g><path class="avatar-ground" d="M75 277h170"/>
    </svg><svg class="cam-recognition" viewBox="0 0 320 320" role="img" aria-label="얼굴을 찾는 중">
      <circle class="recognition-ring-track" cx="160" cy="160" r="82"/>
      <circle class="recognition-spinner" cx="160" cy="160" r="82"/>
      <g class="recognition-face" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M127 115h-9a7 7 0 0 0-7 7v9m82-16h9a7 7 0 0 1 7 7v9m-98 58v9a7 7 0 0 0 7 7h9m82-16v9a7 7 0 0 1-7 7h-9"/>
        <g class="recognition-features"><path d="M140 143v10m40-10v10m-19-11v25h-8m-14 12q21 18 42 0"/></g>
      </g>
      <path class="recognition-check" d="m133 160 19 19 37-40"/>
    </svg>`;
  }
  const desired = status === 'tracking' && pose ? 'recognized' : status === 'off' ? 'idle' : status === 'error' ? 'error' : 'searching';
  let presentation = presentations.get(mount);
  if (!presentation || presentation.desired !== desired) {
    clearTimeout(presentation?.timer);
    presentation = { desired, timer: null };
    presentations.set(mount, presentation);
    mount.dataset.avatarPhase = desired === 'recognized' ? 'success' : desired;
    if (desired === 'recognized') presentation.timer = setTimeout(() => {
      if (presentations.get(mount) !== presentation) return;
      mount.dataset.avatarPhase = 'avatar';
      mount.querySelector('.cam-avatar').setAttribute('aria-hidden', 'false');
      mount.querySelector('.cam-recognition').setAttribute('aria-hidden', 'true');
      presentation.timer = null;
    }, 900);
  }
  mount.querySelector('.cam-recognition').setAttribute('aria-label', desired === 'recognized' ? '얼굴 인식 완료' : desired === 'error' ? '얼굴 인식 연결 대기' : '얼굴을 찾는 중');
  const avatar = mount.querySelector('.cam-avatar');
  avatar.setAttribute('aria-hidden', String(mount.dataset.avatarPhase !== 'avatar'));
  mount.querySelector('.cam-recognition').setAttribute('aria-hidden', String(['avatar', 'idle'].includes(mount.dataset.avatarPhase)));
  avatar.classList.toggle('is-tracked', Boolean(pose));
  avatar.classList.toggle('is-active', active);
  avatar.style.setProperty('--avatar-x', `${pose?.x || 0}px`);
  avatar.style.setProperty('--avatar-y', `${pose?.y || 0}px`);
  avatar.style.setProperty('--avatar-roll', `${pose?.roll || 0}deg`);
}
