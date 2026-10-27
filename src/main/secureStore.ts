import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { StoredTokens, TokenStore } from '../core/ports'

/** A small JSON blob encrypted with Electron safeStorage (DPAPI on Windows). */
export class EncryptedFile<T> {
  constructor(private file: string) {}

  load(): T | null {
    try {
      if (!fs.existsSync(this.file)) return null
      const buf = fs.readFileSync(this.file)
      return JSON.parse(safeStorage.decryptString(buf)) as T
    } catch {
      // Unreadable (e.g. copied from another Windows account): treat as absent.
      return null
    }
  }

  save(value: T): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable on this system, so credentials cannot be saved.')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(value)))
    fs.renameSync(tmp, this.file)
  }

  clear(): void {
    try {
      fs.rmSync(this.file, { force: true })
    } catch {
      /* ignore */
    }
  }
}

export class SafeStorageTokenStore implements TokenStore {
  private f: EncryptedFile<StoredTokens>
  constructor(dir: string) {
    this.f = new EncryptedFile(path.join(dir, 'google-tokens.bin'))
  }
  async load() {
    return this.f.load()
  }
  async save(t: StoredTokens) {
    this.f.save(t)
  }
  async clear() {
    this.f.clear()
  }
}

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
}

export class OAuthClientStore {
  private f: EncryptedFile<OAuthClientConfig>
  constructor(dir: string) {
    this.f = new EncryptedFile(path.join(dir, 'oauth-client.bin'))
  }
  load() {
    return this.f.load()
  }
  save(c: OAuthClientConfig) {
    this.f.save(c)
  }
  clear() {
    this.f.clear()
  }
}
