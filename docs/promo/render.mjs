// Frame renderer: drives headless Microsoft Edge over the Chrome DevTools Protocol
// (Node 24 global WebSocket, no dependencies), seeks the timeline page frame by frame,
// and writes PNG frames plus the procedural score as WAV.
//
//   node docs/promo/render.mjs [--from 0] [--to <duration>] [--step 1] [--fps 30] [--frames docs/promo/frames]
//                         [--audio docs/promo/out/audio.wav] [--no-audio] [--audio-only] [--times 2.5,14,30]
//                         [--cover docs/promo/out/cover.png [--variant a|b]]   (renders only a still cover)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const FPS = Number(args.fps || 30);
const FROM = Number(args.from || 0);
const TO_ARG = args.to !== undefined ? Number(args.to) : undefined;
const STEP = Number(args.step || 1);
const FRAMES = path.resolve(args.frames || path.join(here, 'frames'));
const AUDIO = path.resolve(args.audio || path.join(here, 'out', 'audio.wav'));
const EDGE = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const PROFILE_ROOT = process.env.RENDER_TMP || tmpdir();

const profile = mkdtempSync(path.join(PROFILE_ROOT, 'gp-edge-'));
const edge = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1920,1080', '--autoplay-policy=no-user-gesture-required',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
edge.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function devtoolsPort() {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) { const [port] = readFileSync(file, 'utf8').split('\n'); if (port) return Number(port); }
    await sleep(100);
  }
  throw new Error('Edge did not report a DevTools port');
}

let ws; let nextId = 1; const pending = new Map(); const listeners = [];
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
function once(method) { return new Promise((r) => listeners.push({ method, r })); }
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(`${expression}: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  return res.result.value;
}

async function main() {
  const port = await devtoolsPort();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
    } else if (msg.method) {
      for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].method === msg.method) { listeners[i].r(msg.params); listeners.splice(i, 1); }
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') console.error('page exception:', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) console.error(`page ${msg.params.type}:`, msg.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const url = pathToFileURL(path.join(here, 'index.html')).href + '?render=1';
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await loaded;
  await evaluate('window.__ready');
  const TO = TO_ARG ?? await evaluate('window.__duration');
  if (args.cover) {
    await evaluate('window.__renderCover(' + JSON.stringify(String(args.variant || 'a')) + ').then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const file = path.resolve(String(args.cover));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    process.stdout.write(`cover -> ${file}\n`);
    return;
  }

  if (!args['audio-only']) {
    mkdirSync(FRAMES, { recursive: true });
    const times = args.times ? String(args.times).split(',').map(Number) : null;
    const frames = [];
    if (times) times.forEach((t) => frames.push(Math.round(t * FPS)));
    else for (let f = Math.round(FROM * FPS); f < Math.round(TO * FPS); f += STEP) frames.push(f);
    const started = Date.now();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      await evaluate(`window.__seek(${f / FPS}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      writeFileSync(path.join(FRAMES, `${String(f).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
      if (i % 30 === 0 || i === frames.length - 1) {
        const el = (Date.now() - started) / 1000;
        process.stdout.write(`frame ${i + 1}/${frames.length} (t=${(f / FPS).toFixed(2)}s) ${el.toFixed(0)}s elapsed\n`);
      }
    }
  }
  if (!args['no-audio']) {
    mkdirSync(path.dirname(AUDIO), { recursive: true });
    const b64 = await evaluate('window.__renderAudio()');
    writeFileSync(AUDIO, Buffer.from(b64, 'base64'));
    process.stdout.write(`audio → ${AUDIO}\n`);
  }
}

main().then(() => 0, (err) => { console.error(err); return 1; }).then(async (code) => {
  try { ws?.close(); } catch { /* closing */ }
  edge.kill('SIGTERM');
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  process.exit(code);
});
