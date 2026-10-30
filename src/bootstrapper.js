// Downloads, verifies, installs and launches the official Roblox client.
// Everything is async + streamed so the UI never blocks.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const extract = require('extract-zip');

const execFileP = promisify(execFile);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

const CS = 'https://clientsettingscdn.roblox.com/v2/client-version/';
const CDN = 'https://setup.rbxcdn.com/';
const UA = 'AzureStrap/1.0';

// Where each Windows package is extracted inside the version folder.
const PKG_DIRS = {
  'RobloxApp.zip': '',
  'shaders.zip': 'shaders/',
  'ssl.zip': 'ssl/',
  'WebView2.zip': '',
  'content-avatar.zip': 'content/avatar/',
  'content-configs.zip': 'content/configs/',
  'content-fonts.zip': 'content/fonts/',
  'content-sky.zip': 'content/sky/',
  'content-sounds.zip': 'content/sounds/',
  'content-textures2.zip': 'content/textures/',
  'content-models.zip': 'content/models/',
  'content-textures3.zip': 'PlatformContent/pc/textures/',
  'content-terrain.zip': 'PlatformContent/pc/terrain/',
  'content-platform-fonts.zip': 'PlatformContent/pc/fonts/',
  'extracted-content-avatar.zip': 'ExtraContent/avatar/',
  'extracted-content-configs.zip': 'ExtraContent/configs/',
  'extracted-content-fonts.zip': 'ExtraContent/fonts/',
  'extracted-content-models.zip': 'ExtraContent/models/',
  'extracted-content-sky.zip': 'ExtraContent/sky/',
  'extracted-content-sounds.zip': 'ExtraContent/sounds/',
  'extracted-content-terrain.zip': 'ExtraContent/terrain/',
  'extracted-content-textures.zip': 'ExtraContent/textures/'
};

