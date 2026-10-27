import Database from 'better-sqlite3'
import type { BackupData, EventLink, LogFilter, Repository, SyncJob } from '../core/ports'
import type { DrugCacheStore } from '../core/drugs'
import type { DoseLog, EscalationRecord, Medication, Settings, Snooze } from '../core/types'
import { mergeSettings } from '../core/settings'

/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Never edit a shipped migration; append a new one.
 */
const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE medications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE dose_logs (
    id TEXT PRIMARY KEY,
    medication_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('taken', 'skipped')),
    taken_at TEXT NOT NULL,
    scheduled_for TEXT,
    inventory_delta REAL NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_logs_med_time ON dose_logs (medication_id, taken_at);
  CREATE INDEX idx_logs_time ON dose_logs (taken_at);
  CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
  CREATE TABLE snoozes (id TEXT PRIMARY KEY, medication_id TEXT NOT NULL, due_at TEXT NOT NULL, fire_at TEXT NOT NULL);
  CREATE TABLE sync_jobs (target TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, last_error TEXT);
  CREATE TABLE event_links (target TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL, dose_key TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  /* 2 */ `
  ALTER TABLE medications ADD COLUMN rxcui TEXT;
  ALTER TABLE medications ADD COLUMN catalog_name TEXT;
  ALTER TABLE medications ADD COLUMN catalog_source TEXT;
  CREATE TABLE drug_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL);
  `,
  /* 3 */ `
  ALTER TABLE dose_logs ADD COLUMN escalated_at TEXT;
  ALTER TABLE dose_logs ADD COLUMN escalation_repeats INTEGER;
  CREATE TABLE escalations (
    medication_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    escalated_at TEXT NOT NULL,
    last_fired_at TEXT NOT NULL,
    repeats INTEGER NOT NULL DEFAULT 0,
    snoozed_until TEXT,
    resolution TEXT,
    PRIMARY KEY (medication_id, due_at)
  );
  `,
]

export function migrate(db: Database.Database): number {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return MIGRATIONS.length
}

const norm = (iso: string) => new Date(iso).toISOString()

function logParams(l: DoseLog) {
  return {
    id: l.id,
    med: l.medicationId,
    kind: l.kind,
    taken: norm(l.takenAt),
    sched: l.scheduledFor ? norm(l.scheduledFor) : null,
    delta: l.inventoryDelta ?? 0,
    note: l.note ?? null,
    created: l.createdAt,
    esc: l.escalatedAt ?? null,
    reps: l.escalatedAt ? (l.escalationRepeats ?? 0) : null,
  }
}

/** Catalog link fields are mirrored into columns (the JSON blob stays the source of truth). */
function medParams(m: Medication) {
  return { id: m.id, name: m.name, data: JSON.stringify(m), updated: m.updatedAt, rxcui: m.rxcui ?? null, catalog: m.catalogName ?? null, source: m.catalogSource ?? null }
}

interface LogRow {
  id: string
  medication_id: string
  kind: 'taken' | 'skipped'
  taken_at: string
  scheduled_for: string | null
  inventory_delta: number
  note: string | null
  created_at: string
  escalated_at: string | null
  escalation_repeats: number | null
}

function rowToLog(r: LogRow): DoseLog {
  return {
    id: r.id,
    medicationId: r.medication_id,
    kind: r.kind,
    takenAt: r.taken_at,
    scheduledFor: r.scheduled_for,
    inventoryDelta: r.inventory_delta,
    note: r.note ?? undefined,
    ...(r.escalated_at ? { escalatedAt: r.escalated_at, escalationRepeats: r.escalation_repeats ?? 0 } : {}),
    createdAt: r.created_at,
  }
}

