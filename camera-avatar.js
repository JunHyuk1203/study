const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const presentations = new WeakMap();
const checkVertex = [152, 179];
const checkLeft = Math.hypot(19, 19), checkRight = Math.hypot(37, 40);
const checkTurn = checkLeft / (checkLeft + checkRight);

export function checkSegment(index, count = 8, reach = 1) {
  const visible = clamp(reach, 0, 1);
  const start = index / count * visible, end = (index + 1) / count * visible;
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
    const original = piece.getAttribute('d');
    let source = target;
    try {
      const length = piece.getTotalLength();
      const screen = piece.ownerSVGElement.getScreenCTM(), local = piece.getScreenCTM();
      const matrix = screen && local ? screen.inverse().multiply(local) : null;
      source = target.map((_, step) => {
        const point = piece.getPointAtLength(length * step / (target.length - 1));
        return matrix ? [matrix.a * point.x + matrix.c * point.y + matrix.e, matrix.b * point.x + matrix.d * point.y + matrix.f] : [point.x, point.y];
      });
    } catch { /* A hidden/detached SVG can lack a screen matrix; still show its assembled check. */ }
    const line = source.map((_, step) => {
      const offset = (order[index] + step / (source.length - 1)) / 8 * 18 / Math.SQRT2;
      return [133 + offset, 160 + offset];
    });
    return { piece, source, line, slot: order[index], original };
  });
}
export function mergePath(source, target, progress) {
  return target.map(([x, y], index) => {
    const start = source[index];
    return `${index ? 'L' : 'M'}${(start[0] + (x - start[0]) * progress).toFixed(3)} ${(start[1] + (y - start[1]) * progress).toFixed(3)}`;
  }).join('');
}
function mergeFace(parts, completed) {
  const duration = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 560;
  let frameId, deadline, done = false, started;
  const draw = progress => {
    const gathering = progress < .48;
    const phase = gathering ? progress / .48 : (progress - .48) / .52;
    const eased = gathering ? phase < .5 ? 4 * phase ** 3 : 1 - (-2 * phase + 2) ** 3 / 2 : 1 - (1 - phase) ** 2;
    for (const { piece, source, line, slot } of parts) {
      piece.style.transform = 'none';
      // Gather into ONE short straight stroke, then extend its tip down to the
      // elbow and up the right arm. The check is drawn in order, not assembled.
      const traced = gathering ? null : checkSegment(slot, 8, 18 / (checkLeft + checkRight) + (1 - 18 / (checkLeft + checkRight)) * eased);
      piece.setAttribute('d', gathering ? mergePath(source, line, eased) : mergePath(traced, traced, 1));
      piece.setAttribute('stroke-width', String(4 + progress * 1.5));
    }
  };
  const finish = () => {
    if (done) return;
    done = true; clearTimeout(deadline);
    if (frameId != null) cancelAnimationFrame(frameId);
    draw(1); completed();
  };
  const tick = now => {
    if (done) return;
    started ??= now;
    const progress = Math.min(1, (now - started) / duration);
    draw(progress);
    if (progress >= 1) finish();
    else frameId = requestAnimationFrame(tick);
  };
  draw(0);
  // Direct SVG attributes work even in browsers that do not animate CSS `d`.
  if (parts.length) {
    frameId = requestAnimationFrame(tick);
    deadline = setTimeout(finish, duration + 250);
  } else deadline = setTimeout(finish, duration);
  return () => {
    done = true; clearTimeout(deadline);
    if (frameId != null) cancelAnimationFrame(frameId);
    for (const { piece, original } of parts) {
      piece.setAttribute('d', original); piece.removeAttribute('stroke-width'); piece.style.removeProperty('transform');
    }
  };
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
  let presentation = presentations.get(mount);
  const finishing = active && status === 'scanning' && ['success', 'check'].includes(mount.dataset.avatarPhase) && presentation?.desired === 'recognized';
  const desired = finishing || status === 'tracking' && pose ? 'recognized' : status === 'off' ? 'idle' : status === 'error' ? 'error' : 'searching';
  if (!presentation || presentation.desired !== desired) {
    const parts = desired === 'recognized' ? captureFace(mount) : [];
    clearTimeout(presentation?.timer);
    presentation?.cancelMerge?.();
    presentation = { desired, timer: null, cancelMerge: null };
    presentations.set(mount, presentation);
    mount.dataset.avatarPhase = desired === 'recognized' ? 'success' : desired;
    if (desired === 'recognized') presentation.cancelMerge = mergeFace(parts, () => {
      if (presentations.get(mount) !== presentation) return;
      mount.dataset.avatarPhase = 'check';
      presentation.timer = setTimeout(() => {
        if (presentations.get(mount) !== presentation) return;
        mount.dataset.avatarPhase = 'avatar';
        mount.querySelector('.cam-avatar').setAttribute('aria-hidden', 'false');
        mount.querySelector('.cam-recognition').setAttribute('aria-hidden', 'true');
        presentation.timer = null;
      }, 700);
    });
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
