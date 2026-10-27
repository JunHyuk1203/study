import test from 'node:test';
import assert from 'node:assert/strict';
import { faceBounds, faceSearchRegion, restoreFaceCoordinates, sameFace } from '../camera-framing.js';
import { createCameraInference } from '../camera-inference.js';

const makeFace = (x = .7, y = .3, size = .06) => ({ faceLandmarks: [[
  { x, y, z: -.1 }, { x: x + size, y }, { x: x + size / 2, y: y + size },
]] });

test('face search is a padded pixel-square at every aspect ratio and stays in frame', () => {
  for (const [width, height] of [[1280,720],[720,1280],[640,480]]) {
    for (const x of [0,.5,.95]) {
      const box = faceBounds(makeFace(x));
      const region = faceSearchRegion(box, {}, width, height);
      assert.ok(Math.abs(region.width * width - region.height * height) < 1e-8);
      assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 && region.y + region.height <= 1);
      assert.ok(region.width >= box.width && region.height >= box.height);
    }
  }
});

test('neck and shoulders guide a search but invisible pose falls back to scanning', () => {
  const pose = { landmarks: [Array.from({ length: 33 }, () => ({ x: .8, y: .5, visibility: 1 }))] };
  pose.landmarks[0][0].y = .25;
  pose.landmarks[0][11].x = .65;
  pose.landmarks[0][12].x = .95;
  const region = faceSearchRegion(null, pose, 1280, 720);
  assert.ok(.8 >= region.x && .8 <= region.x + region.width);
  assert.ok(.25 >= region.y && .25 <= region.y + region.height);
  pose.landmarks[0][0].visibility = .1;
  assert.deepEqual(faceSearchRegion(null, pose, 1280, 720), faceSearchRegion(null, {}, 1280, 720));
  const regions = Array.from({ length: 6 }, (_, i) => faceSearchRegion(null, {}, 1280, 720, i));
  assert.ok(regions.some(r => r.x === 0));
  assert.ok(regions.some(r => r.x + r.width === 1));
});

test('crop landmarks, depth, and blendshapes return to original-frame coordinates', () => {
  const result = { ...makeFace(.2,.3,.1), faceBlendshapes: [{ categories: [] }] };
  const restored = restoreFaceCoordinates(result, { x: .5, y: .1, width: .2, height: .4 });
  assert.deepEqual(restored.faceLandmarks[0][0], { x: .54, y: .22, z: -.020000000000000004 });
  assert.equal(restored.faceBlendshapes, result.faceBlendshapes);
  assert.equal(sameFace(faceBounds(result), faceBounds(restored)), false);
  assert.equal(sameFace(faceBounds(result), faceBounds(result)), true);
});

test('fresh cropped detection feeds identity using the original image; missing faces and multiple people remain distinct', async () => {
  const previous = globalThis.OffscreenCanvas;
  const drawings = [];
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage: (...args) => drawings.push(args), getImageData: () => ({}) }; }
  };
  let full = { faceLandmarks: [] }, cropped = makeFace(.3,.3,.2), created = 0, disposed = 0;
  const checks = [], modes = [];let selectedIndex;
  const source = { width: 1280, height: 720 };
  let engine;
  try {
    engine = await createCameraInference({
      FilesetResolver: { forVisionTasks: async () => ({}) },
      FaceLandmarker: { createFromOptions: async (_, options) => {
        modes.push(options.runningMode); created++;
        return { detectForVideo: () => full, detect: () => cropped, close() { disposed++; } };
      } },
      PoseLandmarker: { createFromOptions: async () => ({ detectForVideo: () => ({ landmarks: [] }), close() {} }) },
      HandLandmarker: { createFromOptions: async () => ({ detectForVideo: () => ({ landmarks: [] }), close() {} }) },
    }, { load: async () => ({ detect: async () => [], dispose() {} }) },
    { setBackend: async () => true, ready: async () => {}, getBackend: () => 'cpu' }, undefined,
    { identityFactory: async () => ({ check: async (image, result) => { checks.push({ image, result }); return { status: 'checking',faceIndex:selectedIndex }; }, close() {} }) });
    const recovered = await engine.detect(source, 0);
    assert.equal(checks[0].image, source);
    assert.equal(checks[0].result.faceLandmarks.length, 1);
    assert.notEqual(checks[0].result.faceLandmarks[0][0].x, cropped.faceLandmarks[0][0].x);
    assert.deepEqual(modes, ['VIDEO','IMAGE']);
    assert.ok(recovered.modelMs.face >= 0);
    assert.ok(drawings.some(args => args.length === 9 && args[7] === 512));
    full = makeFace();
    const region = faceSearchRegion(faceBounds(full), {}, source.width, source.height);
    cropped = { faceLandmarks: [full.faceLandmarks[0].map(p => ({ ...p,
      x: (p.x - region.x) / region.width, y: (p.y - region.y) / region.height,
    }))], faceBlendshapes: [{ categories: [] }] };
    await engine.detect(source, 100);
    assert.equal(checks.at(-1).result.faceBlendshapes, cropped.faceBlendshapes);
    cropped = makeFace(.01,.01,.05);
    await engine.detect(source, 150);
    assert.equal(checks.at(-1).result, full, 'an unrelated cropped face must not replace the full-frame face');
    full = { faceLandmarks: [] };
    cropped = { faceLandmarks: [] };
    await engine.detect(source, 200);
    assert.equal(checks.at(-1).result.faceLandmarks.length, 0);
    full = { faceLandmarks: [...makeFace().faceLandmarks, ...makeFace(.2).faceLandmarks] };
    await engine.detect(source, 400);
    assert.equal(checks.at(-1).result.faceLandmarks.length, 2);
    const owner=Array.from({length:478},()=>({x:.7,y:.3}));
    owner[33]={x:.6,y:.3};owner[263]={x:.8,y:.3};
    full={faceLandmarks:[owner.map(point=>({...point,x:point.x-.4})),owner],faceBlendshapes:[{categories:[]},{categories:[{categoryName:'eyeBlinkLeft',score:.95},{categoryName:'eyeBlinkRight',score:.95}]}]};
    selectedIndex=1;
    const selected=await engine.detect(source,500);
    assert.equal(selected.signals.face,true);
    assert.equal(selected.signals.eyesClosed,true,'eye state must come from the owner, not the first person');
    assert.equal(selected.signals.activityVector[0],.7,'head position must come from the owner');
    selectedIndex=undefined;
    full = { faceLandmarks: [] };
    cropped = { faceLandmarks: [...makeFace(.1).faceLandmarks, ...makeFace(.6).faceLandmarks] };
    await engine.detect(source, 600);
    assert.equal(checks.at(-1).result.faceLandmarks.length, 2);
    assert.equal(created, 2);
  } finally {
    engine?.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    if (previous === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = previous;
  }
  assert.equal(disposed, 2);
});
