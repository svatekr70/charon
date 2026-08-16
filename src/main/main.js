'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const posix = path.posix;

const { SftpAdapter } = require('./adapters/sftp');
const { FtpAdapter } = require('./adapters/ftp');
const { SiteStore } = require('./sites');
const { compare } = require('./sync');
const { parseWinscpFile } = require('./winscp-import');
const hostkeys = require('./hostkeys');
const prompts = require('./prompts');
const {
  localDirSize, remoteDirSize, expandLocal, expandRemote, remoteChmod,
} = require('./browse');
const FileMask = require('../common/mask');
const { Session, SessionManager, isDir: remoteIsDir } = require('./session');
const { QueueStore } = require('./queue-store');
const { expand, findPrompts, runLocal } = require('./commands');

let win = null;
let sites = null;
let manager = null;
let queueStore = null;
let settings = {
  editor: '', localDir: os.homedir(), transferMask: '',
  maxConcurrent: 3, speedLimitKb: 0,
  tempName: true, tempNameMinKb: 0,
  commands: [], workspaces: [],
  theme: 'system',
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

/**
 * Otevře další spojení pro přenosy, oddělené od toho, kterým se prochází.
 *
 * Otisky jsou v konfiguraci potvrzené z prvního spojení, takže se uživatele
 * neptáme znovu — jen zkontrolujeme, že sedí. Když ne, spojení se neotevře;
 * ptát se tady podruhé by bylo matoucí.
 */
async function openAdapterFor(config) {
  const a = makeAdapter(config.protocol);
  const hooks = config.protocol === 'ftp'
    ? { verifyCertificate: () => false }
    : {
      verifyHostKey: makeHostKeyHook(config).hook,
      verifyTunnelHostKey: config.tunnelHost ? makeHostKeyHook(tunnelCfgOf(config)).hook : undefined,
    };
  await a.connect(config, hooks);
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

/** Konfigurace brány jako samostatného stroje — má vlastní otisk klíče. */
function tunnelCfgOf(cfg) {
  return {
    host: cfg.tunnelHost,
    port: Number(cfg.tunnelPort) || 22,
    hostKeyFingerprint: cfg.tunnelHostKeyFingerprint,
  };
}

/**
 * Zeptá se na neznámý nebo změněný klíč. Používáme nativní dialog schválně —
 * jde o bezpečnostní rozhodnutí a obsah okna aplikace ho nemá jak ovlivnit.
 */
async function askAboutHostKey(info, cfg, role = 'serveru') {
  const where = `${cfg.host}:${Number(cfg.port) || 22}`;
  const co = role === 'brány' ? 'Brána' : 'Server';

  if (info.verdict === 'revoked') {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Odvolaný klíč serveru',
      message: `Klíč ${role} ${where} je v known_hosts označen jako odvolaný.`,
      detail: `Otisk: ${info.fingerprint}\n\nPřipojení bylo zrušeno.`,
      buttons: ['Rozumím'],
    });
    return { accept: false, reason: `Klíč ${role} je označen jako odvolaný` };
  }

  if (info.verdict === 'mismatch') {
    const res = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Klíč serveru se změnil',
      message: `${co} ${where} se hlásí jiným klíčem, než jaký je uložený.`,
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
      : { accept: false, reason: `Klíč ${role} se změnil — připojení zrušeno` };
  }

  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Neznámý server',
    message: `K ${role === 'brány' ? 'bráně' : 'serveru'} ${where} se připojujete poprvé.`,
    detail: `Otisk klíče (${info.type}):\n${info.fingerprint}\n\n`
      + 'Ověřte si ho u správce serveru, nebo z jiného počítače příkazem:\n'
      + `ssh-keyscan -p ${Number(cfg.port) || 22} ${cfg.host} | ssh-keygen -lf -\n\n`
      + 'Když si otisk zapamatujeme, upozorníme vás, kdyby se příště změnil.',
    buttons: ['Zrušit', 'Připojit jednorázově', 'Připojit a zapamatovat'],
    defaultId: 2,
    cancelId: 0,
  });
  if (res.response === 0) return { accept: false, reason: `Klíč ${role} nebyl potvrzen` };
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
    // Brána je samostatný stroj — vidí všechno, co jím projde, takže se
    // ověřuje zvlášť a stejně přísně jako cíl.
    const tunnelKey = !isFtp && effective.tunnelHost
      ? makeHostKeyHook(tunnelCfgOf(effective))
      : null;
    const cert = { seen: null };

    const hooks = isFtp
      ? { verifyCertificate: (info) => { cert.seen = info; return false; } }
      : { verifyHostKey: hostKey.hook, verifyTunnelHostKey: tunnelKey ? tunnelKey.hook : undefined };

    try {
      await adapter.connect(effective, hooks);
      return { adapter, config: effective };
    } catch (err) {
      await adapter.disconnect().catch(() => {});
      if (attempt > 0) throw err;

      // Nejdřív brána: bez ní se k cíli vůbec nedostaneme, takže selhalo-li
      // spojení a její klíč jsme nepotvrdili, je to tenhle důvod.
      if (tunnelKey && tunnelKey.seen && tunnelKey.seen.verdict !== 'trusted') {
        const decision = await askAboutHostKey(tunnelKey.seen, tunnelCfgOf(effective), 'brány');
        if (!decision.accept) throw Object.assign(new Error(decision.reason), { hostKeyRejected: true });
        effective = { ...effective, tunnelHostKeyFingerprint: tunnelKey.seen.fingerprint };
        if (decision.remember && siteId) await sites.setTunnelHostKey(siteId, tunnelKey.seen.fingerprint);
        continue;
      }

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

/**
 * Motiv se musí propsat i mimo okno.
 *
 * `nativeTheme` řídí systémové dialogy (potvrzení otisku klíče, výběr souboru)
 * a rám okna; barva pozadí okna se ukáže v tom zlomku vteřiny, než se stránka
 * vykreslí — v tmavém motivu by bílý záblesk praštil do očí.
 */
function windowBackground() {
  const dark = settings.theme === 'dark'
    || (settings.theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? '#1b1d23' : '#ffffff';
}

function applyTheme() {
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
  if (win) win.setBackgroundColor(windowBackground());
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


// -------------------------------------------------------------- relace

/** Závislosti, které relace potřebuje od hlavního procesu. */
function sessionDeps() {
  return {
    openAdapter: openAdapterFor,
    send: (channel, payload) => send(channel, payload),
    log,
    settings: () => settings,
    askConflict: (sid, info) => prompts.ask(win, 'conflict', { sid, ...info }, { action: 'skip' }),
    // Když okno neodpoví, soubor raději nepřepisujeme — cizí změnu je horší
    // zahodit než neuložit vlastní.
    askEditOverwrite: (sid, info) => prompts.ask(win, 'editconflict', { sid, ...info }, { action: 'skip' }),
    trashLocal: (p) => shell.trashItem(p),
    rememberQueue: (key, items, name) => queueStore.remember(key, items, { name }),
  };
}

/** Relace, na kterou míří požadavek z okna. */
function sessionOf(sid) {
  return manager.get(sid);
}

function browseOf(sid) {
  return sessionOf(sid).requireBrowse();
}

function sendSessions() {
  send('sessions', manager.list());
}

/** Nahrání vybraných lokálních položek do vzdálené složky. */
async function enqueueUpload(session, items, remoteDir, extra = {}, maskText = '') {
  const jobs = [];
  const mask = compileMask(maskText);
  const stats = { skipped: 0 };
  for (const localPath of items) {
    await expandLocal(localPath, posix.join(remoteDir, path.basename(localPath)), jobs, mask, stats);
  }

  const a = await session.transferPool().acquire();
  try {
    for (const j of jobs.filter((x) => x.direction === 'mkdirRemote')) {
      await a.mkdir(j.remotePath, true).catch(() => {});
    }
  } finally {
    session.transferPool().release(a);
  }

  // Příznaky (třeba moveFrom) musí být na položce hned při zařazení. Fronta
  // se rozeběhne okamžitě, takže dodatečné označení už nemusí stihnout.
  const files = jobs.filter((x) => x.direction === 'up').map((j) => ({ ...j, ...extra }));
  return { count: files.length, skipped: stats.skipped, ids: session.queue.add(files) };
}

/** Stažení vybraných vzdálených položek do lokální složky. */
async function enqueueDownload(session, items, localDir, extra = {}, maskText = '') {
  const a = session.requireBrowse();
  const jobs = [];
  const mask = compileMask(maskText);
  const stats = { skipped: 0 };

  for (const remotePath of items) {
    const localTarget = path.join(localDir, posix.basename(remotePath));
    await expandRemote(a, remotePath, localTarget, jobs, mask, stats);
  }
  const files = jobs.map((j) => ({ ...j, ...extra }));
  return { count: files.length, skipped: stats.skipped, ids: session.queue.add(files) };
}

/**
 * Zkompiluje masku; prázdná znamená „bez omezení". Vrací null, aby volající
 * mohl kontroly úplně přeskočit a neplatil za ně u každé položky.
 */
function compileMask(text) {
  if (!text || !String(text).trim()) return null;
  const m = FileMask.compile(text);
  return m.empty ? null : m;
}

// ------------------------------------------------------------------ okno

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    backgroundColor: windowBackground(),
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
        { label: 'Připojit v nové záložce…', accelerator: 'Cmd+O', click: () => send('menu', 'connect') },
        { label: 'Zavřít záložku', accelerator: 'Cmd+W', click: () => send('menu', 'closetab') },
        { label: 'Pracovní plochy…', accelerator: 'Shift+Cmd+O', click: () => send('menu', 'workspaces') },
        { type: 'separator' },
        { label: 'Další záložka', accelerator: 'Ctrl+Tab', click: () => send('menu', 'nexttab') },
        { label: 'Předchozí záložka', accelerator: 'Ctrl+Shift+Tab', click: () => send('menu', 'prevtab') },
        { type: 'separator' },
        { label: 'Import z WinSCP…', click: () => send('menu', 'import') },
        { type: 'separator' },
        { label: 'Synchronizovat adresáře…', accelerator: 'Cmd+S', click: () => send('menu', 'sync') },
        { label: 'Hlídat složku a nahrávat změny…', accelerator: 'Cmd+U', click: () => send('menu', 'watch') },
        { type: 'separator' },
        { label: 'Příkazy na serveru…', accelerator: 'Cmd+L', click: () => send('menu', 'console') },
        { label: 'Vlastní příkazy…', click: () => send('menu', 'commands') },
        // Bez akcelerátoru schválně: ⌘F si obsluhuje okno samo, aby v levém
        // panelu otevřelo filtr a v pravém hledání na serveru.
        { label: 'Najít soubory na serveru…', click: () => send('menu', 'find') },
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
    if (patch.theme !== undefined) applyTheme();
    // Nastavení přenosů platí pro všechny otevřené relace, ne jen pro tu vpředu.
    for (const s of manager.all()) s.applySettings(settings);
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

  handle('winscp:import', async ({ sessions: found, overwrite }) => {
    const result = await sites.importMany(found, { overwrite });
    log('ok', `Import z WinSCP: přidáno ${result.added}, přeskočeno ${result.skipped}`);
    return result;
  });

  // --- záložky ---
  handle('sessions:list', async () => manager.list());
  handle('sessions:activate', async (sid) => { manager.setActive(sid); return manager.list(); });

  handle('sessions:open', async (payload) => {
    const cfg = payload.siteId ? await sites.resolve(payload.siteId) : payload.config;
    if (!cfg || !cfg.host) throw new Error('Chybí relace, ke které se má připojit');

    let opened;
    try {
      opened = await connectVerified(cfg, payload.siteId || null);
    } catch (err) {
      // Odmítnutý otisk není „selhání připojení" — je to výsledek rozhodnutí.
      const decided = err.hostKeyRejected || err.certRejected;
      throw new Error(decided ? err.message : `Připojení selhalo: ${err.message}`);
    }

    const session = new Session({
      id: crypto.randomUUID(),
      config: opened.config,
      siteId: payload.siteId || null,
      deps: sessionDeps(),
    });
    manager.add(session);

    const home = await opened.adapter.home().catch(() => '/');
    await session.connect(opened.adapter, home);

    // Certifikát se obměnil za jiný, kterému systém věří — otisk jen tiše
    // srovnáme, aby příště nevyskakovalo hlášení o změně.
    if (opened.adapter.certificate && opened.adapter.certificate.refreshPin && payload.siteId) {
      await sites.setTlsFingerprint(payload.siteId, opened.adapter.certificate.fingerprint);
      log('ok', 'Certifikát serveru se obnovil, uložený otisk byl srovnán');
    }

    // Úklid starých položek v koši běží na pozadí; připojení kvůli tomu nečeká.
    const trash = session.getTrash();
    if (trash && session.config.recycleBinDays > 0) {
      trash.cleanup(session.config.recycleBinDays)
        .then((days) => { if (days.length) log('ok', `Z koše na serveru uklizeno ${days.length} starších dnů`); })
        .catch(() => {});
    }

    log('ok', `Připojeno k ${cfg.host} (${cfg.protocol.toUpperCase()})`);
    sendSessions();

    // Když z minula nic nezbylo, může si relace frontu ukládat hned. Jinak
    // počkáme, až okno řekne, jestli se má obnovit — do té doby by prázdná
    // fronta uložený záznam smazala.
    const unfinished = queueStore.pending(session.persistKey).length;
    session.queueAdopted = unfinished === 0;

    return {
      session: session.describe(),
      home: cfg.remoteDir || home,
      localDir: cfg.localDir || settings.localDir || os.homedir(),
      // Nedokončené přenosy z minula; okno se zeptá, jestli je obnovit.
      unfinished,
    };
  });

  handle('sessions:close', async (sid) => {
    await manager.remove(sid);
    sendSessions();
    return manager.list();
  });

  // --- vzdálený souborový systém ---
  handle('remote:list', async ({ sid, path: remotePath }) => {
    const a = browseOf(sid);
    const target = remotePath || await a.home();
    const entries = await a.list(target);
    return { path: normalizeRemote(target), entries };
  });

  handle('remote:home', async ({ sid }) => browseOf(sid).home());
  handle('remote:mkdir', async ({ sid, path: p }) => { await browseOf(sid).mkdir(p, true); return true; });
  handle('remote:rename', async ({ sid, from, to }) => { await browseOf(sid).rename(from, to); return true; });
  handle('remote:chmod', async ({ sid, remotePath, mode }) => { await browseOf(sid).chmod(remotePath, mode); return true; });
  handle('remote:dirSize', async ({ sid, path: p }) => remoteDirSize(browseOf(sid), p));

  /** Podklady pro dialog vlastností. */
  handle('remote:properties', async ({ sid, paths }) => {
    const a = browseOf(sid);
    const items = [];
    for (const p of paths) {
      const isFolder = await remoteIsDir(a, p);
      let st = null;
      try { st = await a.stat(p); } catch { /* FTP na složce SIZE neumí */ }
      // Vlastníka a skupinu má výpis nadřazené složky, stat je nevrací.
      let entry = null;
      try {
        const parent = posix.dirname(p);
        const name = posix.basename(p);
        entry = (await a.list(parent)).find((e) => e.name === name) || null;
      } catch { /* na kořen se nedostaneme */ }

      items.push({
        path: p,
        isDir: isFolder,
        size: isFolder ? null : (st ? st.size : (entry ? entry.size : null)),
        mtime: (st && st.mtime) || (entry && entry.mtime) || null,
        mode: (st && st.mode) ?? (entry && entry.mode) ?? null,
        owner: entry ? entry.owner : null,
        group: entry ? entry.group : null,
      });
    }
    return { items, protocol: sessionOf(sid).config.protocol };
  });

  handle('remote:applyProperties', async ({
    sid, paths, fileMode, dirMode, owner, group, recursive,
  }) => {
    const a = browseOf(sid);
    const stats = { files: 0, dirs: 0, owners: 0 };

    for (const p of paths) {
      if (fileMode !== null || dirMode !== null) {
        if (recursive) {
          const r = await remoteChmod(a, p, { fileMode, dirMode });
          stats.files += r.files;
          stats.dirs += r.dirs;
        } else {
          const isFolder = await remoteIsDir(a, p);
          const mode = isFolder ? dirMode : fileMode;
          if (mode !== null) {
            await a.chmod(p, mode);
            if (isFolder) stats.dirs += 1; else stats.files += 1;
          }
        }
      }
      if (owner !== null || group !== null) {
        const cur = await a.stat(p).catch(() => ({}));
        await a.chown(p, owner ?? cur.uid ?? 0, group ?? cur.gid ?? 0);
        stats.owners += 1;
      }
    }
    return stats;
  });

  handle('remote:checksum', async ({ sid, paths, algo }) => {
    const a = browseOf(sid);
    const out = [];
    for (const p of paths) {
      try {
        out.push({ path: p, ...(await a.checksum(p, algo)) });
      } catch (err) {
        out.push({ path: p, error: err.message });
      }
    }
    return out;
  });

  /**
   * Mazání na serveru. Se zapnutým košem se položka jen přesune — nikdy
   * nemažeme natvrdo „pro jistotu", když přesun selže.
   */
  handle('remote:delete', async ({ sid, paths, permanent }) => {
    const session = sessionOf(sid);
    const a = session.requireBrowse();
    const trash = permanent ? null : session.getTrash();

    for (const p of paths) {
      if (trash) await trash.moveToTrash(p);
      else if (await remoteIsDir(a, p)) await a.removeDir(p, true);
      else await a.removeFile(p);
    }
    return { toTrash: Boolean(trash), count: paths.length };
  });

  // --- koš na serveru ---
  handle('trash:info', async ({ sid }) => {
    const session = sessionOf(sid);
    const trash = session.getTrash();
    if (!trash) return { enabled: false };
    return { enabled: true, path: trash.basePath, days: await trash.listDays() };
  });

  handle('trash:empty', async ({ sid }) => {
    const trash = sessionOf(sid).getTrash();
    if (!trash) throw new Error('Koš na serveru není u této relace zapnutý');
    const removed = await trash.empty();
    log('ok', removed ? `Koš na serveru vysypán (${removed} dnů)` : 'Koš na serveru byl prázdný');
    return { removed };
  });

  // --- lokální souborový systém (nezávislý na relaci) ---
  handle('local:home', async () => settings.localDir || os.homedir());
  handle('local:dirSize', async (localPath) => localDirSize(localPath));

  handle('local:list', async (localPath) => {
    const target = localPath || settings.localDir || os.homedir();
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
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
  handle('queue:snapshot', async ({ sid }) => sessionOf(sid).queue.snapshot());
  handle('queue:pause', async ({ sid }) => { sessionOf(sid).queue.pause(); return true; });
  handle('queue:resume', async ({ sid }) => { sessionOf(sid).queue.resume(); return true; });
  handle('queue:cancel', async ({ sid, id }) => { sessionOf(sid).queue.cancel(id); return true; });
  handle('queue:cancelAll', async ({ sid }) => { sessionOf(sid).queue.cancelAll(); return true; });
  handle('queue:retry', async ({ sid, id }) => { sessionOf(sid).queue.retry(id); return true; });
  handle('queue:clear', async ({ sid }) => { sessionOf(sid).queue.clearFinished(); return true; });

  /** Vrátí do fronty přenosy, které nedoběhly před zavřením aplikace. */
  handle('queue:restore', async ({ sid }) => {
    const session = sessionOf(sid);
    const items = queueStore.pending(session.persistKey);
    session.queueAdopted = true;
    if (!items.length) return { count: 0 };
    // Postup se dopočítá z rozepsaných souborů na disku, ne z uloženého čísla —
    // soubor je jediné, co o skutečně přenesených bajtech vypovídá.
    session.queue.add(items);
    queueStore.forget(session.persistKey);
    log('ok', `Obnoveno ${items.length} nedokončených přenosů`);
    return { count: items.length };
  });

  handle('queue:discard', async ({ sid }) => {
    const session = sessionOf(sid);
    queueStore.forget(session.persistKey);
    session.queueAdopted = true;
    return true;
  });

  /** Limit v kB/s; 0 vypíná. Bez id platí globálně pro všechny relace. */
  handle('queue:speedLimit', async ({ sid, id, kb }) => {
    const bytes = Math.max(0, Math.floor(kb) || 0) * 1024;
    if (id) { sessionOf(sid).queue.setItemSpeedLimit(id, bytes); return true; }
    for (const s of manager.all()) s.queue.setSpeedLimit(bytes);
    settings = { ...settings, speedLimitKb: Math.max(0, Math.floor(kb) || 0) };
    await saveSettings();
    return true;
  });

  // --- přenosy ---
  /** `mask === undefined` znamená „použij výchozí z nastavení". */
  const effectiveMask = (mask) => (mask === undefined ? settings.transferMask || '' : mask);

  handle('transfer:upload', async ({ sid, items, remoteDir, mask }) => {
    const { count, skipped } = await enqueueUpload(sessionOf(sid), items, remoteDir, {}, effectiveMask(mask));
    return { count, skipped };
  });

  handle('transfer:download', async ({ sid, items, localDir, mask }) => {
    const { count, skipped } = await enqueueDownload(sessionOf(sid), items, localDir, {}, effectiveMask(mask));
    return { count, skipped };
  });

  handle('transfer:move', async ({ sid, items, targetDir, from, mask }) => {
    // U přesunu maska záměrně neplatí z nastavení — vynechaný soubor by
    // zůstal na zdroji a člověk by si myslel, že přesunul všechno.
    const session = sessionOf(sid);
    const result = from === 'local'
      ? await enqueueUpload(session, items, targetDir, { moveFrom: 'local' }, mask || '')
      : await enqueueDownload(session, items, targetDir, { moveFrom: 'remote' }, mask || '');
    return { count: result.count, skipped: result.skipped };
  });

  // --- hledání souborů na serveru ---
  handle('find:start', async ({ sid, root, mask, includeDirs }) => {
    const session = sessionOf(sid);
    const a = session.requireBrowse();
    const finder = session.newFinder();
    const res = await finder.run(a, root || '/', mask, {
      includeDirs: Boolean(includeDirs),
      onProgress: (msg) => session.emit('find', { ...msg, done: false }),
    });
    session.emit('find', {
      done: true, scanned: res.scanned, total: res.total, canceled: res.canceled, truncated: res.truncated,
    });
    return { total: res.total, scanned: res.scanned, canceled: res.canceled, truncated: res.truncated };
  });
  handle('find:cancel', async ({ sid }) => {
    const s = manager.has(sid) ? manager.get(sid) : null;
    if (s && s.finder) s.finder.cancel();
    return true;
  });

  // --- synchronizace ---
  handle('sync:compare', async ({ sid, localDir, remoteDir, direction, criteria, deleteExtra, mask }) => {
    const a = browseOf(sid);
    return compare(a, localDir, remoteDir, { direction, criteria, deleteExtra, mask });
  });

  handle('sync:apply', async ({ sid, actions }) => {
    const session = sessionOf(sid);
    const a = session.requireBrowse();
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
    session.queue.add(jobs);
    return { transfers: jobs.length };
  });

  // --- editace se zpětným nahráním ---
  handle('edit:open', async ({ sid, remotePath }) => {
    const session = sessionOf(sid);
    session.requireBrowse();
    return session.editWatcher.open(remotePath, { editor: settings.editor || undefined });
  });
  handle('edit:stop', async ({ sid, remotePath }) => { await sessionOf(sid).editWatcher.stop(remotePath); return true; });
  handle('edit:stopAll', async ({ sid }) => { await sessionOf(sid).editWatcher.stopAll(); return true; });
  handle('edit:list', async ({ sid }) => sessionOf(sid).editWatcher.list());

  // --- příkazy na serveru a na tomhle počítači ---

  /** Dotazy v šabloně vyřeší okno předem; sem už přijdou hotové odpovědi. */
  handle('cmd:prompts', async ({ template }) => findPrompts(template));

  handle('cmd:run', async ({
    sid, template, target, cwd, localDir, files, answers, each,
  }) => {
    const session = sessionOf(sid);
    const list = files && files.length ? files : [];

    // „Na každý zvlášť" spustí příkaz tolikrát, kolik je vybraných položek;
    // jinak jednou se všemi najednou.
    const rounds = each && list.length
      ? list.map((f) => ({ file: f, files: [f] }))
      : [{ file: list[0] || '', files: list }];

    const results = [];
    for (const round of rounds) {
      const command = expand(template, {
        ...round,
        remoteDir: cwd,
        localDir,
        answers: answers || {},
      });

      const onData = (text, kind) => session.emit('console', { text, kind });
      session.emit('console', { text: `$ ${command}\n`, kind: 'cmd' });

      const res = target === 'local'
        ? await runLocal(command, { cwd: localDir, onData })
        : await session.requireBrowse().exec(command, { cwd, onData });

      if (res.truncated) session.emit('console', { text: '\n… výstup je zkrácený\n', kind: 'err' });
      session.emit('console', { text: `\n[návratový kód ${res.code}]\n`, kind: res.code === 0 ? 'ok' : 'err' });
      results.push({ code: res.code, output: res.output, truncated: res.truncated });
    }
    return { runs: results.length, results };
  });

  // --- hlídání složky s automatickým nahráváním ---
  handle('watch:start', async ({ sid, ...opts }) => {
    const session = sessionOf(sid);
    session.requireBrowse();
    const res = await session.folderWatcher.start(opts);
    log('ok', `Hlídám ${opts.localDir} → ${opts.remoteDir}`);
    return res;
  });
  handle('watch:stop', async ({ sid }) => {
    const res = await sessionOf(sid).folderWatcher.stop();
    log('ok', 'Hlídání složky zastaveno');
    return res;
  });
  handle('watch:status', async ({ sid }) => sessionOf(sid).folderWatcher.status());
}

function normalizeRemote(p) {
  if (!p) return '/';
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

// ------------------------------------------------------------- start app

app.whenReady().then(async () => {
  await loadSettings();
  // Motiv nastavíme dřív, než vznikne okno — jinak by se mihlo v té špatné barvě.
  applyTheme();
  sites = new SiteStore(app.getPath('userData'));
  await sites.load();
  manager = new SessionManager();
  queueStore = new QueueStore(app.getPath('userData'));
  await queueStore.load();

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
  await manager?.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  // Uložit dřív, než se relace zavřou — zavření frontu vyprázdní.
  await queueStore?.save().catch(() => {});
  await manager?.closeAll();
});
