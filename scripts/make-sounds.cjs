/* Synthesises the bundled alarm sounds (no third-party audio). node scripts/make-sounds.cjs */
const fs = require('fs')
const path = require('path')
const RATE = 22050
const out = path.join(__dirname, '..', 'src', 'renderer', 'public', 'sounds')
fs.mkdirSync(out, { recursive: true })

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  const k = peak > 0 ? 0.85 / peak : 1
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * k)) * 32767), i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

function render(seconds, fn) {
  const n = Math.round(seconds * RATE)
  const a = new Array(n)
  for (let i = 0; i < n; i++) a[i] = fn(i / RATE)
  // 5 ms fade in/out to avoid clicks
  const f = Math.round(0.005 * RATE)
  for (let i = 0; i < f; i++) { a[i] *= i / f; a[n - 1 - i] *= i / f }
  return a
}

const tone = (t, start, freq, decay, partials = [[1, 1]]) => {
  if (t < start) return 0
  const x = t - start
  const env = Math.exp(-x * decay) * Math.min(1, x / 0.004)
  return env * partials.reduce((s, [mul, amp]) => s + amp * Math.sin(2 * Math.PI * freq * mul * x), 0)
}

// Chime: two soft notes, a rising fifth (E5 -> B5) with gentle overtones.
const soft = [[1, 1], [2, 0.25], [3, 0.08]]
fs.writeFileSync(path.join(out, 'chime.wav'), wav(render(1.9, (t) => tone(t, 0, 659.25, 3.2, soft) + 0.9 * tone(t, 0.22, 987.77, 2.6, soft))))

// Bell: inharmonic partials of a small bell.
const bell = [[1, 1], [2.0, 0.6], [2.76, 0.35], [5.4, 0.18], [8.93, 0.08]]
fs.writeFileSync(path.join(out, 'bell.wav'), wav(render(2.4, (t) => tone(t, 0, 523.25, 1.9, bell))))

// Pulse: three short, round blips.
fs.writeFileSync(path.join(out, 'pulse.wav'), wav(render(1.1, (t) => [0, 0.2, 0.4].reduce((s, st) => s + tone(t, st, 880, 14, [[1, 1], [2, 0.15]]), 0))))
// Escalation sounds: deliberately more insistent than the reminder sounds.
// Urgent: three quick bursts of a bright two-tone beep (B5/E6), like a pager.
const beep = (t, st, f) => tone(t, st, f, 9, [[1, 1], [3, 0.22], [5, 0.08]])
const bursts = [0, 0.55, 1.1]
fs.writeFileSync(path.join(out, 'urgent.wav'), wav(render(1.75, (t) => bursts.reduce((s, b) => s + beep(t, b, 987.77) + beep(t, b + 0.14, 1318.51) + beep(t, b + 0.28, 987.77), 0))))

// Siren: two smooth up-down sweeps between A5 and E6.
fs.writeFileSync(
  path.join(out, 'siren.wav'),
  wav(
    render(1.9, (t) => {
      // Phase is the integral of f(t) = 880 + 438 * (1 - cos(2πt / 0.95)) / 2.
      const phase = 2 * Math.PI * (880 * t + 438 * (t / 2 - (0.95 / (4 * Math.PI)) * Math.sin(2 * Math.PI * t / 0.95)))
      const env = Math.min(1, t / 0.03) * Math.min(1, (1.9 - t) / 0.12)
      return env * (Math.sin(phase) + 0.18 * Math.sin(3 * phase))
    }),
  ),
)
console.log('sounds written to', out)
