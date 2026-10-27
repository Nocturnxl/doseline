import type { SoundChoice } from '../../../core/types'

let current: HTMLAudioElement | null = null

/** Play a bundled alarm sound. Sounds ship with the app; nothing is fetched remotely. */
export function playSound(choice: SoundChoice, volume: number): void {
  try {
    current?.pause()
    const a = new Audio(`./sounds/${choice}.wav`)
    a.volume = Math.min(1, Math.max(0, volume))
    current = a
    void a.play().catch(() => {
      /* autoplay can be refused before user interaction; alarms still show visually */
    })
  } catch {
    /* ignore */
  }
}

export function stopSound(): void {
  current?.pause()
  current = null
}
