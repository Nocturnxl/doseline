import { useState } from 'react'
import { ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-react'
import { api, useSnapshot, useToasts } from '../lib/store'
import { Field } from './ui'

const CONSOLE = 'https://console.cloud.google.com/'

/** Step list + client ID/secret form. Used by onboarding and Settings. */
export function GoogleSetup({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const snap = useSnapshot()
  const { push } = useToasts()
  const [clientId, setClientId] = useState(snap.google.clientId ?? '')
  const [secret, setSecret] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveAndConnect = async () => {
    setError(null)
    setBusy(true)
    const s = await api.googleSaveClient(clientId, secret)
    if (!s.ok) {
      setBusy(false)
      setError(s.error)
      return
    }
    const c = await api.googleConnect()
    setBusy(false)
    if (!c.ok) setError(c.error)
    else {
      push({ kind: 'success', message: 'Google Calendar connected' })
      onDone?.()
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {!compact && (
        <ol className="steps">
          <li>
            <span>
              In the{' '}
              <button className="link" onClick={() => void api.openExternal(CONSOLE)}>
                Google Cloud Console
              </button>
              , <b>create a project</b> and <b>enable the Google Calendar API</b>.
            </span>
          </li>
          <li>
            <span>
              Set up the <b>OAuth consent screen</b> as <b>External</b> and add your Google account as a <b>test user</b>.
            </span>
          </li>
          <li>
            <span>
              Create an <b>OAuth client ID</b> of type <b>Desktop app</b>, then copy its client ID and secret below.
            </span>
          </li>
          <li>
            <span>
              Set the publishing status to <b>In production</b>. In Testing mode Google expires the Calendar sign-in after <b>7 days</b>.
            </span>
          </li>
        </ol>
      )}
      <Field label="Client ID" htmlFor="g-id">
        <input id="g-id" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890-abc….apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
      </Field>
      <Field label="Client secret" htmlFor="g-secret" hint="Stored encrypted on this PC with Windows DPAPI. Never uploaded anywhere.">
        <div className="input-group">
          <input id="g-secret" className="input" type={show ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={snap.google.configured ? '•••••••• (saved, enter again to change)' : 'GOCSPX-…'} spellCheck={false} autoComplete="off" />
          <button className="addon" style={{ cursor: 'pointer' }} onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide secret' : 'Show secret'} type="button">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </Field>
      {error && (
        <div className="callout danger" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary" disabled={busy || !clientId || !secret} onClick={() => void saveAndConnect()}>
          {busy ? <LoaderCircle className="spin" /> : <KeyRound />}
          {busy ? 'Waiting for your browser…' : 'Save and sign in with Google'}
        </button>
        {busy && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              void api.googleCancelConnect()
              setBusy(false)
            }}
          >
            Cancel
          </button>
        )}
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => void api.openExternal('https://developers.google.com/workspace/calendar/api/quickstart/js#set-up-environment')}>
          <ExternalLink />
          Google's guide
        </button>
      </div>
      <p className="tiny subtle">
        Sign-in opens in your default browser. Doseline asks only for permission to manage calendars it creates itself, so it can't read your other calendars. Full steps are in SETUP.md.
      </p>
    </div>
  )
}
