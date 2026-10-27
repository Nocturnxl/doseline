import { useEffect, useMemo } from 'react'
import { buildReport } from '../../../core/exporting'
import { describeSchedule } from '../../../core/schedule'
import { doseLine } from '../../../core/calendar'
import { addLocalDays, startOfLocalDay } from '../../../core/time'
import { api, useSnapshot } from '../lib/store'
import { fmtDate, fmtTime, pct } from '../lib/format'

/** Printable doctor report. Rendered in a hidden window and printed to PDF by main. */
export function ReportApp() {
  const snap = useSnapshot()
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const now = useMemo(() => new Date(), [])
  const to = params.get('to') ? new Date(params.get('to')!) : now
  const from = params.get('from') ? new Date(params.get('from')!) : addLocalDays(startOfLocalDay(now, snap.zone), -29, snap.zone)
  const report = useMemo(() => buildReport(snap.meds, snap.logs, from, to, now, snap.zone, snap.settings.graceMinutes), [snap, from.getTime(), to.getTime(), now])
  const z = snap.zone

  useEffect(() => {
    document.documentElement.dataset.theme = 'light'
    document.documentElement.dataset.mica = 'false'
    document.body.style.overflow = 'visible'
    void document.fonts.ready.then(() => requestAnimationFrame(() => api.reportReady()))
  }, [])

  const range = `${fmtDate(from, z, { month: 'long', day: 'numeric', year: 'numeric' })} – ${fmtDate(new Date(to.getTime() - 1), z, { month: 'long', day: 'numeric', year: 'numeric' })}`

  return (
    <div className="report">
      <header className="report-head">
        <div>
          <div className="report-brand">
            <img src="./icon.png" alt="" width={22} height={22} /> Doseline
          </div>
          <h1>Medication report</h1>
          <div className="muted">{range}</div>
        </div>
        <div className="muted small" style={{ textAlign: 'right' }}>
          Generated {fmtDate(now, z, { month: 'short', day: 'numeric', year: 'numeric' })} {fmtTime(now, z)}
          <br />
          Time zone: {z}
          <br />
          On-time window: ±{snap.settings.graceMinutes} min
        </div>
      </header>

      <table className="report-summary">
        <thead>
          <tr>
            <th>Medication</th>
            <th>Dose</th>
            <th>Schedule</th>
            <th className="r">Expected</th>
            <th className="r">On time</th>
            <th className="r">Late</th>
            <th className="r">Skipped</th>
            <th className="r">Missed</th>
            <th className="r">Adherence</th>
          </tr>
        </thead>
        <tbody>
          {report.sections.map((s) => (
            <tr key={s.med.id}>
              <td>
                <span className="swatch-dot" style={{ background: s.med.color }} />
                <b>{s.med.name}</b> {s.med.strength}
                {!s.med.active && <span className="muted"> (paused)</span>}
              </td>
              <td>{doseLine(s.med)}</td>
              <td>{describeSchedule(s.med)}</td>
              {s.med.schedule.type === 'prn' ? (
                <td colSpan={6} className="r muted">
                  As needed · {s.prnCount} dose{s.prnCount === 1 ? '' : 's'} taken
                </td>
              ) : (
                <>
                  <td className="r">{s.stats.expected}</td>
                  <td className="r">{s.stats.onTime}</td>
                  <td className="r">{s.stats.late}</td>
                  <td className="r">{s.stats.skipped}</td>
                  <td className="r">{s.stats.missed}</td>
                  <td className="r">
                    <b>{pct(s.stats.onTimeRate)}</b>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {report.sections.map((s) => (
        <section key={s.med.id} className="report-med">
          <h2>
            <span className="swatch-dot" style={{ background: s.med.color }} />
            {s.med.name} {s.med.strength}
          </h2>
          <div className="muted small">
            {doseLine(s.med)}
            {s.med.instructions ? ` · ${s.med.instructions}` : ''}
            {s.med.notes ? ` · ${s.med.notes}` : ''}
          </div>
          {s.entries.length === 0 ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              No entries in this period.
            </p>
          ) : (
            <table className="report-log">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Time</th>
                  <th>Status</th>
                  <th>Scheduled</th>
                  <th className="r">Offset</th>
                </tr>
              </thead>
              <tbody>
                {s.entries.map((e, i) => (
                  <tr key={i} className={e.kind}>
                    <td>{fmtDate(e.at, z, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                    <td>{e.kind === 'missed' ? '—' : fmtTime(e.at, z)}</td>
                    <td>{e.kind === 'taken' ? 'Taken' : e.kind === 'skipped' ? 'Skipped' : 'Missed'}</td>
                    <td>{e.scheduledFor ? fmtTime(e.scheduledFor, z) : s.med.schedule.type === 'prn' ? 'As needed' : '—'}</td>
                    <td className="r">{e.minutesOff == null ? '' : e.minutesOff === 0 ? '0 min' : `${e.minutesOff > 0 ? '+' : '−'}${Math.abs(e.minutesOff)} min`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      <footer className="report-foot small muted">This report was generated from self-recorded data in Doseline and is intended to support a conversation with your clinician.</footer>
    </div>
  )
}
