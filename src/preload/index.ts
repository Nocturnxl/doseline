import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AlarmWindowState, AppSnapshot, DoselineApi, Route, ToastMessage } from '../shared/api'

function subscribe<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** The only surface the renderer can reach. Every call is a narrow, typed IPC message. */
const api: DoselineApi = {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  onSnapshot: (cb) => subscribe<AppSnapshot>('snapshot', cb),
  reportZone: (zone) => ipcRenderer.send('zone:report', zone),

  saveMedication: (input) => ipcRenderer.invoke('med:save', input),
  deleteMedication: (id) => ipcRenderer.invoke('med:delete', id),
  setActive: (id, active) => ipcRenderer.invoke('med:setActive', id, active),
  adjustInventory: (id, count) => ipcRenderer.invoke('med:inventory', id, count),

  previewWarnings: (id, at) => ipcRenderer.invoke('dose:preview', id, at),
  logDose: (req) => ipcRenderer.invoke('dose:log', req),
  undo: (token) => ipcRenderer.invoke('dose:undo', token),
  updateLog: (id, patch) => ipcRenderer.invoke('log:update', id, patch),
  deleteLog: (id) => ipcRenderer.invoke('log:delete', id),

  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  dismissMissed: () => ipcRenderer.invoke('missed:dismiss'),

  googleSaveClient: (id, secret) => ipcRenderer.invoke('google:saveClient', id, secret),
  googleClearClient: () => ipcRenderer.invoke('google:clearClient'),
  googleConnect: () => ipcRenderer.invoke('google:connect'),
  googleCancelConnect: () => ipcRenderer.invoke('google:cancel'),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  syncNow: () => ipcRenderer.invoke('sync:now'),

  exportCsv: (r) => ipcRenderer.invoke('export:csv', r),
  exportPdf: (r) => ipcRenderer.invoke('export:pdf', r),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),

  drugSearch: (query, requestId) => ipcRenderer.invoke('drug:search', query, requestId),
  drugCancel: (requestId) => ipcRenderer.send('drug:cancel', requestId),
  drugStrengths: (drug) => ipcRenderer.invoke('drug:strengths', drug),
  drugRanking: (drug) => ipcRenderer.invoke('drug:rank', drug),
  drugUsedStrengths: (displayName) => ipcRenderer.invoke('drug:used', displayName),
  setOpenFdaKey: (key) => ipcRenderer.invoke('drug:setKey', key),

  devFireTestAlarm: () => ipcRenderer.invoke('dev:testAlarm'),
  devCreateTestDose: (opts) => ipcRenderer.invoke('dev:testDose', opts),
  devFireTestEscalation: (count) => ipcRenderer.invoke('dev:testEscalation', count),
  devLoadDemoData: () => ipcRenderer.invoke('dev:loadDemo'),
  openLogFolder: () => ipcRenderer.invoke('dev:openLogs'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  alarmGetState: () => ipcRenderer.invoke('alarm:get'),
  onAlarmState: (cb) => subscribe<AlarmWindowState>('alarm-state', cb),
  alarmAct: (key, action, arg) => ipcRenderer.invoke('alarm:act', key, action, arg),
  alarmResize: (height, width) => ipcRenderer.send('alarm:resize', height, width),

  paletteClose: () => ipcRenderer.send('palette:close'),
  openPalette: () => ipcRenderer.send('palette:open'),
  onPaletteOpen: (cb) => subscribe<void>('palette-open', () => cb()),
  reportReady: () => ipcRenderer.send('report:ready'),

  onToast: (cb) => subscribe<ToastMessage>('toast', cb),
  onNavigate: (cb) => subscribe<Route>('navigate', cb),
}

contextBridge.exposeInMainWorld('doseline', api)
