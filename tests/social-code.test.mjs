import test from 'node:test';
import assert from 'node:assert/strict';
import {createSocialCode,normalizeSocialCode,isShortSocialCode} from '../functions/social-code.js';

test('new codes have six readable characters and accept lowercase, spaces and hyphens',()=>{
  for(let i=0;i<100;i++) {
    const code=createSocialCode();
    assert.match(code,/^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(normalizeSocialCode(` ${code.slice(0,3).toLowerCase()} - ${code.slice(3).toLowerCase()} `),code);
    assert.ok(isShortSocialCode(code));
  }
});

test('long legacy codes, ambiguous characters and malformed codes are rejected',()=>{
  for(const code of ['ABCDEF0123','ABCDEF012345','OI0123','ABC','ABCDEFZ','ABC/DE','가나다라마바'])assert.equal(isShortSocialCode(code),false);
});
