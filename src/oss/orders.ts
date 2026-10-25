import { createRequire } from 'node:module'
import type { DatabaseSync as Database } from 'node:sqlite'
import { mkdir, open, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PaymentOrder } from './commerce-types.js'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
const APPLICATION = 0x4f4d4f43
export interface OrderScope { server: string; userId: string }
export interface LocalOrder extends PaymentOrder { created_at: string; source: 'subscription' | 'lab-seats'; status: string; checked_at?: string }
export type OrderSummary = Omit<LocalOrder, 'pay_url'>
export function paymentOrder(value: any): PaymentOrder | undefined {
  if (!value || typeof value.order_no !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.order_no) || typeof value.amount_rmb !== 'number' || !Number.isFinite(value.amount_rmb) || value.amount_rmb < 0 || typeof value.currency !== 'string' || value.currency.length > 10 || !['wechat', 'alipay'].includes(value.provider) || typeof value.pay_url !== 'string' || value.pay_url.length > 8192 || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) return undefined
  // Copy only receipt fields; never persist arbitrary provider payloads, identity or tokens.
  return { order_no: value.order_no, amount_rmb: value.amount_rmb, currency: value.currency, provider: value.provider, pay_url: value.pay_url, expires_at: value.expires_at }
}
/** Local recovery receipts, isolated by cloud origin and account. Status always needs a fresh cloud check. */
export class OrderLedger {
  constructor(readonly path: string) {}
  get sensitiveFiles(): readonly string[] { return [this.path, `${this.path}-wal`, `${this.path}-shm`] }
  private async use<T>(action: (db: Database) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const file = await open(this.path, 'a', 0o600); await file.close(); await chmod(this.path, 0o600)
    const db = new DatabaseSync(this.path)
    try {
      db.exec('PRAGMA busy_timeout=5000;')
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version)
      const application = Number(db.prepare('PRAGMA application_id').get()!.application_id)
      if (version > 1 || (application !== 0 && application !== APPLICATION) || (version === 1 && application !== APPLICATION)) throw new Error('Unsupported local commerce ledger; preserve the database and use a compatible runtime')
      if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) throw new Error('Unrecognized database; refusing to adopt it as commerce receipts')
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      if (version === 0) db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS orders(server TEXT NOT NULL, user_id TEXT NOT NULL, order_no TEXT NOT NULL, created_at TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(server,user_id,order_no)); PRAGMA application_id=${APPLICATION}; PRAGMA user_version=1; COMMIT;`)
      return action(db)
    } finally { db.close() }
  }
  record(scope: OrderScope, order: PaymentOrder, source: LocalOrder['source']): Promise<void> {
    const receipt: LocalOrder = { ...order, created_at: new Date().toISOString(), source, status: 'unverified' }
    return this.use(db => { db.prepare('INSERT INTO orders(server,user_id,order_no,created_at,receipt_json) VALUES(?,?,?,?,?) ON CONFLICT(server,user_id,order_no) DO UPDATE SET receipt_json=excluded.receipt_json').run(scope.server, scope.userId, order.order_no, receipt.created_at, JSON.stringify(receipt)) })
  }
  get(scope: OrderScope, id: string): Promise<LocalOrder | undefined> {
    return this.use(db => { const row = db.prepare('SELECT receipt_json FROM orders WHERE server=? AND user_id=? AND order_no=?').get(scope.server, scope.userId, id); return row ? JSON.parse(String(row.receipt_json)) : undefined })
  }
  list(scope: OrderScope, before?: string): Promise<{ orders: OrderSummary[]; next?: string }> {
    if (before !== undefined && !/^\d+$/.test(before)) return Promise.reject(new Error('Invalid order cursor'))
    return this.use(db => {
      const rows = db.prepare('SELECT rowid,receipt_json FROM orders WHERE server=? AND user_id=? AND rowid<? ORDER BY rowid DESC LIMIT 51').all(scope.server, scope.userId, before || '9223372036854775807')
      return { orders: rows.slice(0, 50).map(row => { const { pay_url: _private, ...summary } = JSON.parse(String(row.receipt_json)) as LocalOrder; return summary }), ...(rows.length > 50 ? { next: String(rows[49].rowid) } : {}) }
    })
  }
  checked(scope: OrderScope, id: string, status: string): Promise<void> {
    return this.use(db => {
      const row = db.prepare('SELECT receipt_json FROM orders WHERE server=? AND user_id=? AND order_no=?').get(scope.server, scope.userId, id)
      if (!row) return
      const receipt: LocalOrder = { ...JSON.parse(String(row.receipt_json)), status, checked_at: new Date().toISOString() }
      db.prepare('UPDATE orders SET receipt_json=? WHERE server=? AND user_id=? AND order_no=?').run(JSON.stringify(receipt), scope.server, scope.userId, id)
    })
  }
}
