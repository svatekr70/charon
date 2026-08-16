'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const posix = path.posix;

const { SftpAdapter } = require('./adapters/sftp');
const { FtpAdapter } = require('./adapters/ftp');
const { SiteStore } = require('./sites');
const { TransferQueue } = require('./queue');
const { EditWatcher } = require('./editor-watch');
const { compare } = require('./sync');
const { parseWinscpFile } = require('./winscp-import');
const hostkeys = require('./hostkeys');
const { RemoteTrash } = require('./trash');
const prompts = require('./prompts');

let win = null;
let sites = null;
let queue = null;
let editWatcher = null;
let settings = { editor: '', localDir: os.homedir() };

const conn = {
  browse: null,     // spojení pro procházení adresářů
  transfer: null,   // oddělené spojení pro přenosy, aby procházení neblokovalo
  config: null,
  home: '/',
  status: 'disconnected',
};

// ---------------------------------------------------------------- pomocné

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function log(level, text) {
  send('log', { level, text, at: Date.now() });
}

function makeAdapter(protocol) {
  return protocol === 'ftp' ? new FtpAdapter() : new SftpAdapter();
}

function requireBrowse() {
  if (!conn.browse || conn.status !== 'connected') throw new Error('Nejste připojeni');
  return conn.browse;
}

/** Druhé spojení otevřeme až když je poprvé potřeba. */
async function getTransferAdapter() {
  if (!conn.config) throw new Error('Nejste připojeni');
  if (conn.transfer && conn.transfer.connected) return conn.transfer;
  const a = makeAdapter(conn.config.protocol);
  // Otisky jsou v conn.config už potvrzené z prvního spojení, takže se
  // uživatele neptáme podruhé — jen zkontrolujeme, že sedí. Když ne,
  // druhé spojení se neotevře; ptát se tady znovu by bylo matoucí.
  const hooks = conn.config.protocol === 'ftp'
    ? { verifyCertificate: () => false }
    : { verifyHostKey: makeHostKeyHook(conn.config).hook };
  await a.connect(conn.config, hooks);
  conn.transfer = a;
  return a;
}

// ------------------------------------------------- ověření identity serveru

/**
 * Hook pro adaptér: klíč přijme jen tehdy, když ho už známe. Jinak spojení
 * odmítne a v `state.seen` nechá popis toho, co server poslal, aby se
 * volající mohl uživatele zeptat a zkusit to znovu.
 */
function makeHostKeyHook(cfg) {
  const state = { seen: null };
  state.hook = ({ keyBuffer }) => {
    state.seen = hostkeys.classify(keyBuffer, {
      host: cfg.host,
      port: Number(cfg.port) || 22,
      storedFingerprint: cfg.hostKeyFingerprint,
    });
    return state.seen.verdict === 'trusted';
  };
  return state;
}

/**
 * Zeptá se na neznámý nebo změněný klíč. Používáme nativní dialog schválně —
 * jde o bezpečnostní rozhodnutí a obsah okna aplikace ho nemá jak ovlivnit.
 */
async function askAboutHostKey(info, cfg) {
  const where = `${cfg.host}:${Number(cfg.port) || 22}`;

  if (info.verdict === 'revoked') {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Odvolaný klíč serveru',
      message: `Klíč serveru ${where} je v known_hosts označen jako odvolaný.`,
      detail: `Otisk: ${info.fingerprint}\n\nPřipojení bylo zrušeno.`,
      buttons: ['Rozumím'],
    });
    return { accept: false, reason: 'Klíč serveru je označen jako odvolaný' };
  }

  if (info.verdict === 'mismatch') {
    const res = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Klíč serveru se změnil',
      message: `Server ${where} se hlásí jiným klíčem, než jaký je uložený.`,
      detail: `Uložený otisk (zdroj: ${info.knownFrom}):\n${info.expected}\n\n`
        + `Nový otisk (${info.type}):\n${info.fingerprint}\n\n`
        + 'Server mohl být přeinstalován — nebo se za něj někdo vydává a čte, '
        + 'co mu posíláte. Pokračujte jen tehdy, když změnu čekáte a nový otisk '
        + 'jste si ověřili jinou cestou než tímto spojením.',
      buttons: ['Zrušit připojení', 'Přesto připojit a přepsat otisk'],
      defaultId: 0,
      cancelId: 0,
    });
    return res.response === 1
      ? { accept: true, remember: true }
      : { accept: false, reason: 'Klíč serveru se změnil — připojení zrušeno' };
  }

  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Neznámý server',
    message: `K serveru ${where} se připojujete poprvé.`,
    detail: `Otisk klíče (${info.type}):\n${info.fingerprint}\n\n`
      + 'Ověřte si ho u správce serveru, nebo z jiného počítače příkazem:\n'
      + `ssh-keyscan -p ${Number(cfg.port) || 22} ${cfg.host} | ssh-keygen -lf -\n\n`
      + 'Když si otisk zapamatujeme, upozorníme vás, kdyby se příště změnil.',
    buttons: ['Zrušit', 'Připojit jednorázově', 'Připojit a zapamatovat'],
    defaultId: 2,
    cancelId: 0,
  });
  if (res.response === 0) return { accept: false, reason: 'Klíč serveru nebyl potvrzen' };
  return { accept: true, remember: res.response === 2 };
}

