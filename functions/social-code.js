import {randomBytes} from 'node:crypto';

// 32 symbols: omit 0/O and 1/I so codes are easy to read aloud and type.
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const createSocialCode=()=>Array.from(randomBytes(6),byte=>alphabet[byte%alphabet.length]).join('');
export const normalizeSocialCode=value=>String(value||'').replace(/[\s-]/g,'').toUpperCase();
export const isShortSocialCode=code=>/^[A-HJ-NP-Z2-9]{6}$/.test(code);
