import { useState } from 'react'
import { ArrowRight, BellRing, CalendarCheck, ChartColumn, ShieldCheck } from 'lucide-react'
import { api, useSnapshot } from '../lib/store'
import { GoogleSetup } from '../components/GoogleSetup'

/** First-run welcome + optional Google Calendar setup. */
export function Onboarding() {
  const snap = useSnapshot()
  const [step, setStep] = useState<'welcome' | 'google'>(snap.google.configured ? 'google' : 'welcome')
  const finish = () => void api.updateSettings({ onboarded: true })

  return (
    <div className="shell" style={{ gridTemplateColumns: '1fr' }}>
      <header className="titlebar">
        <div className="brand">
          <img src="./icon.png" alt="" />
          Doseline
        </div>
      </header>
      <main className="onboard">
        <div className="card onboard-card">
          <div className="side">
            <img src="./icon.png" alt="" width={56} height={56} style={{ borderRadius: 14 }} />
            <div>
              <h1>Welcome to Doseline</h1>
              <p className="muted" style={{ marginTop: 8 }}>
                A calm, private medication tracker for your PC.
              </p>
            </div>
            <div className="stack" style={{ gap: 16, marginTop: 8 }}>
              <div className="feature">
                <span className="fi">
                  <BellRing />
                </span>
                <div>
                  <div className="ft">Reminders that just work</div>
                  <div className="fd">Alarms before every dose, even offline, right from the tray.</div>
                </div>
              </div>
              <div className="feature">
                <span className="fi">
                  <ChartColumn />
                </span>
                <div>
                  <div className="ft">History you can share</div>
                  <div className="fd">Adherence, streaks, and a clean PDF for your next appointment.</div>
                </div>
              </div>
              <div className="feature">
                <span className="fi">
                  <CalendarCheck />
                </span>
                <div>
                  <div className="ft">Optional Google Calendar</div>
                  <div className="fd">Your next dose appears on your phone, too.</div>
                </div>
              </div>
              <div className="feature">
                <span className="fi">
                  <ShieldCheck />
                </span>
                <div>
                  <div className="ft">Yours alone</div>
                  <div className="fd">Data lives on this PC. Credentials are encrypted with Windows DPAPI.</div>
                </div>
              </div>
            </div>
          </div>
          <div className="main">
            {step === 'welcome' ? (
              <>
                <div className="eyebrow">Step 1 of 2</div>
                <h2 style={{ fontSize: 22 }}>Sync with Google Calendar?</h2>
                <p className="muted">
                  Doseline can keep a single "next dose" event per medication in a dedicated <b>Medications</b> calendar, with pop-up reminders on your phone. It needs a free Google Cloud OAuth client, which takes about five minutes to create.
                </p>
                <p className="muted">You can always set this up later in Settings. Everything else works without it.</p>
                <div className="stack" style={{ gap: 8, marginTop: 'auto' }}>
                  <button className="btn btn-primary btn-lg btn-block" onClick={() => setStep('google')}>
                    <CalendarCheck />
                    Set up Google Calendar
                  </button>
                  <button className="btn btn-lg btn-block" onClick={finish} data-autofocus>
                    Continue without Google
                    <ArrowRight />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="eyebrow">Step 2 of 2 · Google Calendar</div>
                <h2 style={{ fontSize: 22 }}>Connect your Google account</h2>
                <GoogleSetup onDone={finish} />
                <div className="row" style={{ marginTop: 'auto' }}>
                  <button className="btn btn-ghost" onClick={() => setStep('welcome')}>
                    Back
                  </button>
                  <span className="spacer" />
                  <button className="btn" onClick={finish}>
                    Skip for now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
