import {getFirestore as cloudFirestore, Timestamp, FieldValue as CloudFieldValue} from 'firebase-admin/firestore';
export {Timestamp};
const local = process.env.STUDY_BACKEND === 'selfhost';
const adapter = local ? await import('./local-store.js') : null;
export const FieldValue = local ? adapter.LocalFieldValue : CloudFieldValue;
let database;
export function getFirestore(...args) {
  return local ? (database ??= new adapter.DocumentStore(process.env.DATABASE_URL)) : cloudFirestore(...args);
}
