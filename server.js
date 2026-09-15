import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import FormData from 'form-data';
import multer from 'multer';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const DATA_DIR = path.join(__dirname, 'data');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOKEN_FILE = path.join(DATA_DIR, 'google-token.json');

await Promise.all([
  fsp.mkdir(DOWNLOAD_DIR, { recursive: true }),
  fsp.mkdir(TMP_DIR, { recursive: true })
]);

const defaults = {
  port: Number(process.env.PORT || 3030),
  octoprintUrl: process.env.OCTOPRINT_URL || 'http://127.0.0.1:5000',
  octoprintApiKey: process.env.OCTOPRINT_API_KEY || '',
  cameraUrl: process.env.OCTOPRINT_CAMERA_URL || '',
  driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3030/oauth2callback'
};

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function getConfig() {
  return { ...defaults, ...(await readJson(CONFIG_FILE, {})) };
}

async function saveConfig(patch) {
  const current = await getConfig();
  const next = { ...current, ...patch };
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

function safeName(name = 'download.gcode') {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._()\- ]/g, '_');
  return base || `download-${Date.now()}.gcode`;
}

async function octoClient() {
  const cfg = await getConfig();
  return axios.create({
    baseURL: cfg.octoprintUrl.replace(/\/$/, ''),
    timeout: 10000,
    headers: cfg.octoprintApiKey ? { 'X-Api-Key': cfg.octoprintApiKey } : {}
  });
}

function apiError(res, error, fallback = 'Noe gikk galt') {
  const status = error?.response?.status || 500;
  const data = error?.response?.data;
  const message = typeof data === 'string'
    ? data
    : data?.error || data?.message || error?.message || fallback;
  res.status(status).json({ error: message, status });
}

async function uploadToOctoPrint(localPath, { select = true, print = false } = {}) {
  const client = await octoClient();
  const form = new FormData();
  form.append('file', createReadStream(localPath));
  if (select) form.append('select', 'true');
  if (print) form.append('print', 'true');

  const response = await client.post('/api/files/local', form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0
  });
  return response.data;
}

async function oauthClient() {
  const cfg = await getConfig();
  if (!cfg.googleClientId || !cfg.googleClientSecret || !cfg.googleRedirectUri) {
    throw new Error('Google Drive er ikke konfigurert ennå. Legg inn Client ID, Client Secret og Redirect URI i Innstillinger.');
  }
  const client = new google.auth.OAuth2(cfg.googleClientId, cfg.googleClientSecret, cfg.googleRedirectUri);
  const tokens = await readJson(TOKEN_FILE, null);
  if (tokens) {
    client.setCredentials(tokens);
    client.on('tokens', async (newTokens) => {
      const old = await readJson(TOKEN_FILE, {});
      await fsp.writeFile(TOKEN_FILE, JSON.stringify({ ...old, ...newTokens }, null, 2));
    });
  }
  return client;
}

async function driveClient() {
  const auth = await oauthClient();
  const creds = auth.credentials;
  if (!creds?.refresh_token && !creds?.access_token) throw new Error('Google Drive er ikke koblet til ennå.');
  return google.drive({ version: 'v3', auth });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 } });

app.get('/api/health', (_req, res) => res.json({ ok: true, name: '3Dprint Control Center' }));

app.get('/api/config', async (_req, res) => {
  const cfg = await getConfig();
  res.json({
    ...cfg,
    octoprintApiKey: cfg.octoprintApiKey ? '••••••••' : '',
    googleClientSecret: cfg.googleClientSecret ? '••••••••' : ''
  });
});

app.post('/api/config', async (req, res) => {
  try {
    const allowed = ['octoprintUrl', 'octoprintApiKey', 'cameraUrl', 'driveFolderId', 'googleClientId', 'googleClientSecret', 'googleRedirectUri'];
    const patch = {};
    for (const key of allowed) {
      if (!(key in req.body)) continue;
      const value = String(req.body[key] ?? '').trim();
      if ((key === 'octoprintApiKey' || key === 'googleClientSecret') && value === '••••••••') continue;
      patch[key] = value;
    }
    const next = await saveConfig(patch);
    res.json({ ok: true, config: { ...next, octoprintApiKey: next.octoprintApiKey ? '••••••••' : '', googleClientSecret: next.googleClientSecret ? '••••••••' : '' } });
  } catch (error) {
    apiError(res, error);
  }
});

app.get('/api/octoprint/status', async (_req, res) => {
  try {
    const client = await octoClient();
    const [printerResult, jobResult, connectionResult] = await Promise.allSettled([
      client.get('/api/printer'),
      client.get('/api/job'),
      client.get('/api/connection')
    ]);

    if (connectionResult.status === 'rejected') throw connectionResult.reason;
    const printer = printerResult.status === 'fulfilled' ? printerResult.value.data : { state: { text: 'Offline' }, temperature: {} };
    const job = jobResult.status === 'fulfilled' ? jobResult.value.data : { state: 'Offline', job: {}, progress: {} };
    const connection = connectionResult.value.data;
    res.json({ printer, job, connection });
  } catch (error) {
    apiError(res, error, 'Får ikke kontakt med OctoPrint');
  }
});

