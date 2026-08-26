import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StoredTask, TaskAdmission, TaskEventPage, TaskMutation, TaskStore, TaskService } from './service.js'
import type { TaskEvent, TaskSnapshot } from './types.js'

export interface SQLiteTaskStoreOptions { busyTimeoutMs?: number; pollIntervalMs?: number; now?: () => Date }
export interface TaskLease { taskId: string; owner: string; token: string; expiresAt: string }
const json = (v: unknown): string => JSON.stringify(v)
const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T
const rev = (t: TaskSnapshot): number => t.revision ?? 0

/** Durable multi-process SQLite store. Schema upgrades are transactional and monotonic. */
export class SQLiteTaskStore implements TaskStore, Disposable {
  readonly db: DatabaseSync
  private readonly poll: number
  private readonly now: () => Date
  constructor(readonly filename: string, options: SQLiteTaskStoreOptions = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.poll = options.pollIntervalMs ?? 25; this.now = options.now ?? (() => new Date())
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}`)
    this.migrate()
  }
  close(): void { this.db.close() }
  [Symbol.dispose](): void { this.close() }
  private migrate(): void {
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS task_schema(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,at TEXT NOT NULL,event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_events_task_seq ON task_events(task_id,seq);
      CREATE TABLE IF NOT EXISTS task_leases(task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,owner TEXT NOT NULL,token TEXT NOT NULL,expires_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO task_schema(version) VALUES(1); COMMIT;`)
  }
  private row(row: Record<string, unknown> | undefined): StoredTask | undefined { return row && { task: parse<TaskSnapshot>(row.snapshot), idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.fingerprint) } }
  async admit(record: StoredTask): Promise<TaskAdmission> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const old = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key=?').get(record.idempotencyKey) as Record<string,unknown>|undefined
      if (old) { this.db.exec('COMMIT'); const found=this.row(old)!; return {record:structuredClone(found),deduplicated:true,conflict:found.requestFingerprint!==record.requestFingerprint} }
      const t=record.task
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?)').run(t.taskId,record.idempotencyKey,record.requestFingerprint,json(t),rev(t),t.createdAt,t.updatedAt)
      this.insertEvents(t.taskId,[{type:'snapshot',snapshot:t}])
      this.db.exec('COMMIT'); return {record:structuredClone(record),deduplicated:false}
    } catch(e) { this.db.exec('ROLLBACK'); throw e }
  }
  async get(taskId:string):Promise<StoredTask|undefined>{ return structuredClone(this.row(this.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId) as Record<string,unknown>|undefined)) }
  async compareAndSet(taskId:string,expectedRevision:number,mutation:TaskMutation):Promise<StoredTask|undefined>{
    if(mutation.task.taskId!==taskId||rev(mutation.task)!==expectedRevision+1) throw new Error('mutation must preserve taskId and increment revision once')
    this.db.exec('BEGIN IMMEDIATE'); try {
      const result=this.db.prepare('UPDATE tasks SET snapshot=?,revision=?,updated_at=? WHERE task_id=? AND revision=?').run(json(mutation.task),rev(mutation.task),mutation.task.updatedAt,taskId,expectedRevision)
      if(Number(result.changes)===0){this.db.exec('ROLLBACK');return undefined}
      this.insertEvents(taskId,[{type:'snapshot',snapshot:mutation.task},...(mutation.events??[])])
      this.db.exec('COMMIT'); return (await this.get(taskId))!
    }catch(e){this.db.exec('ROLLBACK');throw e}
  }
  private insertEvents(taskId:string,events:Omit<TaskEvent,'taskId'|'at'|'cursor'>[]):void{const stmt=this.db.prepare('INSERT INTO task_events(task_id,at,event) VALUES(?,?,?)');for(const event of events)stmt.run(taskId,this.now().toISOString(),json(event))}
  async events(taskId:string,afterCursor?:string):Promise<TaskEventPage>{
    if(!(await this.get(taskId))) throw Object.assign(new Error(`Task ${taskId} was not found`),{code:'TASK_NOT_FOUND'})
    const n=afterCursor===undefined?0:Number(afterCursor);if(!Number.isSafeInteger(n)||n<0)throw Object.assign(new Error('cursor must be a non-negative integer'),{code:'TASK_CURSOR_INVALID'})
    const rows=this.db.prepare('SELECT seq,at,event FROM task_events WHERE task_id=? AND seq>? ORDER BY seq').all(taskId,n) as Record<string,unknown>[]
    const events=rows.map(r=>({...parse<object>(r.event),taskId,at:String(r.at),cursor:String(r.seq)} as TaskEvent));const last=this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM task_events WHERE task_id=?').get(taskId) as {n:number|bigint}
    return {events,cursor:String(last.n)}
  }
  async waitForChange(taskId:string,afterRevision:number,waitMs:number,signal?:AbortSignal):Promise<void>{const end=Date.now()+waitMs;while(true){if(signal?.aborted)throw signal.reason??new Error('aborted');const r=await this.get(taskId);if(!r)throw Object.assign(new Error(`Task ${taskId} was not found`),{code:'TASK_NOT_FOUND'});if(rev(r.task)>afterRevision||Date.now()>=end)return;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,Math.min(this.poll,end-Date.now()));signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true})})}}
  /** Atomically acquire/renew a fencing lease. A stale token can never release a replacement lease. */
  acquireLease(taskId:string,owner:string,ttlMs:number,token:string=crypto.randomUUID()):TaskLease|undefined{if(!Number.isSafeInteger(ttlMs)||ttlMs<1)throw new RangeError('ttlMs must be positive');const now=this.now().getTime(),expires=now+ttlMs;const out=this.db.prepare(`INSERT INTO task_leases VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET owner=excluded.owner,token=excluded.token,expires_at=excluded.expires_at WHERE task_leases.expires_at<=? OR (task_leases.owner=? AND task_leases.token=?)`).run(taskId,owner,token,expires,now,owner,token);return Number(out.changes)?{taskId,owner,token,expiresAt:new Date(expires).toISOString()}:undefined}
  releaseLease(taskId:string,owner:string,token:string):boolean{return Number(this.db.prepare('DELETE FROM task_leases WHERE task_id=? AND owner=? AND token=?').run(taskId,owner,token).changes)>0}
  /** Recover work abandoned by a crashed process. Running tasks are re-queued with one CAS revision. */
  async recover(limit=100):Promise<TaskSnapshot[]>{const rows=this.db.prepare(`SELECT t.task_id FROM tasks t LEFT JOIN task_leases l ON l.task_id=t.task_id WHERE json_extract(t.snapshot,'$.status')='running' AND (l.task_id IS NULL OR l.expires_at<=?) LIMIT ?`).all(this.now().getTime(),limit) as {task_id:string}[];const out:TaskSnapshot[]=[];for(const row of rows){const r=await this.get(row.task_id);if(!r||r.task.status!=='running')continue;const { error: _error, ...rest }=r.task;const t:TaskSnapshot={...rest,status:'queued',updatedAt:this.now().toISOString(),revision:rev(r.task)+1};const changed=await this.compareAndSet(row.task_id,rev(r.task),{task:t,events:[{type:'log',data:{recovered:true}}]});if(changed)out.push(changed.task)}return out}
  queued(limit=100):string[]{return (this.db.prepare(`SELECT task_id FROM tasks WHERE json_extract(snapshot,'$.status')='queued' ORDER BY created_at LIMIT ?`).all(limit) as {task_id:string}[]).map(x=>x.task_id)}
}