// -------------------------------------------------- ověření TLS certifikátu

/** Datum z certifikátu čitelně; formát z OpenSSL je anglický a matoucí. */
function certDate(value) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value || '(neuvedeno)';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function certDetail(info) {
  const c = info.info;
  return `Vystaven pro: ${c.subject}\n`
    + `Vydal:        ${c.issuer}\n`
    + `Platnost:     ${certDate(c.validFrom)} – ${certDate(c.validTo)}\n\n`
    + `Otisk SHA-256:\n${info.fingerprint}`;
}

async function askAboutCertificate(info, cfg) {
  const where = `${cfg.host}:${Number(cfg.port) || 21}`;

  if (info.verdict === 'mismatch') {
    const res = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Certifikát serveru se změnil',
      message: `Server ${where} předložil jiný certifikát, než jaký je uložený.`,
      detail: `Uložený otisk:\n${info.expected}\n\n${certDetail(info)}\n\n`
        + `${info.reason}\n\n`
        + 'Certifikátu navíc nevěří ani systém, takže obnovu u autority to nevysvětluje. '
        + 'Pokračujte jen tehdy, když změnu čekáte a nový otisk máte ověřený jinou cestou.',
      buttons: ['Zrušit připojení', 'Přesto připojit a přepsat otisk'],
      defaultId: 0,
      cancelId: 0,
    });
    return res.response === 1
      ? { accept: true, remember: true }
      : { accept: false, reason: 'Certifikát serveru se změnil — připojení zrušeno' };
  }

  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Nedůvěryhodný certifikát',
    message: `Certifikátu serveru ${where} nelze automaticky věřit.`,
    detail: `${info.reason}\n\n${certDetail(info)}\n\n`
      + 'Otisk si ověřte u správce serveru, nebo z jiného počítače příkazem:\n'
      + `openssl s_client -connect ${cfg.host}:${Number(cfg.port) || 21} -starttls ftp `
      + '| openssl x509 -noout -fingerprint -sha256\n\n'
      + 'Když si otisk zapamatujeme, upozorníme vás, kdyby se příště změnil.',
    buttons: ['Zrušit', 'Připojit jednorázově', 'Připojit a zapamatovat'],
    defaultId: 2,
    cancelId: 0,
  });
  if (res.response === 0) return { accept: false, reason: 'Certifikát serveru nebyl potvrzen' };
  return { accept: true, remember: res.response === 2 };
}

/**
 * Připojení s ověřením identity serveru — u SFTP klíčem, u FTPS certifikátem.
 *
 * Když je otisk neznámý, první pokus se odmítne, zeptáme se a připojíme znovu.
 * Dotaz se tím nepočítá do časového limitu handshaku a uživatel má na
 * rozmyšlenou, kolik potřebuje.
 */
