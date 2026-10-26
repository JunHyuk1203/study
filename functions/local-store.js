import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Timestamp} from 'firebase-admin/firestore';

const transform = Symbol('study-transform');
export const LocalFieldValue = Object.freeze({
  increment: amount => ({[transform]:'increment', amount}),
  delete: () => ({[transform]:'delete'}),
});
const removed = Symbol('removed');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const invalidKey = key => ['__proto__','prototype','constructor'].includes(key);
function fail(code, message) { throw Object.assign(new Error(message), {code}); }

export function encode(value) {
  if (value instanceof Timestamp) return {$studyTimestamp:[value.seconds,value.nanoseconds]};
  if (value instanceof Date) return encode(Timestamp.fromDate(value));
  if (Array.isArray(value)) return value.map(encode);
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key,item]) => {
    if (invalidKey(key)) fail('invalid-argument','잘못된 데이터 필드입니다.');
    return [key,encode(item)];
  }));
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) fail('invalid-argument','저장할 데이터가 올바르지 않습니다.');
  return value;
}
export function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (plain(value)) {
    if (Object.keys(value).length === 1 && Array.isArray(value.$studyTimestamp)) return new Timestamp(...value.$studyTimestamp);
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,decode(item)]));
  }
  return value;
}
const clone = value => value === undefined ? undefined : decode(encode(value));
function applyValue(previous, value, merge) {
  if (value?.[transform] === 'delete') return removed;
  if (value?.[transform] === 'increment') {
    if (!Number.isFinite(value.amount)) fail('invalid-argument','증가 값이 올바르지 않습니다.');
    return (typeof previous === 'number' ? previous : 0) + value.amount;
  }
  if (!plain(value)) return clone(value);
  const result = merge && plain(previous) ? clone(previous) : {};
  for (const [key,item] of Object.entries(value)) {
    if (invalidKey(key)) fail('invalid-argument','잘못된 데이터 필드입니다.');
    const next = applyValue(previous?.[key],item,merge);
    if (next === removed) delete result[key]; else result[key] = next;
  }
  return result;
}
function updateValue(previous, values) {
  const result = clone(previous);
  for (const [field,value] of Object.entries(values)) {
    const segments = field.split('.');
    if (segments.some(key=>!key || invalidKey(key))) fail('invalid-argument','잘못된 데이터 필드입니다.');
    let parent = result;
    for (const key of segments.slice(0,-1)) {
      if (!plain(parent[key])) parent[key] = {};
      parent = parent[key];
    }
    const key = segments.at(-1), next = applyValue(parent[key],value,false);
    if (next === removed) delete parent[key]; else parent[key] = next;
  }
  return result;
}
function pathParts(path, document) {
  if (typeof path !== 'string' || path.length > 1500 || path.includes('\0')) fail('invalid-argument','데이터 경로가 올바르지 않습니다.');
  const parts = path.split('/');
  if (parts.some(p=>!p || p==='.' || p==='..') || parts.length % 2 !== (document ? 0 : 1)) fail('invalid-argument','데이터 경로가 올바르지 않습니다.');
  return parts;
}
class Snapshot {
  constructor(ref, data, version) { this.ref=ref;this.id=ref.id;this.exists=data!==undefined;this.value=data;this.version=version; }
  data() { return clone(this.value); }
  get(field) { return field.split('.').reduce((v,k)=>v?.[k],this.data()); }
}
class Reference {
  constructor(store,path) { this.store=store;this.path=path;this.id=pathParts(path,true).at(-1); }
  collection(name) { return new Query(this.store,`${this.path}/${name}`); }
  get() { return this.store.read(this); }
  set(value,options) { return this.store.runTransaction(tx=>{tx.set(this,value,options);}); }
  create(value) { return this.store.runTransaction(tx=>{tx.create(this,value);}); }
  update(value) { return this.store.runTransaction(tx=>{tx.update(this,value);}); }
  delete() { return this.store.runTransaction(tx=>{tx.delete(this);}); }
}
class Query {
  constructor(store,path,config={}) { pathParts(path,false);this.store=store;this.path=path;this.config=config; }
  copy(changes) { return new Query(this.store,this.path,{...this.config,...changes}); }
  doc(id=randomBytes(15).toString('hex')) { return new Reference(this.store,`${this.path}/${id}`); }
  where(field,op,value) { return this.copy({filters:[...(this.config.filters||[]),{field,op,value}]}); }
  orderBy(field,direction='asc') { if(!['asc','desc'].includes(direction))fail('invalid-argument','잘못된 정렬입니다.');return this.copy({orders:[...(this.config.orders||[]),{field,direction}]}); }
  limit(count) { if(!Number.isInteger(count)||count<1||count>10001)fail('invalid-argument','잘못된 조회 수입니다.');return this.copy({limit:count}); }
  startAt(...values) { return this.copy({start:{values,inclusive:true}}); }
  endAt(...values) { return this.copy({end:{values,inclusive:true}}); }
  startAfter(...values) { return this.copy({start:{values,inclusive:false}}); }
  get() { return this.store.read(this); }
}
function querySql(query) {
  const params=[query.path],conditions=['collection_path=$1'];
  const bind=value=>{params.push(value);return `$${params.length}`;};
  const expr=field=>field==='__name__'?'to_jsonb(document_id)':`(body #> ${bind(field.split('.'))}::text[])`;
  const json=value=>`${bind(JSON.stringify(encode(value)))}::jsonb`;
  for(const {field,op,value} of query.config.filters||[]) {
    const left=expr(field), operator={'==':'=','!=':'<>','<':'<','<=':'<=','>':'>','>=':'>='}[op];
    if(!operator)fail('invalid-argument','지원하지 않는 조회입니다.');
    conditions.push(`${left} ${operator} ${json(value)}`);
  }
  const orders=[...(query.config.orders||[])];
  if(!orders.some(o=>o.field==='__name__'))orders.push({field:'__name__',direction:orders.at(-1)?.direction||'asc'});
  const ordered=orders.map(order=>({...order,sql:expr(order.field)}));
  for(const order of ordered) if(order.field!=='__name__')conditions.push(`${order.sql} IS NOT NULL`);
  for(const [kind,bound] of [['start',query.config.start],['end',query.config.end]])if(bound) {
    let values=bound.values;
    if(values[0] instanceof Snapshot) {
      const snapshot=values[0];values=orders.map(o=>o.field==='__name__'?snapshot.id:snapshot.get(o.field));
    }
    if(values.length>orders.length)fail('invalid-argument','잘못된 조회 경계입니다.');
    const equal=[],choices=[];
    values.forEach((value,i)=>{
      const col=ordered[i],right=json(value),greater=(kind==='start')===(col.direction==='asc');
      const operator=(greater?'>':'<')+(bound.inclusive&&i===values.length-1?'=':'');
      choices.push(`(${[...equal,`${col.sql} ${operator} ${right}`].join(' AND ')})`);
      equal.push(`${col.sql} = ${right}`);
    });
    if(choices.length)conditions.push(`(${choices.join(' OR ')})`);
  }
  return {text:`SELECT path,body,version FROM study_documents WHERE ${conditions.join(' AND ')} ORDER BY ${ordered.map(o=>`${o.sql} ${o.direction}`).join(',')} LIMIT ${bind(query.config.limit||10001)}`,values:params};
}
class Transaction {
  constructor(store,client) { this.store=store;this.client=client;this.operations=[];this.reads=Promise.resolve(); }
  get(ref) { const result=this.reads.then(()=>this.store.read(ref,this.client));this.reads=result.catch(()=>{});return result; }
  async getAll(...refs) { const result=[];for(const ref of refs)result.push(await this.get(ref));return result; }
  set(ref,data,options={}) { this.operations.push({kind:'set',ref,data,merge:options.merge===true});return this; }
  update(ref,data) { this.operations.push({kind:'update',ref,data});return this; }
  create(ref,data) { this.operations.push({kind:'create',ref,data});return this; }
  delete(ref) { this.operations.push({kind:'delete',ref});return this; }
  async commit() {
    await this.reads;
    const changed=new Set();
    for(const op of this.operations) {
      const {ref}=op;changed.add(ref.path);
      if(op.kind==='delete'){await this.client.query('DELETE FROM study_documents WHERE path=$1',[ref.path]);continue;}
      const previous=(await this.store.read(ref,this.client)).data();
      if(op.kind==='create'&&previous!==undefined)fail('already-exists','이미 존재하는 기록입니다.');
      if(op.kind==='update'&&previous===undefined)fail('not-found','기록을 찾을 수 없습니다.');
      const next=op.kind==='update'?updateValue(previous,op.data):applyValue(previous,op.data,op.merge);
      const parts=ref.path.split('/');
      await this.client.query(`INSERT INTO study_documents(path,collection_path,collection_id,document_id,body)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(path) DO UPDATE SET body=EXCLUDED.body,version=study_documents.version+1,updated_at=clock_timestamp()`,
        [ref.path,parts.slice(0,-1).join('/'),parts.at(-2),ref.id,JSON.stringify(encode(next))]);
    }
    return changed;
  }
}
export class DocumentStore extends EventEmitter {
  constructor(connectionString) {
    super();if(!connectionString)throw new Error('DATABASE_URL is required');
    this.pool=new pg.Pool({connectionString,max:12,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
    this.pool.on('error',()=>this.emit('store-error'));
    this.ready=this.initialize();this.ready.catch(()=>{});
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS study_documents (
      path text PRIMARY KEY, collection_path text NOT NULL, collection_id text NOT NULL,
      document_id text NOT NULL, body jsonb NOT NULL, version bigint NOT NULL DEFAULT 1,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE INDEX IF NOT EXISTS study_document_collection ON study_documents(collection_path,document_id);
      CREATE INDEX IF NOT EXISTS study_document_group ON study_documents(collection_id);
      CREATE INDEX IF NOT EXISTS study_document_expiry ON study_documents(collection_path,((body->>'expiresAtMs')::bigint)) WHERE collection_id='wordStudyLeases';`);
  }
  doc(path) { return new Reference(this,path); }
  collection(path) { return new Query(this,path); }
  getAll(...refs) { return Promise.all(refs.map(ref=>this.read(ref))); }
  async read(ref,connection=this.pool) {
    await this.ready;
    if(ref instanceof Reference) {
      const result=await connection.query('SELECT body,version FROM study_documents WHERE path=$1',[ref.path]);
      const row=result.rows[0];return new Snapshot(ref,row?decode(row.body):undefined,row?.version);
    }
    const result=await connection.query(querySql(ref));
    const docs=result.rows.map(row=>new Snapshot(this.doc(row.path),decode(row.body),row.version));
    return {docs,size:docs.length,empty:!docs.length,forEach:fn=>docs.forEach(fn)};
  }
  async runTransaction(callback) {
    await this.ready;const client=await this.pool.connect();let tx;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='20s'");
      // All writes enter this lock, including standalone set/update/delete. Reads
      // occur after acquiring it, so cross-document decisions cannot lose updates.
      await client.query('SELECT pg_advisory_xact_lock(19042026)');
      tx=new Transaction(this,client);const result=await callback(tx),changed=await tx.commit();
      await client.query('COMMIT');
      if(changed.size)queueMicrotask(()=>this.emit('change',changed));
      return result;
    } catch(error) {await tx?.reads;await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally {client.release();}
  }
  async close() {await this.pool.end();}
}
