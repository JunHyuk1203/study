import { FieldValue, Timestamp } from './platform-store.js';
import { HttpsError } from './platform-http.js';

// Called inside the study completion transaction; never accept a client duration.
export function creditFocusTime(transaction, db, uid, sessionId, seconds, now) {
  if (seconds <= 0) return;
  transaction.set(db.doc(`users/${uid}/stats/focusTime`), {
    balanceSeconds: FieldValue.increment(seconds),
    earnedSeconds: FieldValue.increment(seconds), updatedAt: now,
  }, { merge: true });
  transaction.create(db.doc(`users/${uid}/focusTimeTransactions/earn_${sessionId}`), {
    type: 'earn', sessionId, seconds, createdAt: now,
  });
}

// Server-only purchase primitive. Future purchase handlers must resolve itemId and
// costSeconds from their own catalog and grant the item in this same transaction.
// Reuse purchaseId when retrying the same purchase; never expose arbitrary prices.
export async function spendFocusTime(db, { uid, purchaseId, itemId, costSeconds }, grant = () => {}) {
  if (typeof uid !== 'string' || !uid || uid.includes('/') ||
      typeof purchaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(purchaseId) ||
      typeof itemId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(itemId) ||
      !Number.isSafeInteger(costSeconds) || costSeconds <= 0) {
    throw new HttpsError('invalid-argument', 'Focus Time 사용 요청이 올바르지 않습니다.');
  }
  const walletRef = db.doc(`users/${uid}/stats/focusTime`);
  const receiptRef = db.doc(`users/${uid}/focusTimeTransactions/spend_${purchaseId}`);
  return db.runTransaction(async transaction => {
    const [wallet, receipt] = await transaction.getAll(walletRef, receiptRef);
    const balance = wallet.data()?.balanceSeconds ?? 0;
    if (receipt.exists) {
      if (receipt.data().itemId !== itemId || receipt.data().seconds !== costSeconds) {
        throw new HttpsError('already-exists', '이미 다른 구매에 사용한 요청 ID입니다.');
      }
      return { balanceSeconds: balance, alreadySpent: true };
    }
    if (balance < costSeconds) throw new HttpsError('failed-precondition', 'Focus Time이 부족합니다.');
    const now = Timestamp.now();
    // Grant must only perform transactional database operations (no external effects).
    await grant(transaction);
    transaction.set(walletRef, {
      balanceSeconds: balance - costSeconds,
      spentSeconds: FieldValue.increment(costSeconds), updatedAt: now,
    }, { merge: true });
    transaction.create(receiptRef, { type: 'spend', itemId, seconds: costSeconds, createdAt: now });
    return { balanceSeconds: balance - costSeconds, alreadySpent: false };
  });
}