app.get('/api/octoprint/files', async (_req, res) => {
  try {
    const client = await octoClient();
    const response = await client.get('/api/files/local', { params: { recursive: true } });
    res.json(response.data);
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/job', async (req, res) => {
  try {
    const { command, action } = req.body;
    const allowed = new Set(['start', 'pause', 'cancel', 'restart']);
    if (!allowed.has(command)) return res.status(400).json({ error: 'Ugyldig jobbkommando' });
    const body = { command };
    if (command === 'pause' && action) body.action = action;
    const client = await octoClient();
    await client.post('/api/job', body);
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/print', async (req, res) => {
  try {
    const filePath = String(req.body.path || '');
    if (!filePath) return res.status(400).json({ error: 'Mangler filsti' });
    const client = await octoClient();
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    await client.post(`/api/files/local/${encodedPath}`, { command: 'select', print: true });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/connect', async (req, res) => {
  try {
    const command = req.body.command === 'disconnect' ? 'disconnect' : 'connect';
    const client = await octoClient();
    await client.post('/api/connection', { command });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/home', async (req, res) => {
  try {
    const axes = Array.isArray(req.body.axes) ? req.body.axes.filter(a => ['x', 'y', 'z'].includes(a)) : ['x', 'y', 'z'];
    const client = await octoClient();
    await client.post('/api/printer/printhead', { command: 'home', axes });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/jog', async (req, res) => {
  try {
    const move = { command: 'jog', absolute: false };
    for (const axis of ['x', 'y', 'z']) {
      if (Number.isFinite(Number(req.body[axis]))) move[axis] = Number(req.body[axis]);
    }
    if (Number.isFinite(Number(req.body.speed))) move.speed = Number(req.body.speed);
    const client = await octoClient();
    await client.post('/api/printer/printhead', move);
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/tool-temp', async (req, res) => {
  try {
    const target = Math.max(0, Math.min(300, Number(req.body.target)));
    const client = await octoClient();
    await client.post('/api/printer/tool', { command: 'target', targets: { tool0: target } });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/bed-temp', async (req, res) => {
  try {
    const target = Math.max(0, Math.min(130, Number(req.body.target)));
    const client = await octoClient();
    await client.post('/api/printer/bed', { command: 'target', target });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/extrude', async (req, res) => {
  try {
    const amount = Math.max(-100, Math.min(100, Number(req.body.amount)));
    const client = await octoClient();
    await client.post('/api/printer/tool', { command: 'extrude', amount });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/fan', async (req, res) => {
  try {
    const percent = Math.max(0, Math.min(100, Number(req.body.percent)));
    const pwm = Math.round(percent * 2.55);
    const client = await octoClient();
    await client.post('/api/printer/command', { command: percent <= 0 ? 'M107' : `M106 S${pwm}` });
    res.json({ ok: true, percent, pwm });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/command', async (req, res) => {
  try {
    const command = String(req.body.command || '').trim();
    if (!command) return res.status(400).json({ error: 'Tom kommando' });
    const client = await octoClient();
    await client.post('/api/printer/command', { command });
    res.json({ ok: true, command });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/octoprint/emergency-stop', async (_req, res) => {
  try {
    const client = await octoClient();
    await client.post('/api/printer/command', { command: 'M112' });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.get('/api/drive/status', async (_req, res) => {
  const cfg = await getConfig();
  const token = await readJson(TOKEN_FILE, null);
  res.json({
    configured: Boolean(cfg.googleClientId && cfg.googleClientSecret && cfg.driveFolderId),
    connected: Boolean(token?.refresh_token || token?.access_token),
    folderConfigured: Boolean(cfg.driveFolderId)
  });
});

app.get('/api/drive/auth/url', async (_req, res) => {
  try {
    const auth = await oauthClient();
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/drive.readonly']
    });
    res.json({ url });
  } catch (error) {
    apiError(res, error);
  }
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    if (!code) throw new Error('Google returnerte ingen autorisasjonskode.');
    const auth = await oauthClient();
    const { tokens } = await auth.getToken(code);
    await fsp.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    res.send(`<!doctype html><html><body style="font-family:system-ui;background:#0b0f14;color:#fff;padding:40px"><h1>Google Drive er koblet til ✓</h1><p>Du kan lukke denne fanen og gå tilbake til 3Dprint.</p><script>setTimeout(()=>window.close(),1800)</script></body></html>`);
  } catch (error) {
    res.status(500).send(`Google-tilkoblingen feilet: ${error.message}`);
  }
});

app.post('/api/drive/disconnect', async (_req, res) => {
  await fsp.rm(TOKEN_FILE, { force: true });
  res.json({ ok: true });
});

app.get('/api/drive/files', async (_req, res) => {
  try {
    const cfg = await getConfig();
    if (!cfg.driveFolderId) return res.status(400).json({ error: 'Google Drive Folder ID mangler i Innstillinger.' });
    const drive = await driveClient();
    const response = await drive.files.list({
      q: `'${cfg.driveFolderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)',
      orderBy: 'modifiedTime desc',
      pageSize: 200
    });
    res.json({ files: response.data.files || [] });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/drive/download', async (req, res) => {
  try {
    const id = String(req.body.id || '');
    if (!id) return res.status(400).json({ error: 'Mangler Google Drive fil-ID' });
    const drive = await driveClient();
    const meta = await drive.files.get({ fileId: id, fields: 'id,name,size,mimeType,modifiedTime' });
    const name = safeName(meta.data.name);
    const localPath = path.join(DOWNLOAD_DIR, name);
    const media = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
    await pipeline(media.data, createWriteStream(localPath));

    let octoprint = null;
    const printable = /\.(gcode|gco|gc)$/i.test(name);
    if (printable && req.body.sendToOctoprint !== false) {
      octoprint = await uploadToOctoPrint(localPath, { select: true, print: false });
    }
    const stat = await fsp.stat(localPath);
    res.json({ ok: true, file: { name, size: stat.size, printable }, octoprint });
  } catch (error) {
    apiError(res, error);
  }
});

app.get('/api/local/files', async (_req, res) => {
  try {
    const names = await fsp.readdir(DOWNLOAD_DIR);
    const files = await Promise.all(names.filter(name => name !== '.gitkeep').map(async (name) => {
      const stat = await fsp.stat(path.join(DOWNLOAD_DIR, name));
      return { name, size: stat.size, modifiedTime: stat.mtime.toISOString(), printable: /\.(gcode|gco|gc)$/i.test(name) };
    }));
    files.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
    res.json({ files });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/local/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ingen fil mottatt' });
    const name = safeName(req.file.originalname);
    const target = path.join(DOWNLOAD_DIR, name);
    await fsp.rm(target, { force: true });
    await fsp.rename(req.file.path, target);
    let octoprint = null;
    if (/\.(gcode|gco|gc)$/i.test(name)) octoprint = await uploadToOctoPrint(target, { select: true, print: false });
    res.json({ ok: true, name, octoprint });
  } catch (error) {
    apiError(res, error);
  }
});

app.post('/api/local/send', async (req, res) => {
  try {
    const name = safeName(req.body.name || '');
    const localPath = path.join(DOWNLOAD_DIR, name);
    if (!fs.existsSync(localPath)) return res.status(404).json({ error: 'Filen finnes ikke lokalt' });
    const result = await uploadToOctoPrint(localPath, { select: true, print: Boolean(req.body.print) });
    res.json({ ok: true, octoprint: result });
  } catch (error) {
    apiError(res, error);
  }
});

app.delete('/api/local/files/:name', async (req, res) => {
  try {
    const name = safeName(req.params.name);
    await fsp.rm(path.join(DOWNLOAD_DIR, name), { force: true });
    res.json({ ok: true });
  } catch (error) {
    apiError(res, error);
  }
});

app.get('/api/camera/stream', async (_req, res) => {
  try {
    const cfg = await getConfig();
    const url = cfg.cameraUrl || `${cfg.octoprintUrl.replace(/\/$/, '')}/webcam/?action=stream`;
    const response = await axios.get(url, { responseType: 'stream', timeout: 0 });
    res.status(response.status);
    for (const [key, value] of Object.entries(response.headers)) {
      if (['content-type', 'cache-control', 'pragma'].includes(key.toLowerCase()) && value) res.setHeader(key, value);
    }
    response.data.on('error', () => res.end());
    response.data.pipe(res);
  } catch {
    if (!res.headersSent) res.status(503).json({ error: 'Kamera er ikke tilgjengelig ennå.' });
  }
});

app.get('/api/camera/snapshot', async (_req, res) => {
  try {
    const cfg = await getConfig();
    const streamUrl = cfg.cameraUrl || `${cfg.octoprintUrl.replace(/\/$/, '')}/webcam/?action=snapshot`;
    const url = streamUrl.includes('action=stream') ? streamUrl.replace('action=stream', 'action=snapshot') : streamUrl;
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.send(Buffer.from(response.data));
  } catch {
    res.status(503).json({ error: 'Snapshot er ikke tilgjengelig.' });
  }
});

app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const cfg = await getConfig();
app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`\n3Dprint Control Center kjører på http://localhost:${cfg.port}`);
  console.log(`Åpne den fra andre enheter på nettverket med http://<DENNE-PC-ENS-IP>:${cfg.port}\n`);
});
