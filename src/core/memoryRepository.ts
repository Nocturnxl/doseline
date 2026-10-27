import type { DoseLog, EscalationRecord, Medication, Settings, Snooze } from './types'
import { DEFAULT_SETTINGS } from './types'
import type { BackupData, EventLink, LogFilter, Repository, SyncJob } from './ports'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** In-memory Repository. Used by tests, and a starting point for a web (IndexedDB) adapter. */
export class MemoryRepository implements Repository {
  meds = new Map<string, Medication>()
  logs = new Map<string, DoseLog>()
  settings: Settings = clone(DEFAULT_SETTINGS)
  snoozes = new Map<string, Snooze>()
  jobs = new Map<string, SyncJob>()
  links = new Map<string, EventLink>()
  kv = new Map<string, string>()
  escalations = new Map<string, EscalationRecord>()

  async listMedications() {
    return [...this.meds.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name))
  }
  async getMedication(id: string) {
    const m = this.meds.get(id)
    return m ? clone(m) : null
  }
  async saveMedication(med: Medication) {
    this.meds.set(med.id, clone(med))
  }
  async deleteMedication(id: string) {
    this.meds.delete(id)
    for (const [k, l] of this.logs) if (l.medicationId === id) this.logs.delete(k)
    for (const [k, r] of this.escalations) if (r.medicationId === id) this.escalations.delete(k)
  }
  async listLogs(f: LogFilter = {}) {
    return [...this.logs.values()]
      .filter((l) => (!f.medicationId || l.medicationId === f.medicationId) && (!f.from || new Date(l.takenAt) >= f.from) && (!f.to || new Date(l.takenAt) < f.to))
      .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
      .map(clone)
  }
  async getLog(id: string) {
    const l = this.logs.get(id)
    return l ? clone(l) : null
  }
  async saveLog(log: DoseLog) {
    this.logs.set(log.id, clone(log))
  }
  async deleteLog(id: string) {
    this.logs.delete(id)
  }
  async getSettings() {
    return clone(this.settings)
  }
  async saveSettings(s: Settings) {
    this.settings = clone(s)
  }
  async listSnoozes() {
    return [...this.snoozes.values()].map(clone)
  }
  async saveSnooze(s: Snooze) {
    this.snoozes.set(s.id, clone(s))
  }
  async listEscalations() {
    return [...this.escalations.values()].map(clone)
  }
  async saveEscalation(r: EscalationRecord) {
    this.escalations.set(`${r.medicationId}|${new Date(r.dueAt).toISOString()}`, clone(r))
  }
  async pruneEscalations(before: Date) {
    for (const [k, r] of this.escalations) if (new Date(r.dueAt) < before) this.escalations.delete(k)
  }
  async deleteSnooze(id: string) {
    this.snoozes.delete(id)
  }
  async listSyncJobs() {
    return [...this.jobs.values()].map(clone)
  }
  async saveSyncJob(j: SyncJob) {
    this.jobs.set(j.target, clone(j))
  }
  async deleteSyncJob(t: string) {
    this.jobs.delete(t)
  }
  async getEventLink(t: string) {
    const l = this.links.get(t)
    return l ? clone(l) : null
  }
  async saveEventLink(l: EventLink) {
    this.links.set(l.target, clone(l))
  }
  async deleteEventLink(t: string) {
    this.links.delete(t)
  }
  async clearEventLinks() {
    this.links.clear()
    this.escalations.clear()
  }
  async getKV(k: string) {
    return this.kv.get(k) ?? null
  }
  async setKV(k: string, v: string | null) {
    if (v == null) this.kv.delete(k)
    else this.kv.set(k, v)
  }
  async exportAll(): Promise<BackupData> {
    return { app: 'doseline', version: 1, exportedAt: new Date().toISOString(), medications: await this.listMedications(), logs: await this.listLogs(), settings: await this.getSettings() }
  }
  async importAll(d: BackupData) {
    this.meds.clear()
    this.logs.clear()
    this.snoozes.clear()
    this.jobs.clear()
    this.links.clear()
    for (const m of d.medications) this.meds.set(m.id, clone(m))
    for (const l of d.logs) this.logs.set(l.id, clone(l))
    this.settings = clone(d.settings)
  }
}