/** SQLite-backed Repository (better-sqlite3 is synchronous; the interface is async for portability). */
export class SqliteRepository implements Repository, DrugCacheStore {
  readonly db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 3000')
    migrate(this.db)
  }

  close(): void {
    this.db.close()
  }

  async listMedications(): Promise<Medication[]> {
    const rows = this.db.prepare('SELECT data FROM medications ORDER BY name COLLATE NOCASE').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Medication)
  }

  async getMedication(id: string): Promise<Medication | null> {
    const r = this.db.prepare('SELECT data FROM medications WHERE id = ?').get(id) as { data: string } | undefined
    return r ? (JSON.parse(r.data) as Medication) : null
  }

  async saveMedication(m: Medication): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO medications (id, name, data, updated_at, rxcui, catalog_name, catalog_source) VALUES (@id, @name, @data, @updated, @rxcui, @catalog, @source)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at,
           rxcui = excluded.rxcui, catalog_name = excluded.catalog_name, catalog_source = excluded.catalog_source`,
      )
      .run(medParams(m))
  }

  async deleteMedication(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM dose_logs WHERE medication_id = ?').run(id)
      this.db.prepare('DELETE FROM snoozes WHERE medication_id = ?').run(id)
      this.db.prepare('DELETE FROM escalations WHERE medication_id = ?').run(id)
      this.db.prepare('DELETE FROM medications WHERE id = ?').run(id)
    })()
  }

  async listLogs(f: LogFilter = {}): Promise<DoseLog[]> {
    const where: string[] = []
    const params: Record<string, string> = {}
    if (f.medicationId) {
      where.push('medication_id = @med')
      params.med = f.medicationId
    }
    if (f.from) {
      where.push('taken_at >= @from')
      params.from = f.from.toISOString()
    }
    if (f.to) {
      where.push('taken_at < @to')
      params.to = f.to.toISOString()
    }
    const sql = `SELECT * FROM dose_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY taken_at`
    return (this.db.prepare(sql).all(params) as LogRow[]).map(rowToLog)
  }

  async getLog(id: string): Promise<DoseLog | null> {
    const r = this.db.prepare('SELECT * FROM dose_logs WHERE id = ?').get(id) as LogRow | undefined
    return r ? rowToLog(r) : null
  }

  async saveLog(l: DoseLog): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO dose_logs (id, medication_id, kind, taken_at, scheduled_for, inventory_delta, note, created_at, escalated_at, escalation_repeats)
         VALUES (@id, @med, @kind, @taken, @sched, @delta, @note, @created, @esc, @reps)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, taken_at = excluded.taken_at, scheduled_for = excluded.scheduled_for,
           inventory_delta = excluded.inventory_delta, note = excluded.note, escalated_at = excluded.escalated_at, escalation_repeats = excluded.escalation_repeats`,
      )
      .run(logParams(l))
  }

  async deleteLog(id: string): Promise<void> {
    this.db.prepare('DELETE FROM dose_logs WHERE id = ?').run(id)
  }

  async getSettings(): Promise<Settings> {
    const r = this.db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined
    return mergeSettings(r ? (JSON.parse(r.data) as Partial<Settings>) : {})
  }

  async saveSettings(s: Settings): Promise<void> {
    this.db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(s))
  }

  async listSnoozes(): Promise<Snooze[]> {
    const rows = this.db.prepare('SELECT * FROM snoozes').all() as { id: string; medication_id: string; due_at: string; fire_at: string }[]
    return rows.map((r) => ({ id: r.id, medicationId: r.medication_id, dueAt: r.due_at, fireAt: r.fire_at }))
  }

  async saveSnooze(s: Snooze): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO snoozes (id, medication_id, due_at, fire_at) VALUES (?, ?, ?, ?)').run(s.id, s.medicationId, norm(s.dueAt), norm(s.fireAt))
  }

  async deleteSnooze(id: string): Promise<void> {
    this.db.prepare('DELETE FROM snoozes WHERE id = ?').run(id)
  }

  async listSyncJobs(): Promise<SyncJob[]> {
    const rows = this.db.prepare('SELECT * FROM sync_jobs ORDER BY next_attempt_at').all() as { target: string; attempts: number; next_attempt_at: string; last_error: string | null }[]
    return rows.map((r) => ({ target: r.target, attempts: r.attempts, nextAttemptAt: r.next_attempt_at, lastError: r.last_error }))
  }

  async saveSyncJob(j: SyncJob): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO sync_jobs (target, attempts, next_attempt_at, last_error) VALUES (?, ?, ?, ?)').run(j.target, j.attempts, j.nextAttemptAt, j.lastError ?? null)
  }

  async deleteSyncJob(target: string): Promise<void> {
    this.db.prepare('DELETE FROM sync_jobs WHERE target = ?').run(target)
  }

  async getEventLink(target: string): Promise<EventLink | null> {
    const r = this.db.prepare('SELECT * FROM event_links WHERE target = ?').get(target) as { target: string; calendar_id: string; event_id: string; dose_key: string; updated_at: string } | undefined
    return r ? { target: r.target, calendarId: r.calendar_id, eventId: r.event_id, doseKey: r.dose_key, updatedAt: r.updated_at } : null
  }

  async saveEventLink(l: EventLink): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO event_links (target, calendar_id, event_id, dose_key, updated_at) VALUES (?, ?, ?, ?, ?)').run(l.target, l.calendarId, l.eventId, l.doseKey, l.updatedAt)
  }

  async deleteEventLink(target: string): Promise<void> {
    this.db.prepare('DELETE FROM event_links WHERE target = ?').run(target)
  }

  async clearEventLinks(): Promise<void> {
    this.db.prepare('DELETE FROM event_links').run()
  }

  async getKV(key: string): Promise<string | null> {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return r ? r.value : null
  }

  async setKV(key: string, value: string | null): Promise<void> {
    if (value == null) this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
    else this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value)
  }

  async listEscalations(): Promise<EscalationRecord[]> {
    const rows = this.db.prepare('SELECT * FROM escalations').all() as { medication_id: string; due_at: string; escalated_at: string; last_fired_at: string; repeats: number; snoozed_until: string | null; resolution: EscalationRecord['resolution'] }[]
    return rows.map((r) => ({ medicationId: r.medication_id, dueAt: r.due_at, escalatedAt: r.escalated_at, lastFiredAt: r.last_fired_at, repeats: r.repeats, snoozedUntil: r.snoozed_until, resolution: r.resolution }))
  }

  async saveEscalation(r: EscalationRecord): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO escalations (medication_id, due_at, escalated_at, last_fired_at, repeats, snoozed_until, resolution) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.medicationId, norm(r.dueAt), r.escalatedAt, r.lastFiredAt, r.repeats, r.snoozedUntil, r.resolution)
  }

  async pruneEscalations(before: Date): Promise<void> {
    this.db.prepare('DELETE FROM escalations WHERE due_at < ?').run(before.toISOString())
  }

  async getCached(key: string): Promise<{ value: string; fetchedAt: string } | null> {
    const r = this.db.prepare('SELECT value, fetched_at FROM drug_cache WHERE key = ?').get(key) as { value: string; fetched_at: string } | undefined
    return r ? { value: r.value, fetchedAt: r.fetched_at } : null
  }

  async setCached(key: string, value: string, fetchedAt: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO drug_cache (key, value, fetched_at) VALUES (?, ?, ?)').run(key, value, fetchedAt)
  }

  async exportAll(): Promise<BackupData> {
    const kvRows = this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'google.%'").all() as { key: string; value: string }[]
    return {
      app: 'doseline',
      version: 1,
      exportedAt: new Date().toISOString(),
      medications: await this.listMedications(),
      logs: await this.listLogs(),
      settings: await this.getSettings(),
      kv: Object.fromEntries(kvRows.map((r) => [r.key, r.value])),
    }
  }

  async importAll(d: BackupData): Promise<void> {
    const tx = this.db.transaction(() => {
      for (const t of ['medications', 'dose_logs', 'snoozes', 'sync_jobs', 'event_links', 'escalations']) this.db.prepare(`DELETE FROM ${t}`).run()
      this.db.prepare("DELETE FROM kv WHERE key LIKE 'alarms.%'").run()
      const insMed = this.db.prepare('INSERT INTO medications (id, name, data, updated_at, rxcui, catalog_name, catalog_source) VALUES (@id, @name, @data, @updated, @rxcui, @catalog, @source)')
      for (const m of d.medications) insMed.run(medParams({ ...m, updatedAt: m.updatedAt ?? new Date().toISOString() }))
      const insLog = this.db.prepare(
        'INSERT INTO dose_logs (id, medication_id, kind, taken_at, scheduled_for, inventory_delta, note, created_at, escalated_at, escalation_repeats) VALUES (@id, @med, @kind, @taken, @sched, @delta, @note, @created, @esc, @reps)',
      )
      for (const l of d.logs) insLog.run(logParams({ ...l, createdAt: l.createdAt ?? l.takenAt }))
      this.db.prepare('INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(d.settings))
      for (const [k, v] of Object.entries(d.kv ?? {})) if (k.startsWith('google.')) this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(k, v)
    })
    tx()
  }
}