export interface DurableTaskWorkerOptions { owner?: string; leaseMs?: number; pollMs?: number; batchSize?: number }
/** Polling worker using fencing leases; safe to run in multiple processes. */
export class DurableTaskWorker {
  private controller: AbortController | undefined
  constructor(readonly store:SQLiteTaskStore,readonly service:TaskService,private readonly options:DurableTaskWorkerOptions={}){}
  start():void{if(this.controller)return;this.controller=new AbortController();void this.loop(this.controller.signal)}
  async stop():Promise<void>{this.controller?.abort();this.controller=undefined}
  async runOnce():Promise<number>{const owner=this.options.owner??`worker:${process.pid}`,leaseMs=this.options.leaseMs??30_000;let count=0;for(const taskId of this.store.queued(this.options.batchSize??100)){const lease=this.store.acquireLease(taskId,owner,leaseMs);if(!lease)continue;count++;const timer=setInterval(()=>this.store.acquireLease(taskId,owner,leaseMs,lease.token),Math.max(10,Math.floor(leaseMs/3)));try{await this.service.execute(taskId)}finally{clearInterval(timer);this.store.releaseLease(taskId,owner,lease.token)}}return count}
  private async loop(signal:AbortSignal):Promise<void>{await this.store.recover();while(!signal.aborted){const n=await this.runOnce();if(!n)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,this.options.pollMs??100);signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})})}}
}
