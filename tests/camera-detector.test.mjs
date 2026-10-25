import test from 'node:test';
import assert from 'node:assert/strict';
import {yoloLetterbox,yoloChannels,decodeYoloObjects,createPhoneObjectDetector} from '../camera-detector.js';
test('detector letterboxes portrait and landscape without stretching objects',()=>{
  const wide=yoloLetterbox(1280,720),tall=yoloLetterbox(720,1280);
  assert.equal(wide.top,140);assert.equal(wide.left,0);assert.equal(wide.scaleX,wide.scaleY);
  assert.equal(tall.left,140);assert.equal(tall.top,0);assert.equal(tall.scaleX,tall.scaleY);
  assert.throws(()=>yoloLetterbox(0,720),/dimensions/);
});
test('YOLO receives normalized RGB planar data, not BGR or interleaved RGBA',()=>{
  assert.deepEqual(Array.from(yoloChannels(new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,0]),2)),[1,0,0,1,0,1,0,1,0,0,1,1]);
});
test('COCO contiguous phone class 67 and padded coordinates decode into the original image',()=>{
  const t=yoloLetterbox(1280,720);
  const result=decodeYoloObjects(new Float32Array([100,190,200,290,.8,67,10,140,20,150,.9,0,20,160,30,180,.6,73]),[1,3,6],t);
  assert.equal(result.length,2);assert.equal(result[0].class,'cell phone');assert.deepEqual(result[0].bbox,[200,100,200,200]);
  assert.equal(result[1].class,'book');
});
test('bad output layouts, padding-only boxes, invalid scores and other classes cannot become phones',()=>{
  const t=yoloLetterbox(1280,720);
  const rows=new Float32Array([0,0,50,50,.9,67,0,140,20,150,NaN,67,0,140,20,150,2,67,0,140,20,150,.9,76]);
  assert.deepEqual(decodeYoloObjects(rows,[1,4,6],t),[]);
  assert.throws(()=>decodeYoloObjects(rows,[1,6,4],t),/layout/);
});
test('missing or changed model weights fail closed before constructing a model session',async()=>{
  let sessions=0;const ort={InferenceSession:{create(){sessions++;}}};
  await assert.rejects(createPhoneObjectDetector(ort,{fetchModel:async()=>({ok:false,status:404})}),/download failed/);
  await assert.rejects(createPhoneObjectDetector(ort,{fetchModel:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(4)})}),/checksum mismatch/);
  assert.equal(sessions,0);
});
