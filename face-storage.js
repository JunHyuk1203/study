export const FACE_DB='study-face-encrypted-v2';
export const faceRecordKey=(uid,installationId,profileId)=>`${uid}:${installationId}:${profileId}`;
// Request success is insufficient: quota/commit errors arrive on the transaction.
export async function faceStore(store,mode,key,value) {
  return new Promise((resolve,reject)=>{
    const opening=indexedDB.open(FACE_DB,1);
    opening.onupgradeneeded=()=>{for(const name of ['profiles','keys','settings'])opening.result.createObjectStore(name);};
    opening.onerror=()=>reject(new Error('브라우저 보안 저장소를 열지 못했습니다.'));
    opening.onblocked=()=>reject(new Error('다른 탭을 닫고 다시 시도해 주세요.'));
    opening.onsuccess=()=>{
      const db=opening.result,tx=db.transaction(store,mode),table=tx.objectStore(store);
      const operation=mode==='readonly'?table.get(key):value===undefined?table.delete(key):table.put(value,key);
      tx.oncomplete=()=>{db.close();resolve(operation.result);};
      tx.onabort=tx.onerror=()=>{db.close();reject(new Error('암호화 정보 저장에 실패했습니다. 저장 공간과 사이트 권한을 확인해 주세요.'));};
    };
  });
}
export async function createBrowserFaceKeys() {
  const wrappingKey=await crypto.subtle.generateKey({name:'AES-KW',length:256},false,['wrapKey','unwrapKey']);
  const signing=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  return {wrappingKey,signingKey:signing.privateKey,publicKey:await crypto.subtle.exportKey('jwk',signing.publicKey)};
}
export async function deleteLocalFaceAccount(uid,installationId){
  return new Promise((resolve,reject)=>{
    const opening=indexedDB.open(FACE_DB,1);
    opening.onerror=()=>reject(new Error('브라우저 얼굴 정보를 삭제하지 못했습니다.'));
    opening.onblocked=()=>reject(new Error('다른 학습 탭을 닫고 다시 시도해 주세요.'));
    opening.onsuccess=()=>{
      const db=opening.result,tx=db.transaction(['profiles','keys','settings'],'readwrite'),prefix=`${uid}:${installationId}`;
      for(const store of ['profiles','keys','settings']){const cursor=tx.objectStore(store).openCursor();cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;if(row.key===prefix||String(row.key).startsWith(prefix+':'))row.delete();row.continue();};}
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=tx.onerror=()=>{db.close();reject(new Error('브라우저 얼굴 정보를 삭제하지 못했습니다. 사이트 데이터 설정을 확인해 주세요.'));};
    };
  });
}
export async function clearLegacyFaceProfile() {
  // Clear the unbound plaintext record; never promote it into an account profile.
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('study-camera-identity',2);
    request.onupgradeneeded=()=>{if(request.result.objectStoreNames.contains('profiles'))request.transaction.objectStore('profiles').clear();};
    request.onblocked=()=>reject(new Error('이전 버전의 학습 탭을 모두 닫아 주세요.'));
    request.onerror=()=>reject(new Error('이전 얼굴 정보 정리에 실패했습니다.'));
    request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('profiles')){db.close();resolve();return;}const tx=db.transaction('profiles','readwrite');tx.objectStore('profiles').clear();tx.oncomplete=()=>{db.close();resolve();};tx.onabort=tx.onerror=()=>{db.close();reject(new Error('이전 얼굴 정보 정리에 실패했습니다.'));};};
  });
}
