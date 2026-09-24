import { BrowserWindow, desktopCapturer, screen, type Rectangle } from 'electron';
import { foregroundRect } from './screen-time';

// "Time's up" screen shown where the closed app was: same size and place (or full
// screen if the app was), over a heavily blurred snapshot of it. The snapshot
// stays in memory and is never uploaded.

export type Snapshot = { bounds: Rectangle; fullscreen: boolean; displayId: number; image: string | null };

// Snapshots are shrunk before blurring: cheaper, and the blur hides the detail anyway.
const SNAPSHOT_WIDTH = 480;

let current: BrowserWindow | null = null;

// Call before closing the app: where its window is, and a picture of it.
export async function snapshotForeground(): Promise<Snapshot | null> {
  const rect = foregroundRect();
  if (!rect) return null;
  const physical = { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
  const dip = screen.screenToDipRect(null, physical);
  const display = screen.getDisplayMatching(dip);
  const area = display.bounds;
  // Covers the whole monitor (a maximized window stops at the taskbar).
  const fullscreen =
    dip.x <= area.x && dip.y <= area.y && dip.x + dip.width >= area.x + area.width && dip.y + dip.height >= area.y + area.height;
  const bounds = fullscreen ? area : clamp(dip, display.workArea);
  return { bounds, fullscreen, displayId: display.id, image: await capture(display, bounds).catch(() => null) };
}

function clamp(r: Rectangle, area: Rectangle): Rectangle {
  const x = Math.max(r.x, area.x);
  const y = Math.max(r.y, area.y);
  const width = Math.max(360, Math.min(r.x + r.width, area.x + area.width) - x);
  const height = Math.max(260, Math.min(r.y + r.height, area.y + area.height) - y);
  return { x, y, width, height };
}

async function capture(display: Electron.Display, bounds: Rectangle) {
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * display.scaleFactor), height: Math.round(height * display.scaleFactor) },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : null);
  if (!source || source.thumbnail.isEmpty()) return null;
  const scale = source.thumbnail.getSize().width / width;
  const crop = source.thumbnail.crop({
    x: Math.round((bounds.x - display.bounds.x) * scale),
    y: Math.round((bounds.y - display.bounds.y) * scale),
    width: Math.round(bounds.width * scale),
    height: Math.round(bounds.height * scale),
  });
  return `data:image/jpeg;base64,${crop.resize({ width: SNAPSHOT_WIDTH }).toJPEG(70).toString('base64')}`;
}

export function showTimeUp(snapshot: Snapshot | null, text: { title: string; app: string; detail: string }) {
  current?.destroy();
  const area = screen.getPrimaryDisplay().workArea;
  const bounds = snapshot?.bounds ?? {
    width: 640,
    height: 420,
    x: Math.round(area.x + (area.width - 640) / 2),
    y: Math.round(area.y + (area.height - 420) / 2),
  };
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    show: false,
    title: 'CtrlAltBro',
    backgroundColor: '#0f1020',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  current = win;
  win.on('closed', () => {
    if (current === win) current = null;
  });
  win.once('ready-to-show', () => {
    if (snapshot?.fullscreen) win.setFullScreen(true);
    win.show();
    win.focus();
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(snapshot?.image ?? null, text))}`);
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(image: string | null, { title, app, detail }: { title: string; app: string; detail: string }) {
  const background = image ? `url("${image}") center / cover no-repeat` : 'linear-gradient(135deg, #312e81, #0f172a)';
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>CtrlAltBro</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; color: #fff; }
  .bg { position: fixed; inset: -60px; background: ${background}; filter: blur(36px) saturate(1.3) brightness(.55); transform: scale(1.08); }
  .shade { position: fixed; inset: 0; background: radial-gradient(ellipse at center, rgba(15,16,32,.25), rgba(15,16,32,.8)); }
  main { position: relative; height: 100%; display: grid; place-items: center; padding: 24px; -webkit-app-region: drag; }
  .card { width: min(440px, 100%); text-align: center; padding: 32px 28px 26px; border-radius: 22px;
          background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.18);
          backdrop-filter: blur(12px); box-shadow: 0 24px 60px rgba(0,0,0,.45);
          animation: pop .45s cubic-bezier(.2,1.4,.4,1) both; }
  .icon { font-size: 56px; line-height: 1; animation: tilt 2.4s ease-in-out infinite; display: inline-block; }
  h1 { margin: 14px 0 6px; font-size: 26px; font-weight: 700; letter-spacing: -.01em; }
  .app { display: inline-block; margin: 4px 0 12px; padding: 4px 12px; border-radius: 999px; background: rgba(255,255,255,.14); font-weight: 600; }
  p { margin: 0 0 22px; color: rgba(255,255,255,.8); line-height: 1.45; }
  button { -webkit-app-region: no-drag; font: inherit; font-weight: 600; padding: 10px 28px; border: 0; border-radius: 12px;
           color: #1e1b4b; background: #fff; cursor: pointer; transition: transform .15s; }
  button:hover { transform: translateY(-1px); }
  @keyframes pop { from { opacity: 0; transform: scale(.85) translateY(12px); } }
  @keyframes tilt { 0%, 100% { transform: rotate(-8deg); } 50% { transform: rotate(8deg); } }
</style></head>
<body>
  <div class="bg"></div><div class="shade"></div>
  <main><div class="card">
    <div class="icon">${escape(title.startsWith('Temps') ? '⏳' : '🚫')}</div>
    <h1>${escape(title)}</h1>
    <div class="app">${escape(app)}</div>
    <p>${escape(detail)}</p>
    <button autofocus onclick="window.close()">D'accord</button>
  </div></main>
  <script>addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') window.close(); });</script>
</body></html>`;
}
