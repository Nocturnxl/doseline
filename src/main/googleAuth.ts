import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { net, shell } from 'electron'
import type { AccessTokenProvider, Logger, StoredTokens, TokenStore } from '../core/ports'
import { AuthRequiredError } from '../core/ports'
import type { OAuthClientStore } from './secureStore'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
/** openid + email only to show which account is connected. */
export const SCOPES = ['openid', 'email', CALENDAR_SCOPE]
const LOGIN_TIMEOUT_MS = 5 * 60_000

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  id_token?: string
  error?: string
  error_description?: string
}

function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8')) as { email?: string }
    return payload.email ?? null
  } catch {
    return null
  }
}

function page(title: string, body: string, ok: boolean): string {
  const accent = ok ? '#4f8cff' : '#e5484d'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e7e9ee;font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif}
.card{max-width:420px;padding:40px 36px;border-radius:16px;background:#171a21;border:1px solid #262a33;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.dot{width:52px;height:52px;border-radius:50%;margin:0 auto 18px;display:grid;place-items:center;background:${accent}22;color:${accent};font-size:26px}
h1{font-size:20px;margin:0 0 8px;font-weight:600}p{margin:0;color:#9aa1ad}
@media (prefers-color-scheme: light){body{background:#f4f5f7;color:#16181d}.card{background:#fff;border-color:#e3e5ea}p{color:#5b616e}}
</style></head><body><div class="card"><div class="dot">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${body}</p></div></body></html>`
}

/**
 * Google OAuth 2.0 for installed apps: authorization code + PKCE, loopback redirect on
 * 127.0.0.1 with an ephemeral port, sign-in in the system browser (never a webview).
 */
export class GoogleAuth implements AccessTokenProvider {
  private tokens: StoredTokens | null = null
  private loaded = false
  private refreshing: Promise<string> | null = null
  private pending: { server: http.Server; reject: (e: Error) => void } | null = null
  needsReconnect = false

  constructor(
    private store: TokenStore,
    private clients: OAuthClientStore,
    private logger: Logger,
    private onChange: () => void,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.tokens = await this.store.load()
    this.loaded = true
  }

  get connecting(): boolean {
    return this.pending != null
  }

  async isConnected(): Promise<boolean> {
    await this.ensureLoaded()
    return !!this.tokens?.refreshToken && !!this.clients.load()
  }

  async email(): Promise<string | null> {
    await this.ensureLoaded()
    return this.tokens?.email ?? null
  }

  cancel(): void {
    if (this.pending) {
      this.pending.reject(new Error('Sign-in was cancelled.'))
      this.pending.server.close()
      this.pending = null
      this.onChange()
    }
  }

  /** Run the full interactive sign-in. Resolves once tokens are stored. */
  async connect(): Promise<void> {
    const client = this.clients.load()
    if (!client) throw new Error('Add your Google OAuth client ID and secret first.')
    this.cancel()

    const verifier = b64url(crypto.randomBytes(48))
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
    const state = b64url(crypto.randomBytes(16))

    const server = http.createServer()
    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out. Please try again.')), LOGIN_TIMEOUT_MS)
      this.pending = {
        server,
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const gotState = url.searchParams.get('state')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        if (gotState !== state) {
          res.writeHead(400).end(page('Something went wrong', 'The sign-in response did not match this request. Return to Doseline and try again.', false))
          return
        }
        clearTimeout(timer)
        if (err || !code) {
          res.writeHead(200).end(page('Sign-in cancelled', 'Google access was not granted. You can close this tab and try again from Doseline.', false))
          reject(new Error(err === 'access_denied' ? 'Google access was not granted.' : `Google sign-in failed (${err ?? 'no code'}).`))
        } else {
          res.writeHead(200).end(page('Doseline is connected', 'You can close this tab and return to the app.', true))
          resolve(code)
        }
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`
    const authUrl = new URL(AUTH_URL)
    authUrl.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    }).toString()
    this.onChange()
    this.logger.info('google: opening system browser for sign-in')
    await shell.openExternal(authUrl.toString())

    try {
      const code = await codePromise
      const tok = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      })
      if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove Doseline from your Google account permissions and try again.')
      const granted = (tok.scope ?? '').split(/\s+/)
      if (!granted.includes(CALENDAR_SCOPE)) throw new Error('Calendar access was not granted. Please allow Doseline to manage its own calendars.')
      this.tokens = {
        refreshToken: tok.refresh_token,
        accessToken: tok.access_token,
        accessTokenExpiresAt: Date.now() + tok.expires_in * 1000,
        email: emailFromIdToken(tok.id_token),
        scope: tok.scope,
      }
      await this.store.save(this.tokens)
      this.needsReconnect = false
      this.logger.info('google: connected')
    } finally {
      server.close()
      this.pending = null
      this.onChange()
    }
  }

  async disconnect(): Promise<void> {
    await this.ensureLoaded()
    const token = this.tokens?.refreshToken
    this.tokens = null
    this.needsReconnect = false
    await this.store.clear()
    if (token) {
      try {
        await net.fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
      } catch {
        this.logger.warn('google: revoke failed (offline?)')
      }
    }
    this.onChange()
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    await this.ensureLoaded()
    if (!this.tokens?.refreshToken || this.needsReconnect) throw new AuthRequiredError()
    const t = this.tokens
    if (!forceRefresh && t.accessToken && t.accessTokenExpiresAt && t.accessTokenExpiresAt - 60_000 > Date.now()) return t.accessToken
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    const client = this.clients.load()
    if (!client || !this.tokens) throw new AuthRequiredError()
    let tok: TokenResponse
    try {
      tok = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken, client_id: client.clientId, client_secret: client.clientSecret })
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        this.needsReconnect = true
        this.logger.warn('google: refresh token rejected; reconnect required')
        this.onChange()
      }
      throw e
    }
    this.tokens = { ...this.tokens, accessToken: tok.access_token, accessTokenExpiresAt: Date.now() + tok.expires_in * 1000, refreshToken: tok.refresh_token ?? this.tokens.refreshToken }
    await this.store.save(this.tokens)
    return tok.access_token
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const res = await net.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
    const body = (await res.json().catch(() => ({}))) as TokenResponse
    if (!res.ok) {
      // invalid_grant: refresh token revoked/expired (e.g. 7-day expiry in Testing mode).
      if (body.error === 'invalid_grant' || body.error === 'unauthorized_client' || body.error === 'invalid_client') throw new AuthRequiredError(body.error_description ?? body.error)
      throw new Error(`Google token request failed (${body.error ?? res.status})`)
    }
    return body
  }

  /** Reset state after the client credentials change. */
  async clientChanged(): Promise<void> {
    await this.ensureLoaded()
    this.needsReconnect = !!this.tokens
    this.onChange()
  }
}
