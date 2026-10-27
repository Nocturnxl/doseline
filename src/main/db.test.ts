import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { SqliteRepository, migrate } from './db'
import { parseBackup } from '../core/exporting'
import { med, taken } from '../core/testkit'

describe('SqliteRepository', () => {
  it('migrates a fresh database and is idempotent', () => {
    const db = new Database(':memory:')
    expect(migrate(db)).toBe(3)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(migrate(db)).toBe(3)
    db.close()
  })

  it('upgrades a version-1 database and keeps existing medications working', async () => {
    const file = path.join(os.tmpdir(), `doseline-mig-${process.pid}-${Date.now()}.db`)
    const v1 = new Database(file)
    v1.exec(`CREATE TABLE medications (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE dose_logs (id TEXT PRIMARY KEY, medication_id TEXT NOT NULL, kind TEXT NOT NULL, taken_at TEXT NOT NULL, scheduled_for TEXT, inventory_delta REAL NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
      CREATE TABLE snoozes (id TEXT PRIMARY KEY, medication_id TEXT NOT NULL, due_at TEXT NOT NULL, fire_at TEXT NOT NULL);
      CREATE TABLE sync_jobs (target TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, last_error TEXT);
      CREATE TABLE event_links (target TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL, dose_key TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    v1.pragma('user_version = 1')
    const old = med({ type: 'interval', everyHours: 8 }, { id: 'old' })
    v1.prepare('INSERT INTO medications (id, name, data, updated_at) VALUES (?, ?, ?, ?)').run(old.id, old.name, JSON.stringify(old), old.updatedAt)
    v1.close()

    const r = new SqliteRepository(file)
    expect(r.db.pragma('user_version', { simple: true })).toBe(3)
    const loaded = (await r.getMedication('old'))!
    expect(loaded.rxcui ?? null).toBeNull()
    expect(loaded.catalogName ?? null).toBeNull()
    await r.saveMedication({ ...loaded, rxcui: '1163524', catalogName: 'Metoprolol XR (Oral Pill)', catalogSource: 'rxterms', strengthRxcui: '866427' })
    expect(r.db.prepare('SELECT rxcui, catalog_name, catalog_source FROM medications WHERE id = ?').get('old')).toEqual({ rxcui: '1163524', catalog_name: 'Metoprolol XR (Oral Pill)', catalog_source: 'rxterms' })
    expect((await r.getMedication('old'))!.strengthRxcui).toBe('866427')
    r.close()
    fs.rmSync(file, { force: true })
    for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true })
  })

  it('stores escalation records and escalation history on logs', async () => {
    const r = new SqliteRepository(':memory:')
    const m = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3, 4, 5, 6, 7] }, { id: 'm1' })
    await r.saveMedication(m)
    const rec = { medicationId: 'm1', dueAt: '2026-05-04T12:00:00.000Z', escalatedAt: '2026-05-04T12:30:00.000Z', lastFiredAt: '2026-05-04T12:45:00.000Z', repeats: 1, snoozedUntil: null, resolution: null }
    await r.saveEscalation(rec)
    await r.saveEscalation({ ...rec, repeats: 2, snoozedUntil: '2026-05-04T13:30:00.000Z' })
    expect(await r.listEscalations()).toEqual([{ ...rec, repeats: 2, snoozedUntil: '2026-05-04T13:30:00.000Z' }])
    const l = taken('m1', '2026-05-04T13:00:00Z', '2026-05-04T12:00:00Z', { escalatedAt: rec.escalatedAt, escalationRepeats: 2 })
    await r.saveLog(l)
    await r.saveLog(taken('m1', '2026-05-05T12:00:00Z', '2026-05-05T12:00:00Z'))
    const logs = await r.listLogs()
    expect(logs[0]).toMatchObject({ escalatedAt: rec.escalatedAt, escalationRepeats: 2 })
    expect(logs[1]!.escalatedAt).toBeUndefined()
    await r.pruneEscalations(new Date('2026-05-04T12:00:00.001Z'))
    expect(await r.listEscalations()).toEqual([])
    await r.saveEscalation(rec)
    await r.deleteMedication('m1')
    expect(await r.listEscalations()).toEqual([])
    r.close()
  })

  it('fills nested escalation defaults for settings saved by older versions', async () => {
    const r = new SqliteRepository(':memory:')
    r.db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({ graceMinutes: 30, escalation: { repeatMinutes: 20 } }))
    const s = await r.getSettings()
    expect(s.graceMinutes).toBe(30)
    expect(s.escalation).toEqual({ thresholdMinutes: 30, repeatMinutes: 20, sound: 'urgent', quietHours: { enabled: false, start: '22:00', end: '07:00' } })
    r.close()
  })

  it('stores drug cache entries', async () => {
    const r = new SqliteRepository(':memory:')
    expect(await r.getCached('k')).toBeNull()
    await r.setCached('k', '[1]', '2026-10-27T00:00:00.000Z')
    await r.setCached('k', '[2]', '2026-10-28T00:00:00.000Z')
    expect(await r.getCached('k')).toEqual({ value: '[2]', fetchedAt: '2026-10-28T00:00:00.000Z' })
    r.close()
  })

  it('round-trips medications, logs, settings, snoozes, jobs and kv', async () => {
    const r = new SqliteRepository(':memory:')
    const m = med({ type: 'fixed', times: ['08:00'], days: [1, 2, 3] }, { id: 'm1', inventory: { count: 5, unitsPerDose: 1, refillThreshold: 2, refillEvent: true } })
    await r.saveMedication(m)
    expect(await r.getMedication('m1')).toEqual(m)
    const l = taken('m1', '2026-05-04T12:00:00-04:00', '2026-05-04T12:00:00Z', { note: 'ok', inventoryDelta: 1 })
    await r.saveLog(l)
    const logs = await r.listLogs({ medicationId: 'm1', from: new Date('2026-05-04T00:00:00Z') })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.takenAt).toBe('2026-05-04T16:00:00.000Z') // normalised to UTC
    expect(logs[0]!.note).toBe('ok')
    expect(await r.listLogs({ to: new Date('2026-05-04T00:00:00Z') })).toHaveLength(0)

    const s = await r.getSettings()
    await r.saveSettings({ ...s, graceMinutes: 30, sound: { ...s.sound, volume: 0.2 } })
    expect((await r.getSettings()).graceMinutes).toBe(30)
    expect((await r.getSettings()).sound.volume).toBe(0.2)

    await r.saveSnooze({ id: 's', medicationId: 'm1', dueAt: '2026-05-04T12:00:00Z', fireAt: '2026-05-04T12:10:00Z' })
    expect(await r.listSnoozes()).toHaveLength(1)
    await r.saveSyncJob({ target: 'm1', attempts: 2, nextAttemptAt: '2026-05-04T12:00:00Z', lastError: 'x' })
    expect((await r.listSyncJobs())[0]!.attempts).toBe(2)
    await r.saveEventLink({ target: 'm1', calendarId: 'c', eventId: 'e', doseKey: 'k', updatedAt: 'now' })
    expect((await r.getEventLink('m1'))!.eventId).toBe('e')
    await r.setKV('google.calendarId', 'cal1')
    expect(await r.getKV('google.calendarId')).toBe('cal1')

    await r.deleteMedication('m1')
    expect(await r.listLogs()).toHaveLength(0)
    expect(await r.listSnoozes()).toHaveLength(0)
    r.close()
  })

  it('exports and imports a full backup', async () => {
    const a = new SqliteRepository(':memory:')
    await a.saveMedication(med({ type: 'interval', everyHours: 8 }, { id: 'm1' }))
    await a.saveLog(taken('m1', '2026-05-04T12:00:00Z'))
    await a.setKV('google.calendarId', 'cal1')
    await a.setKV('alarms.fired', '["x"]')
    const backup = parseBackup(JSON.parse(JSON.stringify(await a.exportAll())))
    expect(backup.kv).toEqual({ 'google.calendarId': 'cal1' })

    const b = new SqliteRepository(':memory:')
    await b.saveMedication(med({ type: 'interval', everyHours: 4 }, { id: 'old' }))
    backup.medications[0] = { ...backup.medications[0]!, rxcui: '1163524', catalogName: 'Metoprolol XR (Oral Pill)', catalogSource: 'rxterms' }
    await b.importAll(backup)
    expect((await b.listMedications()).map((m) => m.id)).toEqual(['m1'])
    expect((await b.getMedication('m1'))!.catalogName).toBe('Metoprolol XR (Oral Pill)')
    expect(b.db.prepare('SELECT catalog_name FROM medications WHERE id = ?').get('m1')).toEqual({ catalog_name: 'Metoprolol XR (Oral Pill)' })
    expect(await b.listLogs()).toHaveLength(1)
    expect(await b.getKV('google.calendarId')).toBe('cal1')
    a.close()
    b.close()
  })
})
