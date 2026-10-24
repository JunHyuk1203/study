// Regions use original-frame coordinates, including on wide/asymmetric cameras.
const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const visible = p => valid(p) && (p.visibility ?? 1) >= .5 && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function faceBounds(result) {
  const points = result.faceLandmarks?.[0]?.filter(valid);
  if (!points?.length) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function square(cx, cy, size, width, height) {
  const side = clamp(size, Math.min(64, width, height), Math.min(width, height));
  const w = side / width, h = side / height;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), width: w, height: h };
}

export function faceSearchRegion(bounds, poseResult, width, height, scan = 0) {
  if (bounds) return square(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2,
    Math.max(bounds.width * width, bounds.height * height) * 1.8, width, height);
  const pose = poseResult.landmarks?.[0];
  const nose = pose?.[0], left = pose?.[11], right = pose?.[12];
  if (visible(nose) && visible(left) && visible(right)) {
    // The shoulder midpoint approximates the neck base. Use its distance from
    // the nose to size the head search; shoulders never count as a real face.
    const neck = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    const headSize = Math.hypot((neck.x - nose.x) * width, (neck.y - nose.y) * height) * 2.2;
    const shoulderSize = Math.hypot((left.x - right.x) * width, (left.y - right.y) * height);
    return square(nose.x, nose.y, Math.max(headSize, shoulderSize * .8), width, height);
  }
  // Reacquire off-centre faces even when neither face nor pose was detected.
  const positions = [[.5,.4],[0,0],[1,0],[0,1],[1,1],[.5,1]];
  const [x, y] = positions[scan % positions.length];
  return square(x, y, Math.min(width, height) * .75, width, height);
}

export function restoreFaceCoordinates(result, region) {
  return { ...result, faceLandmarks: (result.faceLandmarks || []).map(face => face.map(p => ({ ...p,
    x: region.x + p.x * region.width, y: region.y + p.y * region.height,
    ...(Number.isFinite(p.z) ? { z: p.z * region.width } : {}),
  }))) };
}

export function sameFace(a, b) {
  if (!a || !b) return false;
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlap / Math.min(a.width * a.height, b.width * b.height) >= .4;
}
