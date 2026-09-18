const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];

const state = { jogStep: 10, lastStatus: null, cameraLoaded: false };

const titles = {
  dashboard: ['CR-10S PRO', 'Oversikt'], files: ['FILBIBLIOTEK', 'Filer'], control: ['MANUELL STYRING', 'Kontroll'],
  camera: ['OVERVÅKING', 'Kamera'], terminal: ['AVANSERT', 'Terminal'], settings: ['SYSTEM', 'Innstillinger']
};

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = 'toast', 3200);
}

async function api(url, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
  return data;
}

function navigate(view) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $('#pageEyebrow').textContent = titles[view][0];
  $('#pageTitle').textContent = titles[view][1];
  if (view === 'files') { loadDriveFiles(); loadLocalFiles(); }
  if (view === 'camera') loadCamera(true);
}

$$('.nav-btn').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.view)));
$$('[data-view-jump]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.viewJump)));

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}t ${String(m).padStart(2, '0')}m` : `${m} min`;
}
function bytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}
function dateText(value) {
  if (!value) return '—';
  try { return new Intl.DateTimeFormat('no-NO', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
  catch { return value; }
}
function fileExt(name = '') { return name.split('.').pop()?.toUpperCase() || 'FIL'; }

async function refreshStatus(silent = false) {
  try {
    const data = await api('/api/octoprint/status');
    state.lastStatus = data;
    renderStatus(data);
    $('#octoDot').parentElement.classList.add('online');
    $('#octoText').textContent = 'OctoPrint online';
  } catch (err) {
    $('#octoDot').parentElement.classList.remove('online');
    $('#octoText').textContent = 'OctoPrint frakoblet';
    $('#connectionState').textContent = 'OFFLINE';
    if (!silent) toast(err.message, true);
  }
}

function renderStatus(data) {
  const job = data.job || {};
  const printer = data.printer || {};
  const connection = data.connection || {};
  const progress = Math.max(0, Math.min(100, Number(job.progress?.completion || 0)));
  $('#progressRing').style.setProperty('--p', progress);
  $('#progressText').textContent = `${Math.round(progress)}%`;
  $('#jobName').textContent = job.job?.file?.display || job.job?.file?.name || 'Ingen jobb valgt';
  $('#jobMeta').textContent = job.job?.file?.origin ? `Kilde: ${job.job.file.origin}` : 'Velg en G-code-fil for å starte.';
  $('#timeUsed').textContent = formatTime(job.progress?.printTime);
  $('#timeLeft').textContent = formatTime(job.progress?.printTimeLeft);
  $('#printerState').textContent = job.state || printer.state?.text || 'Ukjent';

  const tool = printer.temperature?.tool0 || {};
  const bed = printer.temperature?.bed || {};
  $('#toolActual').textContent = $('#toolActual2').textContent = Number.isFinite(tool.actual) ? Math.round(tool.actual) : '—';
  $('#toolTarget').textContent = Number.isFinite(tool.target) ? Math.round(tool.target) : '—';
  $('#bedActual').textContent = $('#bedActual2').textContent = Number.isFinite(bed.actual) ? Math.round(bed.actual) : '—';
  $('#bedTarget').textContent = Number.isFinite(bed.target) ? Math.round(bed.target) : '—';

  const current = connection.current || {};
  $('#connectionState').textContent = current.state || 'Ukjent';
  $('#connectionPort').textContent = [current.port, current.baudrate].filter(Boolean).join(' · ') || 'Ingen port';
  $('#selectedFileMini').textContent = (job.job?.file?.display || job.job?.file?.name || 'INGEN').slice(0, 22);
  $('#fileSizeMini').textContent = bytes(job.job?.file?.size);

  const paused = String(job.state || '').toLowerCase().includes('paused');
  $('#pauseJobBtn').textContent = paused ? '▶ Fortsett' : 'Ⅱ Pause';
  $('#pauseJobBtn').dataset.paused = paused ? '1' : '0';
}

$('#refreshBtn').addEventListener('click', () => { refreshStatus(); loadLocalFiles(); });
$('#startJobBtn').addEventListener('click', async () => {
  try { await api('/api/octoprint/job', { method: 'POST', body: { command: 'start' } }); toast('Print startet'); refreshStatus(true); }
  catch (e) { toast(e.message, true); }
});
$('#pauseJobBtn').addEventListener('click', async (e) => {
  try {
    const action = e.currentTarget.dataset.paused === '1' ? 'resume' : 'pause';
    await api('/api/octoprint/job', { method: 'POST', body: { command: 'pause', action } });
    toast(action === 'pause' ? 'Print pauset' : 'Print fortsetter'); refreshStatus(true);
  } catch (err) { toast(err.message, true); }
});
$('#cancelJobBtn').addEventListener('click', () => confirmAction('Avbryt print?', 'Jobben stoppes med en gang, temperaturventing brytes og varme slås av.', async () => {
  await api('/api/octoprint/job', { method: 'POST', body: { command: 'cancel' } }); toast('Print avbrutt · varme slått av'); refreshStatus(true);
}));
$('#emergencyBtn').addEventListener('click', () => confirmAction('NØDSTOPP?', 'Dette sender M112 til printeren. Bruk kun ved en reell nødsituasjon.', async () => {
  await api('/api/octoprint/emergency-stop', { method: 'POST' }); toast('Nødstopp sendt');
}));

function confirmAction(title, text, fn) {
  const dialog = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  dialog.showModal();
  dialog.addEventListener('close', async function handler() {
    dialog.removeEventListener('close', handler);
    if (dialog.returnValue === 'confirm') {
      try { await fn(); } catch (e) { toast(e.message, true); }
    }
  });
}

async function home(axes) {
  try { await api('/api/octoprint/home', { method: 'POST', body: { axes: axes === 'xyz' ? ['x','y','z'] : axes.split('') } }); toast(`Home ${axes.toUpperCase()} sendt`); }
  catch (e) { toast(e.message, true); }
}
$$('[data-home]').forEach(btn => btn.addEventListener('click', () => home(btn.dataset.home)));

$('#jogStep').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-step]'); if (!btn) return;
  state.jogStep = Number(btn.dataset.step);
  $$('#jogStep [data-step]').forEach(b => b.classList.toggle('active', b === btn));
});
$$('[data-jog]').forEach(btn => btn.addEventListener('click', async () => {
  const dir = btn.dataset.jog; const axis = dir[0]; const sign = dir[1] === '+' ? 1 : -1;
  try { await api('/api/octoprint/jog', { method:'POST', body:{ [axis]: state.jogStep * sign } }); }
  catch (e) { toast(e.message, true); }
}));

async function setTemp(tool, target) {
  try {
    await api(tool === 'tool' ? '/api/octoprint/tool-temp' : '/api/octoprint/bed-temp', { method:'POST', body:{ target } });
    toast(`${tool === 'tool' ? 'Dyse' : 'Byggeplate'} satt til ${target}°C`); refreshStatus(true);
  } catch (e) { toast(e.message, true); }
}
$('#setToolTemp').addEventListener('click', () => setTemp('tool', Number($('#toolTempInput').value)));
$('#setBedTemp').addEventListener('click', () => setTemp('bed', Number($('#bedTempInput').value)));
$$('[data-preheat]').forEach(btn => btn.addEventListener('click', async () => {
  const petg = btn.dataset.preheat === 'petg';
  await Promise.all([setTemp('tool', petg ? 240 : 210), setTemp('bed', petg ? 80 : 60)]);
}));
$$('[data-cooldown]').forEach(btn => btn.addEventListener('click', async () => {
  await Promise.all([setTemp('tool', 0), setTemp('bed', 0)]); toast('Kjøler ned printeren');
}));

$$('[data-extrude]').forEach(btn => btn.addEventListener('click', async () => {
  try { await api('/api/octoprint/extrude', { method:'POST', body:{ amount:Number(btn.dataset.extrude) } }); toast(`${btn.dataset.extrude} mm ekstruder sendt`); }
  catch (e) { toast(e.message, true); }
}));

let fanDebounce;
function fan(percent) {
  $('#fanSlider').value = percent; $('#fanValue').textContent = `${percent}%`;
  clearTimeout(fanDebounce); fanDebounce = setTimeout(async () => {
    try { await api('/api/octoprint/fan', { method:'POST', body:{ percent:Number(percent) } }); }
    catch (e) { toast(e.message, true); }
  }, 160);
}
$('#fanSlider').addEventListener('input', e => fan(e.target.value));
$$('[data-fan]').forEach(btn => btn.addEventListener('click', () => fan(btn.dataset.fan)));

async function loadDriveStatus() {
  try {
    const s = await api('/api/drive/status');
    $('#driveStatusText').textContent = s.connected ? 'Tilkoblet' : s.configured ? 'Klar for tilkobling' : 'Må konfigureres';
    $('#driveConnectBtn').textContent = s.connected ? 'Drive tilkoblet ✓' : 'Koble til Drive';
    return s;
  } catch { return null; }
}

async function loadDriveFiles() {
  const s = await loadDriveStatus();
  const body = $('#driveFilesBody');
  if (!s?.connected) { body.innerHTML = '<tr><td colspan="4" class="muted-cell">Koble til Google Drive for å hente filer.</td></tr>'; return; }
  body.innerHTML = '<tr><td colspan="4" class="muted-cell">Henter filer…</td></tr>';
  try {
    const data = await api('/api/drive/files');
    const files = data.files || [];
    if (!files.length) { body.innerHTML = '<tr><td colspan="4" class="muted-cell">Ingen filer i Drive-mappen.</td></tr>'; return; }
    body.innerHTML = files.map(f => {
      const printable = /\.(gcode|gco|gc)$/i.test(f.name);
      return `<tr><td><div class="file-name"><span class="file-badge">${fileExt(f.name)}</span><span>${escapeHtml(f.name)}</span></div></td><td>${dateText(f.modifiedTime)}</td><td>${bytes(f.size)}</td><td><button class="file-action" data-drive-download="${f.id}" data-name="${escapeAttr(f.name)}">${printable ? '↓ Klargjør lokalt' : '↓ Last ned'}</button></td></tr>`;
    }).join('');
  } catch (e) { body.innerHTML = `<tr><td colspan="4" class="muted-cell">${escapeHtml(e.message)}</td></tr>`; }
}

$('#driveFilesBody').addEventListener('click', async e => {
  const btn = e.target.closest('[data-drive-download]'); if (!btn) return;
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Laster…';
  try {
    const result = await api('/api/drive/download', { method:'POST', body:{ id:btn.dataset.driveDownload, sendToOctoprint:false } });
    toast(`${result.file.name} er lastet ned til printer-PC-en`);
    await loadLocalFiles();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = old; }
});

$('#driveConnectBtn').addEventListener('click', async () => {
  try { const { url } = await api('/api/drive/auth/url'); window.open(url, '_blank', 'noopener'); toast('Fullfør Google-innloggingen i den nye fanen.'); }
  catch (e) { toast(e.message, true); navigate('settings'); }
});
$('#reloadDriveBtn').addEventListener('click', loadDriveFiles);

async function loadLocalFiles() {
  try {
    const data = await api('/api/local/files'); const files = data.files || [];
    $('#localFiles').innerHTML = files.length ? files.map(f => `<div class="local-item"><div class="local-item-head"><div><strong>${escapeHtml(f.name)}</strong><small>${dateText(f.modifiedTime)} · ${bytes(f.size)}</small></div><span class="file-badge">${fileExt(f.name)}</span></div><div class="local-item-actions">${f.printable ? `<button class="file-action" data-local-send="${escapeAttr(f.name)}">Send til OctoPrint</button><button class="file-action" data-local-print="${escapeAttr(f.name)}">Start print</button>` : ''}<button class="file-action" data-local-delete="${escapeAttr(f.name)}">Slett</button></div></div>`).join('') : '<div class="empty-state">Ingen filer lastet ned ennå.</div>';
    $('#recentFiles').innerHTML = files.slice(0,4).map(f => `<div class="file-row-mini"><span>${escapeHtml(f.name)}</span><span>${bytes(f.size)}</span></div>`).join('') || '<div class="empty-line">Ingen lokale filer ennå.</div>';
  } catch (e) { console.warn(e); }
}

$('#localFiles').addEventListener('click', async e => {
  const send = e.target.closest('[data-local-send]'); const print = e.target.closest('[data-local-print]'); const del = e.target.closest('[data-local-delete]');
  try {
    if (send || print) {
      const name = (send || print).dataset.localSend || (send || print).dataset.localPrint;
      await api('/api/local/send', { method:'POST', body:{ name, print:Boolean(print) } });
      toast(print ? `Print startet: ${name}` : `${name} sendt til OctoPrint`); refreshStatus(true);
    }
    if (del) { await api(`/api/local/files/${encodeURIComponent(del.dataset.localDelete)}`, { method:'DELETE' }); toast('Lokal fil slettet'); loadLocalFiles(); }
  } catch (err) { toast(err.message, true); }
});
$('#reloadLocalBtn').addEventListener('click', loadLocalFiles);

const dz = $('#dropZone'); const fileInput = $('#localUpload');
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) uploadLocal(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => fileInput.files[0] && uploadLocal(fileInput.files[0]));
async function uploadLocal(file) {
  const form = new FormData(); form.append('file', file);
  try { toast(`Laster opp ${file.name}…`); await api('/api/local/upload', { method:'POST', body:form }); toast(`${file.name} er klar`); loadLocalFiles(); refreshStatus(true); }
  catch (e) { toast(e.message, true); }
}

function loadCamera(force = false) {
  const stamp = force ? `?t=${Date.now()}` : '';
  for (const [imgSel, emptySel] of [['#cameraPreview','#cameraEmpty'],['#cameraLarge','#cameraLargeEmpty']]) {
    const img = $(imgSel); const empty = $(emptySel);
    img.onload = () => { img.classList.add('ready'); empty.style.display = 'none'; state.cameraLoaded = true; };
    img.onerror = () => { img.classList.remove('ready'); empty.style.display = ''; };
    if (force || !img.src) img.src = `/api/camera/stream${stamp}`;
  }
}
$('#reloadCameraBtn').addEventListener('click', () => loadCamera(true));
$('#fullscreenCameraBtn').addEventListener('click', () => $('#cameraLarge').requestFullscreen?.());
$$('[data-open-camera]').forEach(btn => btn.addEventListener('click', () => navigate('camera')));

$('#terminalForm').addEventListener('submit', async e => {
  e.preventDefault(); const input = $('#terminalCommand'); const command = input.value.trim(); if (!command) return;
  terminalLine(`> ${command}`); input.value = '';
  try { await api('/api/octoprint/command', { method:'POST', body:{ command } }); terminalLine('✓ sendt', 'dim'); }
  catch (err) { terminalLine(`Feil: ${err.message}`, 'error'); }
});
$('#clearTerminalBtn').addEventListener('click', () => $('#terminalOutput').innerHTML = '');
function terminalLine(text, cls = '') { const el = document.createElement('div'); el.className = `terminal-line ${cls}`; el.textContent = text; $('#terminalOutput').append(el); $('#terminalOutput').scrollTop = $('#terminalOutput').scrollHeight; }

async function loadSettings() {
  try {
    const c = await api('/api/config');
    $('#cfgOctoUrl').value = c.octoprintUrl || '';
    $('#cfgOctoKey').value = c.octoprintApiKey || '';
    $('#cfgCameraUrl').value = c.cameraUrl || '';
    $('#cfgDriveFolder').value = c.driveFolderId || '';
    $('#cfgGoogleClientId').value = c.googleClientId || '';
    $('#cfgGoogleSecret').value = c.googleClientSecret || '';
    $('#cfgGoogleRedirect').value = c.googleRedirectUri || '';
  } catch (e) { toast(e.message, true); }
}
$('#saveSettingsBtn').addEventListener('click', async () => {
  const body = {
    octoprintUrl: $('#cfgOctoUrl').value, octoprintApiKey: $('#cfgOctoKey').value, cameraUrl: $('#cfgCameraUrl').value,
    driveFolderId: $('#cfgDriveFolder').value, googleClientId: $('#cfgGoogleClientId').value,
    googleClientSecret: $('#cfgGoogleSecret').value, googleRedirectUri: $('#cfgGoogleRedirect').value
  };
  try { await api('/api/config', { method:'POST', body }); toast('Innstillingene er lagret'); await loadDriveStatus(); await refreshStatus(true); loadCamera(true); }
  catch (e) { toast(e.message, true); }
});
$('#testOctoBtn').addEventListener('click', async () => { try { await refreshStatus(); toast('OctoPrint svarer ✓'); } catch {} });

function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function escapeAttr(s='') { return escapeHtml(s); }

loadSettings(); loadDriveStatus(); loadLocalFiles(); refreshStatus(true); loadCamera(false);
setInterval(() => refreshStatus(true), 2500);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(() => {});