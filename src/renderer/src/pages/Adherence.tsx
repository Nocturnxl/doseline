import { useMemo, useState, type CSSProperties } from 'react'
import { Flame, Info } from 'lucide-react'
import { adherenceOverDays, currentStreak, heatmap, type HeatmapDay } from '../../../core/adherence'
import { describeSchedule } from '../../../core/schedule'
import { localDateKey, startOfLocalDate } from '../../../core/time'
import { useNow, useSnapshot } from '../lib/store'
import { fmtDate, minutesLabel, pct, plural } from '../lib/format'
import { MedBadge } from '../components/MedIcon'
import { EmptyArt } from '../components/EmptyArt'

const WEEKS = 39

function level(d: HeatmapDay): string {
  if (d.rate == null) return '0'
  if (d.rate === 0) return 'miss'
  if (d.rate < 0.5) return '1'
  if (d.rate < 0.8) return '2'
  if (d.rate < 1) return '3'
  return '4'
}

export function AdherencePage() {
  const snap = useSnapshot()
  const now = useNow(60_000)
  const { zone, settings } = snap
  const [medFilter, setMedFilter] = useState('')
  const scheduled = snap.meds.filter((m) => m.schedule.type !== 'prn')
  const prn = snap.meds.filter((m) => m.schedule.type === 'prn')

  // Pad so the grid starts on a Monday.
  const todayIso = new Date(localDateKey(now, zone) + 'T12:00:00Z')
  const weekday = (todayIso.getUTCDay() + 6) % 7 // Mon=0
  const days = (WEEKS - 1) * 7 + weekday + 1
  const heatMeds = medFilter ? scheduled.filter((m) => m.id === medFilter) : scheduled
  const cells = useMemo(() => heatmap(heatMeds, snap.logs, days, now, zone, settings.graceMinutes), [heatMeds, snap.logs, days, now, zone, settings.graceMinutes])
  const overall = useMemo(() => {
    let exp = 0
    let on = 0
    for (const c of cells.slice(-30)) {
      exp += c.expected
      on += c.onTime
    }
    return exp ? on / exp : null
  }, [cells])
  const streak = useMemo(() => currentStreak(scheduled, snap.logs, now, zone, settings.graceMinutes), [scheduled, snap.logs, now, zone, settings.graceMinutes])

  if (scheduled.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <div className="titles">
            <h1>Adherence</h1>
          </div>
        </div>
        <div className="card">
          <div className="empty">
            <EmptyArt variant="chart" />
            <h2>No scheduled medications yet</h2>
            <p>Adherence tracks scheduled doses. Add a medication with set times or an interval to see on-time rates, streaks and a calendar heatmap.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="titles">
          <h1>Adherence</h1>
          <p>
            "On time" means within {minutesLabel(settings.graceMinutes)} of the scheduled time. Change this in Settings.
          </p>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div className="row" style={{ gap: 28 }}>
            <div>
              <div className="eyebrow">Last 30 days</div>
              <div style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.03em' }} className="num">
                {pct(overall)}
              </div>
            </div>
            <div>
              <div className="eyebrow">Current streak</div>
              <div style={{ fontSize: 30, fontWeight: 650, letterSpacing: '-0.03em', display: 'flex', alignItems: 'center', gap: 6 }} className="num">
                {plural(streak, 'day')}
                {streak > 0 && <Flame size={22} color="var(--warning)" />}
              </div>
            </div>
          </div>
          <select className="select" style={{ width: 200 }} value={medFilter} onChange={(e) => setMedFilter(e.target.value)} aria-label="Heatmap medication">
            <option value="">All scheduled meds</option>
            {scheduled.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="heatmap" role="img" aria-label={`Adherence heatmap for the last ${WEEKS} weeks`}>
          {cells.map((c) => (
            <span
              key={c.date}
              className={`cell${c.date === localDateKey(now, zone) ? ' today' : ''}`}
              data-level={level(c)}
              title={`${fmtDate(startOfLocalDate(c.date, zone), zone, { weekday: 'short', month: 'short', day: 'numeric' })}: ${c.expected ? `${c.onTime}/${c.expected} on time` : 'nothing scheduled'}`}
            />
          ))}
        </div>
        <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
          <span className="tiny subtle">
            {fmtDate(startOfLocalDate(cells[0]!.date, zone), zone, { month: 'short', day: 'numeric' })} – today
          </span>
          <div className="legend">
            <span>Missed</span>
            <span className="cell" style={{ background: 'color-mix(in srgb, var(--danger) 45%, var(--track))' }} />
            <span style={{ marginLeft: 8 }}>Less</span>
            {['0', '1', '2', '3', '4'].map((l) => (
              <span key={l} className="cell heatmap-legend" data-level={l} style={{ background: l === '0' ? 'var(--track)' : l === '4' ? 'var(--accent)' : `color-mix(in srgb, var(--accent) ${['', 28, 52, 76][Number(l)]}%, var(--track))` }} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>

      <div className="adh-grid">
        {scheduled.map((m) => {
          const s7 = adherenceOverDays(m, snap.logs, 7, now, zone, settings.graceMinutes)
          const s30 = adherenceOverDays(m, snap.logs, 30, now, zone, settings.graceMinutes)
          const s90 = adherenceOverDays(m, snap.logs, 90, now, zone, settings.graceMinutes)
          const st = currentStreak([m], snap.logs, now, zone, settings.graceMinutes)
          return (
            <div key={m.id} className="card card-pad" style={{ '--med': m.color } as CSSProperties}>
              <div className="row" style={{ gap: 12 }}>
                <MedBadge icon={m.icon} color={m.color} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{m.name}</h3>
                  <div className="small subtle">{describeSchedule(m)}</div>
                </div>
                <span className="pill" title="Current streak">
                  <Flame />
                  {st}d
                </span>
              </div>
              <div className="adh-bars">
                {[
                  ['7 days', s7],
                  ['30 days', s30],
                  ['90 days', s90],
                ].map(([l, s]) => {
                  const stats = s as typeof s7
                  return (
                    <div key={l as string}>
                      <div className="l">{l as string}</div>
                      <div className="v">{pct(stats.onTimeRate)}</div>
                      <div className="progress" style={{ marginTop: 6 }}>
                        <span style={{ width: `${(stats.onTimeRate ?? 0) * 100}%` }} />
                      </div>
                      <div className="tiny subtle num" style={{ marginTop: 6 }}>
                        {stats.expected ? `${stats.onTime}/${stats.expected}` : 'No doses yet'}
                        {stats.missed ? ` · ${stats.missed} missed` : ''}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      {prn.length > 0 && (
        <div className="callout info" style={{ marginTop: 20 }}>
          <Info />
          <span>
            As-needed medications ({prn.map((m) => m.name).join(', ')}) aren't scheduled, so they aren't scored here. Their doses appear in History and the doctor report.
          </span>
        </div>
      )}
    </div>
  )
}
