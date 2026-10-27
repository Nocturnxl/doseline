/* Rasterises resources/icon.svg and resources/tray.svg into PNG + multi-size ICO files.
 * Run with: npx electron scripts/make-icons.cjs */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const res = (f) => path.join(root, 'resources', f)

function ico(pngs) {
  // ICO container with PNG-compressed entries (supported since Windows Vista).
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, buf }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(buf.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)])
}

async function render(win, svgFile, sizes) {
  const svg = fs.readFileSync(svgFile, 'utf8')
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  const out = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(dataUrl)}; await img.decode();
    const res = {};
    for (const s of ${JSON.stringify(sizes)}) {
      const c = document.createElement('canvas'); c.width = s; c.height = s;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, s, s);
      res[s] = c.toDataURL('image/png');
    }
    return res;
  })()`)
  return sizes.map((s) => ({ size: s, buf: Buffer.from(out[s].split(',')[1], 'base64') }))
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const appSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
  const appPngs = await render(win, res('icon.svg'), [...appSizes, 512])
  fs.writeFileSync(res('icon.ico'), ico(appPngs.filter((p) => p.size <= 256)))
  fs.writeFileSync(res('icon.png'), appPngs.find((p) => p.size === 256).buf)
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(appPngs.filter((p) => p.size <= 256)))
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), appPngs.find((p) => p.size === 512).buf)
  const trayPngs = await render(win, res('tray.svg'), [16, 20, 24, 32, 40, 48, 64])
  fs.writeFileSync(res('tray.ico'), ico(trayPngs))
  fs.writeFileSync(res('tray.png'), trayPngs.find((p) => p.size === 32).buf)
  fs.mkdirSync(path.join(root, 'src', 'renderer', 'public'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'public', 'icon.png'), appPngs.find((p) => p.size === 128).buf)
  console.log('icons written')
  app.quit()
})
