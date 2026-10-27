import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { UpNextItem } from '../core/today'
import type { AppController } from './controller'

function fmt(d: Date): string {
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

export class DoselineTray {
  private tray: Tray
  private lastSig = ''

  constructor(
    icon: string,
    private ctl: AppController,
  ) {
    this.tray = new Tray(nativeImage.createFromPath(icon))
    this.tray.setToolTip('Doseline')
    this.tray.on('click', () => this.ctl.showMain())
    this.update([])
  }

  update(items: UpNextItem[]): void {
    const scheduled = items.filter((i) => i.next)
    const first = scheduled[0]
    const headline = first ? `Next: ${first.med.name} · ${fmt(first.next!.dueAt)}` : 'No upcoming doses'
    const sig = JSON.stringify([headline, items.map((i) => [i.med.id, i.med.name, i.status])])
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.tray.setToolTip(first ? `Doseline\n${headline}` : 'Doseline')

    const dueNow = items.filter((i) => i.status === 'due' || i.status === 'overdue')
    const template: MenuItemConstructorOptions[] = [
      { label: headline, enabled: false },
      ...dueNow.map((i) => ({ label: `Take ${i.med.name} now`, click: () => void this.ctl.quickLog(i.med.id) })),
      { type: 'separator' },
      {
        label: 'Log a dose',
        enabled: items.length > 0,
        submenu: items.length
          ? items.map((i) => ({ label: `${i.med.name}${i.med.strength ? ` ${i.med.strength}` : ''}`, click: () => void this.ctl.quickLog(i.med.id) }))
          : [{ label: 'No active medications', enabled: false }],
      },
      { label: 'Quick log…', click: () => this.ctl.openPalette() },
      { type: 'separator' },
      { label: 'Open Doseline', click: () => this.ctl.showMain() },
      {
        label: 'Quit Doseline',
        click: () => {
          this.ctl.quitting = true
          app.quit()
        },
      },
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  destroy(): void {
    this.tray.destroy()
  }
}