async function connectVerified(cfg, siteId) {
  let effective = cfg;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const adapter = makeAdapter(effective.protocol);
    const isFtp = effective.protocol === 'ftp';
    const hostKey = isFtp ? null : makeHostKeyHook(effective);
    const cert = { seen: null };

    const hooks = isFtp
      ? { verifyCertificate: (info) => { cert.seen = info; return false; } }
      : { verifyHostKey: hostKey.hook };

    try {
      await adapter.connect(effective, hooks);
      return { adapter, config: effective };
    } catch (err) {
      await adapter.disconnect().catch(() => {});
      if (attempt > 0) throw err;

      if (err.hostKeyRejected && hostKey && hostKey.seen) {
        const decision = await askAboutHostKey(hostKey.seen, effective);
        if (!decision.accept) throw Object.assign(new Error(decision.reason), { hostKeyRejected: true });
        effective = { ...effective, hostKeyFingerprint: hostKey.seen.fingerprint };
        if (decision.remember && siteId) await sites.setHostKey(siteId, hostKey.seen.fingerprint);
        continue;
      }

      if (err.certRejected && cert.seen) {
        const decision = await askAboutCertificate(cert.seen, effective);
        if (!decision.accept) throw Object.assign(new Error(decision.reason), { certRejected: true });
        effective = { ...effective, tlsFingerprint: cert.seen.fingerprint };
        if (decision.remember && siteId) await sites.setTlsFingerprint(siteId, cert.seen.fingerprint);
        continue;
      }

      throw err;
    }
  }
  throw new Error('Připojení selhalo');
}

// ------------------------------------------------------------ vzdálený koš

/** Koš pro aktuální spojení, nebo null když je u relace vypnutý. */
function getTrash(adapter = conn.browse) {
  if (!conn.config || !conn.config.useRecycleBin || !adapter) return null;
  const base = conn.config.recycleBinPath || RemoteTrash.defaultPath(conn.home);
  return new RemoteTrash(adapter, base);
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(await fsp.readFile(settingsPath(), 'utf8')) };
  } catch { /* první spuštění */ }
}