// Mods can replace textures, sounds, fonts... never executables.
const BLOCKED_MOD_EXT = new Set(['.exe', '.dll', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.sh', '.dylib', '.so', '.scr', '.com']);

/* ---------- helpers ---------- */

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Request failed (${r.status}): ${url}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Request failed (${r.status}): ${url}`);
  return r.text();
}

async function md5(file) {
  const h = crypto.createHash('md5');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function download(url, dest, onBytes, expectedMd5) {
  if (fs.existsSync(dest) && (!expectedMd5 || (await md5(dest)) === expectedMd5)) return; // cached
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
      const counter = new Transform({
        transform(chunk, _e, cb) { onBytes(chunk.length); cb(null, chunk); }
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest + '.tmp'));
      await fsp.rename(dest + '.tmp', dest);
      if (expectedMd5 && (await md5(dest)) !== expectedMd5) throw new Error('Checksum mismatch');
      return;
    } catch (e) {
      lastErr = e;
      await fsp.rm(dest + '.tmp', { force: true });
      await fsp.rm(dest, { force: true });
      await new Promise(r => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr;
}

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  });
  await Promise.all(runners);
}

/* ---------- version lookup ---------- */

async function latest() {
  const j = await getJSON(CS + (isWin ? 'WindowsPlayer' : 'MacPlayer'));
  return { guid: j.clientVersionUpload, version: j.version };
}

/* ---------- install (into a .part folder, renamed only when complete) ---------- */

async function installWindows(info, dir, root, progress) {
  const dl = path.join(root, 'Downloads', info.guid);
  await fsp.mkdir(dl, { recursive: true });

  const lines = (await getText(`${CDN}${info.guid}-rbxPkgManifest.txt`))
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pkgs = [];
  for (let i = 1; i + 3 < lines.length; i += 4) {
    const name = lines[i];
    if (name === 'WebView2RuntimeInstaller.zip') continue; // not needed to play
    pkgs.push({ name, md5: lines[i + 1], size: Number(lines[i + 2]) });
  }
  const total = pkgs.reduce((a, p) => a + p.size, 0) || 1;
  let got = 0;

  await pool(pkgs, 4, async p => {
    await download(`${CDN}${info.guid}-${p.name}`, path.join(dl, p.name), n => {
      got += n;
      progress(Math.min(80, (got / total) * 80), 'downloading');
    }, p.md5);
  });

  const part = dir + '.part';
  await fsp.rm(part, { recursive: true, force: true });
  await fsp.mkdir(part, { recursive: true });

  let done = 0;
  for (const p of pkgs) {
    const target = path.join(part, PKG_DIRS[p.name] ?? '');
    await fsp.mkdir(target, { recursive: true });
    await extract(path.join(dl, p.name), { dir: path.resolve(target) });
    progress(80 + (++done / pkgs.length) * 20, 'installing');
  }

  await fsp.writeFile(
    path.join(part, 'AppSettings.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<Settings>\n\t<ContentFolder>content</ContentFolder>\n\t<BaseUrl>http://www.roblox.com</BaseUrl>\n</Settings>\n'
  );
  await fsp.rename(part, dir);
  await fsp.rm(dl, { recursive: true, force: true });
}

async function installMac(info, dir, root, progress) {
  const dl = path.join(root, 'Downloads', info.guid);
  await fsp.mkdir(dl, { recursive: true });
  const zip = path.join(dl, 'RobloxPlayer.zip');

  const urls = [];
  if (process.arch === 'arm64') urls.push(`${CDN}mac/arm64/${info.guid}-RobloxPlayer.zip`);
  urls.push(`${CDN}mac/${info.guid}-RobloxPlayer.zip`);

  let ok = false, lastErr;
  for (const u of urls) {
    try {
      let got = 0;
      await download(u, zip, n => { got += n; progress(Math.min(80, got / 2.5e6), 'downloading'); });
      ok = true; break;
    } catch (e) { lastErr = e; }
  }
  if (!ok) throw lastErr;

  progress(85, 'installing');
  const part = dir + '.part';
  await fsp.rm(part, { recursive: true, force: true });
  await fsp.mkdir(part, { recursive: true });
  await execFileP('/usr/bin/ditto', ['-x', '-k', zip, part]); // keeps symlinks + permissions
  await fsp.rename(part, dir);
  await fsp.rm(dl, { recursive: true, force: true });
  progress(100, 'installing');
}

async function ensureInstalled(root, progress, opts = {}) {
  const versions = path.join(root, 'Versions');
  await fsp.mkdir(versions, { recursive: true });
  let info;
  try {
    info = await latest();
  } catch (e) {
    // Offline? Fall back to the newest installed version so the game still opens.
    const have = (await fsp.readdir(versions)).filter(d => fs.existsSync(path.join(versions, d, '.azure-ok')));
    if (!have.length) throw e;
    return { dir: path.join(versions, have[have.length - 1]), version: have[have.length - 1], offline: true };
  }
  const dir = path.join(versions, info.guid);
  if (!fs.existsSync(path.join(dir, '.azure-ok'))) {
    await fsp.rm(dir, { recursive: true, force: true });
    progress(0, 'downloading');
    if (isWin) await installWindows(info, dir, root, progress);
    else await installMac(info, dir, root, progress);
    await fsp.writeFile(path.join(dir, '.azure-ok'), info.version);
    if (opts.prune !== false) {
      for (const d of await fsp.readdir(versions)) {
        if (d !== info.guid) await fsp.rm(path.join(versions, d), { recursive: true, force: true });
      }
    }
  }
  return { dir, version: info.version };
}

/* ---------- settings -> files ---------- */

const TELEMETRY_OFF = {
  FFlagDebugDisableTelemetryEphemeralCounter: true,
  FFlagDebugDisableTelemetryEphemeralStat: true,
  FFlagDebugDisableTelemetryEventIngest: true,
  FFlagDebugDisableTelemetryV2Counter: true,
  FFlagDebugDisableTelemetryV2Event: true,
  FFlagDebugDisableTelemetryV2Stat: true
};

// Roblox only honours flags on its own allow-list, so some of these may be ignored by the game.
const PRESETS = {
  off: {},
  balanced: { ...TELEMETRY_OFF, FIntDebugForceMSAASamples: 1 },
  max: {
    ...TELEMETRY_OFF,
    FIntDebugForceMSAASamples: 1,
    FFlagDisablePostFx: true,
    FIntRenderShadowIntensity: 0,
    DFFlagDebugRenderForceTechnologyVoxel: true
  },
  lowend: {
    ...TELEMETRY_OFF,
    FIntDebugForceMSAASamples: 1,
    FFlagDisablePostFx: true,
    FIntRenderShadowIntensity: 0,
    DFFlagDebugRenderForceTechnologyVoxel: true,
    FIntFRMMinGrassDistance: 0,
    FIntFRMMaxGrassDistance: 0,
    DFFlagTextureQualityOverride: true,
    DFIntTextureQualityOverride: 0
  }
};

function buildFlags(s) {
  const f = { ...(PRESETS[s.perfPreset] || {}) };
  if (s.fpsCap > 0) f.DFIntTaskSchedulerTargetFps = Number(s.fpsCap);
  if (s.uncapFps) f.FFlagTaskSchedulerLimitTargetFpsTo2402 = false;
  if (s.renderer === 'd3d11') f.FFlagDebugGraphicsPreferD3D11 = true;
  if (s.renderer === 'vulkan') f.FFlagDebugGraphicsPreferVulkan = true;
  if (s.renderer === 'metal') f.FFlagDebugGraphicsPreferMetal = true;
  if (s.textureQuality !== 'auto') {
    f.DFFlagTextureQualityOverride = true;
    f.DFIntTextureQualityOverride = Number(s.textureQuality);
  }
  try { Object.assign(f, JSON.parse(s.customFlags || '{}')); } catch { /* UI validates */ }
  return f;
}

async function copyMods(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name), to = path.join(dest, e.name);
    if (e.isDirectory()) { await fsp.mkdir(to, { recursive: true }); await copyMods(from, to); }
    else if (e.isFile() && !BLOCKED_MOD_EXT.has(path.extname(e.name).toLowerCase())) await fsp.copyFile(from, to);
  }
}

const macBinDir = dir => path.join(dir, 'RobloxPlayer.app', 'Contents', 'MacOS');

async function applySettings(dir, s, modsDir, packsDir) {
  const flagDir = path.join(isMac ? macBinDir(dir) : dir, 'ClientSettings');
  await fsp.mkdir(flagDir, { recursive: true });
  await fsp.writeFile(path.join(flagDir, 'ClientAppSettings.json'), JSON.stringify(buildFlags(s), null, 2));
  const dest = isMac ? path.join(dir, 'RobloxPlayer.app', 'Contents', 'Resources') : dir;
  if (s.useMods) await copyMods(modsDir, dest);
  for (const name of s.enabledPacks || []) await copyMods(path.join(packsDir, name), dest); // same safe copy: no executables
}

/* ---------- launch ---------- */

function launch(dir, uri) {
  if (isWin) {
    const exe = path.join(dir, 'RobloxPlayerBeta.exe');
    spawn(exe, [uri || '--app'], { detached: true, stdio: 'ignore', cwd: dir }).unref();
  } else if (isMac) {
    const args = ['-a', path.join(dir, 'RobloxPlayer.app')];
    if (uri) args.push(uri);
    spawn('/usr/bin/open', args, { detached: true, stdio: 'ignore' }).unref();
  }
}

/* ---------- Windows extras: priority, crash handler, multi-instance, cleaner ---------- */

const psRun = cmd => execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function isRunning() {
  if (!isWin) return false;
  try {
    const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq RobloxPlayerBeta.exe', '/NH'], { windowsHide: true });
    return /RobloxPlayerBeta\.exe/i.test(stdout);
  } catch { return false; }
}

// Roblox refuses a second window when it can create this mutex first, so we hold it
// until the last Roblox process exits (then the helper ends by itself).
function holdMultiInstanceMutex() {
  if (!isWin) return;
  const script = "$m = New-Object System.Threading.Mutex($true,'ROBLOX_singletonMutex'); " +
    "$end = (Get-Date).AddSeconds(90); " +
    "while ((Get-Date) -lt $end -or (Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 3 }";
  spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function tunePriority(level) {
  if (!isWin || level === 'normal') return;
  const cls = level === 'high' ? 'High' : 'AboveNormal';
  for (let i = 0; i < 20; i++) {
    try {
      const { stdout } = await psRun(`$p = Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue; if ($p) { $p | ForEach-Object { $_.PriorityClass = '${cls}' }; 'ok' }`);
      if (stdout.includes('ok')) return;
    } catch { /* retry */ }
    await sleep(2000);
  }
}

async function closeCrashHandler() {
  if (!isWin) return;
  for (let i = 0; i < 15; i++) {
    try { await execFileP('taskkill', ['/F', '/IM', 'RobloxCrashHandler.exe'], { windowsHide: true }); return; }
    catch { await sleep(2500); }
  }
}

async function removeOlderThan(dir, cutoff) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs < cutoff) await fsp.rm(p, { recursive: true, force: true });
    } catch { /* in use, skip */ }
  }
}

async function runCleaner(s, root) {
  const days = { '1d': 1, '7d': 7, '30d': 30 }[s.cleanerSchedule];
  if (!days) return false;
  const cutoff = Date.now() - days * 864e5;
  if (s.cleanCache) await removeOlderThan(path.join(root, 'Downloads'), cutoff);
  if (s.cleanLogs && isWin && process.env.LOCALAPPDATA) await removeOlderThan(path.join(process.env.LOCALAPPDATA, 'Roblox', 'logs'), cutoff);
  return true;
}

/* ---------- Linux: Roblox has no native client, so we drive Sober (Flatpak) ---------- */

const SOBER = 'org.vinegarhq.Sober';

async function soberInstalled() {
  try { await execFileP('flatpak', ['info', SOBER]); return true; } catch { return false; }
}

function installSober() {
  return new Promise((resolve, reject) => {
    const p = spawn('flatpak', ['install', '-y', '--user', 'flathub', SOBER], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', c => (c === 0 ? resolve() : reject(new Error('flatpak install failed. Is Flatpak installed and Flathub added?'))));
  });
}

async function applySoberSettings(s) {
  const file = path.join(process.env.HOME, '.var/app', SOBER, 'config/sober/config.json');
  let cfg = {};
  try { cfg = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* first run */ }
  cfg.fflags = { ...(cfg.fflags || {}), ...buildFlags(s) };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(cfg, null, 2));
}

function launchSober(uri) {
  const args = ['run', SOBER];
  if (uri) args.push(uri);
  spawn('flatpak', args, { detached: true, stdio: 'ignore' }).unref();
}

module.exports = {
  isWin, isMac, isLinux,
  ensureInstalled, applySettings, launch,
  isRunning, holdMultiInstanceMutex, tunePriority, closeCrashHandler, runCleaner,
  soberInstalled, installSober, applySoberSettings, launchSober
};
