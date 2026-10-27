import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../core/ports'

const MAX_BYTES = 1024 * 1024
const KEEP = 3

/** Keys that must never be written anywhere, even in development. */
const SECRET_KEYS = /token|secret|code|verifier|authorization|password/i

function scrub(meta?: Record<string, unknown>): string {
  if (!meta) return ''
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) safe[k] = SECRET_KEYS.test(k) ? '[redacted]' : v
  try {
    return ' ' + JSON.stringify(safe)
  } catch {
    return ''
  }
}

/**
 * Rotating file logger (doseline.log, .1, .2). Console output only in development, so
 * production builds never print tokens or medication data to a console.
 */
export class FileLogger implements Logger {
  readonly file: string

  constructor(
    dir: string,
    private consoleEcho: boolean,
  ) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'doseline.log')
  }

  private rotate(): void {
    try {
      if (!fs.existsSync(this.file) || fs.statSync(this.file).size < MAX_BYTES) return
      for (let i = KEEP - 1; i >= 1; i--) {
        const src = `${this.file}.${i}`
        if (fs.existsSync(src)) fs.renameSync(src, `${this.file}.${i + 1}`)
      }
      fs.renameSync(this.file, `${this.file}.1`)
      const oldest = `${this.file}.${KEEP}`
      if (fs.existsSync(oldest)) fs.rmSync(oldest)
    } catch {
      /* logging must never throw */
    }
  }

  private write(level: string, msg: string, meta?: Record<string, unknown>): void {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${scrub(meta)}\n`
    try {
      this.rotate()
      fs.appendFileSync(this.file, line)
    } catch {
      /* ignore */
    }
    if (this.consoleEcho) (level === 'ERROR' ? console.error : console.log)(line.trimEnd())
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('INFO', msg, meta)
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('WARN', msg, meta)
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('ERROR', msg, meta)
  }
}