async function saveSettings() {
  await fsp.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fsp.writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

// -------------------------------------------------- rekurzivní rozbalení

/** Rozbalí adresáře na jednotlivé soubory, aby fronta pracovala se soubory. */
async function expandLocal(localPath, remoteBase, out = []) {
  const st = await fsp.stat(localPath);
  if (st.isFile()) {
    out.push({ direction: 'up', localPath, remotePath: remoteBase, size: st.size });
    return out;
  }
  if (!st.isDirectory()) return out;
  const entries = await fsp.readdir(localPath, { withFileTypes: true });
  if (entries.length === 0) {
    out.push({ direction: 'mkdirRemote', remotePath: remoteBase });
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    await expandLocal(path.join(localPath, e.name), posix.join(remoteBase, e.name), out);
  }
  return out;
}

async function expandRemote(adapter, remotePath, localBase, out = []) {
  let entries;
  try {
    entries = await adapter.list(remotePath);
  } catch {
    // Není adresář — bereme jako soubor.
    const st = await adapter.stat(remotePath);
    out.push({ direction: 'down', remotePath, localPath: localBase, size: st.size });
    return out;
  }
  await fsp.mkdir(localBase, { recursive: true });
  for (const e of entries) {
    if (e.name === '.' || e.name === '..' || e.type === 'l') continue;
    const r = posix.join(remotePath, e.name);
    const l = path.join(localBase, e.name);
    if (e.type === 'd') await expandRemote(adapter, r, l, out);
    else out.push({ direction: 'down', remotePath: r, localPath: l, size: e.size });
  }
  return out;
}

/** Rozhodne, jestli je vzdálená cesta soubor nebo adresář. */
async function remoteIsDir(adapter, remotePath) {
  try {
    const st = await adapter.stat(remotePath);
    if (typeof st.isDirectory === 'boolean') return st.isDirectory;
  } catch { /* FTP na adresáři SIZE neumí */ }
  try {
    await adapter.list(remotePath);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ okno

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1b1d23',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'Soubor',
      submenu: [
        { label: 'Připojit…', accelerator: 'Cmd+O', click: () => send('menu', 'connect') },
        { label: 'Odpojit', accelerator: 'Cmd+D', click: () => send('menu', 'disconnect') },
        { type: 'separator' },
        { label: 'Import z WinSCP…', click: () => send('menu', 'import') },
        { type: 'separator' },
        { label: 'Synchronizovat adresáře…', accelerator: 'Cmd+S', click: () => send('menu', 'sync') },
        { label: 'Obnovit', accelerator: 'Cmd+R', click: () => send('menu', 'refresh') },
        { type: 'separator' },
        { label: 'Vysypat koš na serveru…', click: () => send('menu', 'emptytrash') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Zobrazení',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------- IPC

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // --- nastavení ---
  handle('settings:get', async () => settings);
  handle('settings:set', async (patch) => {
    settings = { ...settings, ...patch };
    await saveSettings();
    return settings;
  });

  // --- uložené relace ---
  handle('sites:list', async () => sites.list());
  handle('sites:save', async (site) => sites.upsert(site));
  handle('sites:delete', async (id) => { await sites.remove(id); return true; });

  // --- import z WinSCP ---
  handle('winscp:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Vyberte WinSCP.ini nebo exportovaný .reg soubor',
      properties: ['openFile'],
      filters: [
        { name: 'Konfigurace WinSCP', extensions: ['ini', 'reg'] },
        { name: 'Všechny soubory', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return { file: res.filePaths[0], ...parseWinscpFile(res.filePaths[0]) };
  });

  handle('winscp:import', async ({ sessions, overwrite }) => {
    const result = await sites.importMany(sessions, { overwrite });
    log('ok', `Import z WinSCP: přidáno ${result.added}, přeskočeno ${result.skipped}`);
    return result;
  });

  // --- připojení ---
  handle('conn:status', async () => ({
    status: conn.status,
    site: conn.config ? { name: conn.config.name, host: conn.config.host, protocol: conn.config.protocol, username: conn.config.username } : null,
  }));

  handle('conn:connect', async (payload) => {
    await disconnectAll();
    const cfg = payload.siteId ? await sites.resolve(payload.siteId) : payload.config;
    conn.status = 'connecting';
    send('conn', { status: 'connecting' });

    let opened;
    try {
      opened = await connectVerified(cfg, payload.siteId || null);
    } catch (err) {
      conn.status = 'disconnected';
      send('conn', { status: 'disconnected' });
      // Odmítnutý klíč není „selhání připojení" — je to výsledek rozhodnutí.
      const decided = err.hostKeyRejected || err.certRejected;
      throw new Error(decided ? err.message : `Připojení selhalo: ${err.message}`);
    }

    const adapter = opened.adapter;
    adapter.onLost = (reason) => {
      if (conn.browse !== adapter) return;
      log('error', `Spojení se serverem skončilo: ${reason}`);
      conn.status = 'disconnected';
      send('conn', { status: 'disconnected' });
    };
    conn.browse = adapter;
    conn.config = opened.config;
    conn.status = 'connected';
    conn.home = await adapter.home().catch(() => '/');

    // Certifikát se obměnil za jiný, kterému systém věří — otisk jen tiše
    // srovnáme, aby příště nevyskakovalo hlášení o změně.
    if (adapter.certificate && adapter.certificate.refreshPin && payload.siteId) {
      await sites.setTlsFingerprint(payload.siteId, adapter.certificate.fingerprint);
      log('ok', 'Certifikát serveru se obnovil, uložený otisk byl srovnán');
    }

    editWatcher = new EditWatcher({
      queue,
      connectionKey: () => `${cfg.protocol}://${cfg.username}@${cfg.host}:${cfg.port}`,
    });
    editWatcher.on('update', (list) => send('edit', list));
    editWatcher.on('log', ({ level, text }) => log(level, text));

    const home = cfg.remoteDir || conn.home;
    log('ok', `Připojeno k ${cfg.host} (${cfg.protocol.toUpperCase()})`);

    // Úklid starých položek v koši na pozadí — připojení kvůli tomu nečeká.
    const trash = getTrash(adapter);
    if (trash && conn.config.recycleBinDays > 0) {
      trash.cleanup(conn.config.recycleBinDays)
        .then((days) => { if (days.length) log('ok', `Z koše na serveru uklizeno ${days.length} starších dnů`); })
        .catch(() => {});
    }

    send('conn', {
      status: 'connected',
      site: {
        name: cfg.name, host: cfg.host, protocol: cfg.protocol, username: cfg.username,
        useRecycleBin: Boolean(conn.config.useRecycleBin),
      },
    });
    return { home, localDir: cfg.localDir || settings.localDir || os.homedir() };
  });

  handle('conn:disconnect', async () => { await disconnectAll(); return true; });

  // --- vzdálený souborový systém ---
  handle('remote:list', async (remotePath) => {
    const a = requireBrowse();
    const target = remotePath || await a.home();
    const entries = await a.list(target);
    return { path: normalizeRemote(target), entries };
  });

  handle('remote:home', async () => requireBrowse().home());
  handle('remote:mkdir', async (remotePath) => { await requireBrowse().mkdir(remotePath, true); return true; });
  handle('remote:rename', async ({ from, to }) => { await requireBrowse().rename(from, to); return true; });
  handle('remote:chmod', async ({ remotePath, mode }) => { await requireBrowse().chmod(remotePath, mode); return true; });

  /**
   * Mazání na serveru. Se zapnutým košem se položka jen přesune — nikdy
   * nemažeme natvrdo „pro jistotu", když přesun selže; radši chybu ohlásíme.
   */
  handle('remote:delete', async ({ paths, permanent }) => {
    const a = requireBrowse();
    const trash = permanent ? null : getTrash();

    for (const p of paths) {
      if (trash) {
        await trash.moveToTrash(p);
      } else if (await remoteIsDir(a, p)) {
        await a.removeDir(p, true);
      } else {
        await a.removeFile(p);
      }
    }
    return { toTrash: Boolean(trash), count: paths.length };
  });

  // --- koš na serveru ---
  handle('trash:info', async () => {
    const trash = getTrash();
    if (!trash) return { enabled: false };
    return { enabled: true, path: trash.basePath, days: await trash.listDays() };
  });

  handle('trash:empty', async () => {
    const trash = getTrash();
    if (!trash) throw new Error('Koš na serveru není u této relace zapnutý');
    const removed = await trash.empty();
    log('ok', removed ? `Koš na serveru vysypán (${removed} dnů)` : 'Koš na serveru byl prázdný');
    return { removed };
  });

  // --- lokální souborový systém ---
  handle('local:home', async () => settings.localDir || os.homedir());

  handle('local:list', async (localPath) => {
    const target = localPath || settings.localDir || os.homedir();
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.name.startsWith('.') && d.name !== '..') { /* skryté necháme, filtruje UI */ }
      const full = path.join(target, d.name);
      const st = await fsp.lstat(full).catch(() => null);
      if (!st) continue;
      entries.push({
        name: d.name,
        type: st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f',
        size: st.size,
        mtime: st.mtimeMs,
        mode: st.mode & 0o777,
        hidden: d.name.startsWith('.'),
      });
    }
    return { path: path.resolve(target), entries };
  });

  handle('local:mkdir', async (p) => { await fsp.mkdir(p, { recursive: true }); return true; });
  handle('local:rename', async ({ from, to }) => { await fsp.rename(from, to); return true; });
  handle('local:delete', async (paths) => {
    // Do koše, ne natvrdo — omyl se dá vzít zpět.
    for (const p of paths) await shell.trashItem(p);
    return true;
  });
  handle('local:reveal', async (p) => { shell.showItemInFolder(p); return true; });
  handle('local:pickDir', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('local:pickFile', async (opts = {}) => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], ...opts });
    return res.canceled ? null : res.filePaths[0];
  });

  // --- fronta přenosů ---
  handle('queue:snapshot', async () => queue.snapshot());
  handle('queue:pause', async () => { queue.pause(); return true; });
  handle('queue:resume', async () => { queue.resume(); return true; });
  handle('queue:cancel', async (id) => { queue.cancel(id); return true; });
  handle('queue:cancelAll', async () => { queue.cancelAll(); return true; });
  handle('queue:retry', async (id) => { queue.retry(id); return true; });
  handle('queue:clear', async () => { queue.clearFinished(); return true; });

  /** Nahrání vybraných lokálních položek (soubory i adresáře) do vzdálené složky. */
  handle('transfer:upload', async ({ items, remoteDir }) => {
    const jobs = [];
    for (const localPath of items) {
      const base = path.basename(localPath);
      await expandLocal(localPath, posix.join(remoteDir, base), jobs);
    }
    const a = await getTransferAdapter();
    for (const j of jobs.filter((x) => x.direction === 'mkdirRemote')) {
      await a.mkdir(j.remotePath, true).catch(() => {});
    }
    const files = jobs.filter((x) => x.direction === 'up');
    queue.add(files);
    return { count: files.length };
  });

  /** Stažení vybraných vzdálených položek do lokální složky. */
  handle('transfer:download', async ({ items, localDir }) => {
    const a = requireBrowse();
    const jobs = [];
    for (const remotePath of items) {
      const base = posix.basename(remotePath);
      const localTarget = path.join(localDir, base);
      if (await remoteIsDir(a, remotePath)) await expandRemote(a, remotePath, localTarget, jobs);
      else {
        const st = await a.stat(remotePath).catch(() => ({ size: null }));
        jobs.push({ direction: 'down', remotePath, localPath: localTarget, size: st.size });
      }
    }
    queue.add(jobs);
    return { count: jobs.length };
  });

  // --- synchronizace ---
  handle('sync:compare', async ({ localDir, remoteDir, direction, criteria, deleteExtra }) => {
    const a = requireBrowse();
    return compare(a, localDir, remoteDir, { direction, criteria, deleteExtra });
  });

  handle('sync:apply', async (actions) => {
    const a = requireBrowse();
    const jobs = [];
    for (const act of actions) {
      switch (act.action) {
        case 'mkdirRemote': await a.mkdir(act.remotePath, true).catch(() => {}); break;
        case 'mkdirLocal': await fsp.mkdir(act.localPath, { recursive: true }); break;
        // conflictResolved: v náhledu synchronizace uživatel o přepisu
        // rozhodl, druhý dotaz na každý soubor by byl jen otrava.
        case 'upload': jobs.push({ direction: 'up', localPath: act.localPath, remotePath: act.remotePath, size: act.size, conflictResolved: true }); break;
        case 'download': jobs.push({ direction: 'down', localPath: act.localPath, remotePath: act.remotePath, size: act.size, conflictResolved: true }); break;
        case 'deleteRemote': await a.removeFile(act.remotePath); break;
        case 'rmdirRemote': await a.removeDir(act.remotePath, true); break;
        case 'deleteLocal': await shell.trashItem(act.localPath); break;
        default: break; // 'conflict' se bez rozhodnutí uživatele nedělá
      }
    }
    queue.add(jobs);
    return { transfers: jobs.length };
  });

  // --- editace se zpětným nahráním ---
  handle('edit:open', async (remotePath) => {
    if (!editWatcher) throw new Error('Nejste připojeni');
    return editWatcher.open(remotePath, { editor: settings.editor || undefined });
  });
  handle('edit:stop', async (remotePath) => { await editWatcher?.stop(remotePath); return true; });
  handle('edit:stopAll', async () => { await editWatcher?.stopAll(); return true; });
  handle('edit:list', async () => (editWatcher ? editWatcher.list() : []));
}

function normalizeRemote(p) {
  if (!p) return '/';
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

async function disconnectAll() {
  queue?.cancelAll();
  await editWatcher?.stopAll().catch(() => {});
  editWatcher = null;
  await conn.browse?.disconnect().catch(() => {});
  await conn.transfer?.disconnect().catch(() => {});
  conn.browse = null;
  conn.transfer = null;
  conn.config = null;
  conn.status = 'disconnected';
  send('conn', { status: 'disconnected' });
}

// ------------------------------------------------------------- start app

app.whenReady().then(async () => {
  await loadSettings();
  sites = new SiteStore(app.getPath('userData'));
  await sites.load();

  queue = new TransferQueue({
    getAdapter: getTransferAdapter,
    // Když okno zmizí dřív, než uživatel odpoví, přenos raději přeskočíme —
    // mlčky přepsat cizí soubor je horší než ho nechat být.
    onConflict: (info) => prompts.ask(win, 'conflict', info, { action: 'skip' }),
  });
  queue.on('update', (snap) => send('queue', snap));

  prompts.register();
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  prompts.cancelAll();
  await disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => { await disconnectAll(); });
