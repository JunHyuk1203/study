const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const presentations = new WeakMap();
const checkVertex = [152, 179];
const checkLeft = Math.hypot(19, 19), checkRight = Math.hypot(37, 40);
const checkTurn = checkLeft / (checkLeft + checkRight);

export function checkSegment(index, count = 8) {
  const start = index / count, end = (index + 1) / count;
  const positions = Array.from({ length: 17 }, (_, step) => start + (end - start) * step / 16);
  if (start < checkTurn && end > checkTurn) positions.push(checkTurn);
  return positions.sort((a, b) => a - b).map(position => {
    const progress = position <= checkTurn ? position / checkTurn : (position - checkTurn) / (1 - checkTurn);
    const from = position <= checkTurn ? [133, 160] : checkVertex;
    const to = position <= checkTurn ? checkVertex : [189, 139];
    return from.map((value, axis) => value + (to[axis] - value) * progress);
  });
}

function captureFace(mount) {
  const order = [0, 7, 1, 6, 2, 5, 3, 4];
  return [...mount.querySelectorAll('.recognition-piece')].map((piece, index) => {
    const target = checkSegment(order[index]);
    const length = piece.getTotalLength();
    const matrix = piece.ownerSVGElement.getScreenCTM()?.inverse().multiply(piece.getScreenCTM());
    const source = target.map((_, step) => {
      const point = piece.getPointAtLength(length * step / (target.length - 1));
      const transformed = matrix ? point.matrixTransform(matrix) : point;
      return [transformed.x, transformed.y];
    });
    return { piece, source, target };
  });
}
function mergeFace(parts) {
  const path = points => `path("${points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`).join('')}")`;
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 560;
  // Each original stroke becomes its own connected section of the check. No overlay check.
  return parts.map(({ piece, source, target }) => piece.animate([
    { d: path(source), transform: 'none', strokeWidth: 4 },
    { d: path(target), transform: 'none', strokeWidth: 5.5 },
  ], { duration, easing: 'cubic-bezier(.65,0,.12,1)', fill: 'forwards' }));
}

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
        <path class="recognition-piece recognition-bracket bracket-tl" d="M127 115h-9q-7 0-7 7v9"/>
        <path class="recognition-piece recognition-bracket bracket-tr" d="M193 115h9q7 0 7 7v9"/>
        <path class="recognition-piece recognition-bracket bracket-bl" d="M111 189v9q0 7 7 7h9"/>
        <path class="recognition-piece recognition-bracket bracket-br" d="M209 189v9q0 7-7 7h-9"/>
        <path class="recognition-piece recognition-eye eye-left" d="M140 143v10"/>
        <path class="recognition-piece recognition-eye eye-right" d="M180 143v10"/>
        <path class="recognition-piece recognition-nose" d="M161 142v21q0 4-4 4h-4"/>
        <path class="recognition-piece recognition-mouth" d="M139 179Q160 197 181 179"/>
      </g>
    </svg>`;
  }
  const desired = status === 'tracking' && pose ? 'recognized' : status === 'off' ? 'idle' : status === 'error' ? 'error' : 'searching';
  let presentation = presentations.get(mount);
  if (!presentation || presentation.desired !== desired) {
    const parts = desired === 'recognized' ? captureFace(mount) : [];
    clearTimeout(presentation?.timer);
    for (const animation of presentation?.animations || []) animation.cancel();
    presentation = { desired, timer: null, animations: [] };
    presentations.set(mount, presentation);
    mount.dataset.avatarPhase = desired === 'recognized' ? 'success' : desired;
    if (parts.length) presentation.animations = mergeFace(parts);
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
