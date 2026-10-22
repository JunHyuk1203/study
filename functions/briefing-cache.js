import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { briefingPeriod } from './briefing-period.js';

export async function cachedBriefing({db, user, force = false, now = Date.now, generate}) {
  const period = briefingPeriod(now()), ref = db.doc(`users/${user}/integrations/briefing`);
  const generationId = randomUUID();
  const cached = await db.runTransaction(async tx => {
    const saved = (await tx.get(ref)).data();
    if (!force && saved?.periodId === period.id && saved.text?.trim()) return {text:saved.text,model:saved.model,cutoff:saved.cutoff||false,periodId:period.id,periodLabel:period.label,expiresAtMs:period.expiresAtMs,cached:true};
    if (saved?.generatingUntilMs > now()) throw new HttpsError('aborted','브리핑을 다른 화면에서 생성 중입니다. 잠시 후 다시 불러와 주세요.');
    tx.set(ref,{generationId,generatingUntilMs:now()+120000},{merge:true});
    return null;
  });
  if (cached) return cached;
  try {
    const result = await generate(period);
    if (!result.text?.trim()) throw new HttpsError('unavailable','브리핑을 만들지 못했습니다. 다시 시도해 주세요.');
    await ref.set({date:period.date,periodId:period.id,text:result.text,model:result.model||'gemini-3.8-flash',cutoff:result.cutoff||false,updatedAt:Timestamp.fromMillis(now()),generationId:null,generatingUntilMs:0});
    return {...result,periodId:period.id,periodLabel:period.label,expiresAtMs:period.expiresAtMs,cached:false};
  } catch (error) {
    await db.runTransaction(async tx => {
      if ((await tx.get(ref)).data()?.generationId === generationId) tx.set(ref,{generationId:null,generatingUntilMs:0},{merge:true});
    }).catch(() => {});
    throw error;
  }
}
