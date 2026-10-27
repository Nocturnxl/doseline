import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { DoseKind } from '../core/types'
import type { SettingsPatch } from '../core/settings'
import type { AlarmAction, ExportRange, LogDoseRequest, MedicationInput } from '../shared/api'
import { type AppController, fail, ok } from './controller'
import { sanitizeDrug } from './drugs'

const EXTERNAL_ALLOW = [/^https:\/\/console\.cloud\.google\.com\//, /^https:\/\/developers\.google\.com\//, /^https:\/\/support\.google\.com\//, /^https:\/\/myaccount\.google\.com\//, /^https:\/\/calendar\.google\.com\//]

function str(v: unknown, max = 2000): string {
  if (typeof v !== 'string') throw new Error('Invalid argument')
  return v.slice(0, max)
}

/** Catalog link fields come from the renderer: keep them well-formed or drop them. */
function sanitizeCatalog(input: MedicationInput): MedicationInput {
  const id = (v: unknown) => (typeof v === 'string' && /^\d{1,12}$/.test(v) ? v : null)
  const catalogName = typeof input.catalogName === 'string' && input.catalogName.trim() ? input.catalogName.slice(0, 300) : null
  return {
    ...input,
    catalogName,
    catalogSource: catalogName ? 'rxterms' : null,
    rxcui: catalogName ? id(input.rxcui) : null,
    strengthRxcui: catalogName ? id(input.strengthRxcui) : null,
  }
}

/** Register every IPC handler. Arguments from the renderer are treated as untrusted input. */
export function registerIpc(ctl: AppController): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>) => {
    ipcMain.handle(channel, (_e: IpcMainInvokeEvent, ...args: unknown[]) => fn(...(args as A)))
  }
  const guarded = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>) => {
    handle(channel, async (...args: A) => {
      try {
        return ok(await fn(...args))
      } catch (e) {
        ctl.logger.error(`ipc ${channel} failed`, { error: e instanceof Error ? e.message : String(e) })
        return fail(e)
      }
    })
  }

  handle('snapshot:get', () => ctl.snapshot())
  ipcMain.on('zone:report', (_e, zone: unknown) => {
    if (typeof zone === 'string') ctl.setZone(zone)
  })

  guarded('med:save', async (input: MedicationInput) => {
    const med = await ctl.service.saveMedication(sanitizeCatalog(input))
    await ctl.drugs.recordUsed(med)
    return med
  })
  guarded('med:delete', async (id: string) => ctl.service.deleteMedication(str(id)))
  guarded('med:setActive', async (id: string, active: boolean) => {
    await ctl.service.setActive(str(id), !!active)
  })
  guarded('med:inventory', async (id: string, count: number) => {
    await ctl.service.adjustInventory(str(id), Number(count))
  })

  handle('dose:preview', async (id: string, at?: string) => {
    try {
      return await ctl.service.previewWarnings(str(id), at ? new Date(str(at)) : undefined)
    } catch {
      return []
    }
  })
  guarded('dose:log', async (req: LogDoseRequest) => {
    const kind: DoseKind = req.kind === 'skipped' ? 'skipped' : 'taken'
    return ctl.service.logDose({ medicationId: str(req.medicationId), kind, at: req.at ? new Date(str(req.at)) : undefined, note: req.note ? str(req.note, 500) : undefined })
  })
  guarded('dose:undo', async (token: string) => ctl.service.undo(str(token)))
  guarded('log:update', async (id: string, patch: { takenAt?: string; kind?: DoseKind; note?: string }) => {
    await ctl.service.updateLog(str(id), { takenAt: patch.takenAt, kind: patch.kind, note: patch.note })
  })
  guarded('log:delete', async (id: string) => ctl.service.deleteLog(str(id)))

  guarded('settings:update', async (patch: SettingsPatch) => {
    const before = await ctl.settings()
    const next = await ctl.service.updateSettings(patch)
    if (patch.theme && patch.theme !== before.theme) ctl.applyTheme(next.theme)
    if (patch.launchAtLogin !== undefined) ctl.applyLoginItem(next.launchAtLogin)
    if (patch.hotkey !== undefined && patch.hotkey !== before.hotkey) {
      if (!ctl.registerHotkey(next.hotkey)) {
        await ctl.service.updateSettings({ hotkey: before.hotkey })
        ctl.registerHotkey(before.hotkey)
        throw new Error(`Couldn't register ${next.hotkey}. Kept ${before.hotkey}.`)
      }
    }
    ctl.scheduleBroadcast()
    return next
  })
  handle('missed:dismiss', async () => {
    await ctl.engine.dismissMissed()
    ctl.scheduleBroadcast()
  })

  guarded('google:saveClient', async (clientId: string, clientSecret: string) => {
    const id = str(clientId, 300).trim()
    const secret = str(clientSecret, 300).trim()
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('That doesn\'t look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).')
    if (secret.length < 8) throw new Error('Enter the client secret shown next to the client ID.')
    ctl.clients.save({ clientId: id, clientSecret: secret })
    await ctl.auth.clientChanged()
    ctl.scheduleBroadcast()
  })
  guarded('google:clearClient', async () => {
    await ctl.auth.disconnect()
    ctl.clients.clear()
    await ctl.sync.reset()
    ctl.scheduleBroadcast()
  })
  guarded('google:connect', async () => {
    await ctl.auth.connect()
    ctl.sync.authRestored()
    await ctl.sync.enqueueAll()
    void ctl.sync.run()
    ctl.scheduleBroadcast()
    ctl.showMain()
  })
  handle('google:cancel', async () => ctl.auth.cancel())
  guarded('google:disconnect', async () => {
    await ctl.auth.disconnect()
    await ctl.sync.reset()
    ctl.scheduleBroadcast()
  })
  handle('sync:now', async () => {
    const jobs = await ctl.repo.listSyncJobs()
    ctl.sync.authRestored()
    if (jobs.length) await ctl.sync.enqueue(jobs.map((j) => j.target))
    else await ctl.sync.enqueueAll()
    await ctl.sync.run()
  })

  guarded('export:csv', async (r: ExportRange) => ctl.exportCsv(r ?? {}))
  guarded('export:pdf', async (r: ExportRange) => ctl.exportPdf(r ?? {}))
  guarded('backup:export', async () => ctl.exportBackup())
  guarded('backup:import', async () => ctl.importBackup())

  handle('drug:search', async (query: string, requestId: string) => ctl.drugs.search(str(query, 100), str(requestId, 64)))
  ipcMain.on('drug:cancel', (_e, requestId: unknown) => {
    if (typeof requestId === 'string') ctl.drugs.cancel(requestId)
  })
  handle('drug:strengths', async (drug: unknown) => ctl.drugs.strengths(sanitizeDrug(drug)))
  handle('drug:rank', async (drug: unknown) => ctl.drugs.ranking(sanitizeDrug(drug)))
  handle('drug:used', async (displayName: string) => ctl.drugs.used(str(displayName, 300)))
  guarded('drug:setKey', async (key: string | null) => {
    ctl.drugs.setKey(key == null ? null : str(key, 100))
    ctl.scheduleBroadcast()
  })

  handle('dev:testAlarm', async () => ctl.fireTestAlarm())
  guarded('dev:testDose', async (opts?: { count?: number; dueInMin?: number }) => ctl.createTestDose(Number(opts?.count ?? 1), Number(opts?.dueInMin ?? 2)))
  guarded('dev:loadDemo', async () => ctl.loadDemoData())
  handle('dev:testEscalation', async (count: number) => ctl.fireTestEscalation(Number(count) || 1))
  handle('dev:openLogs', async () => {
    shell.showItemInFolder((await ctl.snapshot()).platform.logPath)
  })
  handle('shell:openExternal', async (url: string) => {
    const u = str(url)
    if (EXTERNAL_ALLOW.some((r) => r.test(u))) await shell.openExternal(u)
  })

  handle('alarm:get', () => ctl.getAlarmState())
  guarded('alarm:act', async (key: string, action: AlarmAction, arg?: number | string) => {
    if (!['take', 'takeAt', 'skip', 'snooze', 'dismiss'].includes(action)) throw new Error('Invalid action')
    if (action === 'takeAt') {
      const at = new Date(str(arg))
      if (Number.isNaN(at.getTime())) throw new Error('Choose a valid time')
      await ctl.alarmAct(str(key), action, at)
    } else await ctl.alarmAct(str(key), action, Number(arg ?? 10))
  })
  ipcMain.on('alarm:resize', (_e, h: unknown, w: unknown) => {
    if (typeof h === 'number' && Number.isFinite(h)) ctl.resizeAlarm(h, typeof w === 'number' && Number.isFinite(w) ? w : 420)
  })

  ipcMain.on('palette:close', () => ctl.closePalette())
  ipcMain.on('palette:open', () => ctl.openPalette())
}
