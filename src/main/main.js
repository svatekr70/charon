'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard, Notification,
} = require('electron');
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
const sshConfig = require('./ssh-config');
const hostkeys = require('./hostkeys');
const prompts = require('./prompts');
const {
  localDirSize, remoteDirSize, expandLocal, expandRemote, remoteChmod,
} = require('./browse');
const FileMask = require('../common/mask');
const perms = require('./perms');
const { Session, SessionManager, isDir: remoteIsDir } = require('./session');
const { QueueStore } = require('./queue-store');
const { SessionLog } = require('./sessionlog');
const Version = require('../common/version');
const { expand, findPrompts, runLocal } = require('./commands');
const { sshCommand } = require('./terminal');
const { promisify } = require('util');
const execFileAsync = promisify(require('child_process').execFile);

let win = null;
let sites = null;
let manager = null;
let queueStore = null;
let sessionLog = null;
let settings = {
  editor: '', localDir: os.homedir(), transferMask: '',
  maxConcurrent: 3, speedLimitKb: 0,
  tempName: true, tempNameMinKb: 0,
  commands: [], workspaces: [],
  theme: 'system',
  // Práva nahraných souborů: 'keep' | 'fixed' | 'preserve'.
  uploadPerms: 'keep', uploadFileMode: '644', uploadDirMode: '755',
  cacheListings: true,
  collapsedFolders: [],
  // Co udělat, až fronta dojede: 'none' | 'notify' | 'disconnect' | 'sleep'.
  queueDoneAction: 'none',
  // Čím otevřít soubor podle názvu; první sedící pravidlo vyhrává.
  editorRules: [],
  // Co s původním souborem před přepsáním: 'none' | 'suffix' | 'trash'.
  backupOverwritten: 'none',
  // Síť: keepalive v sekundách (0 vypíná) a limit na navázání spojení.
  keepaliveSeconds: 10,
  connectTimeoutSeconds: 25,
  // Textový režim: kterých souborů se týká a jaké konce řádků chce server.
  textMask: '',
  serverEol: 'lf',
  // Záznam komunikace se serverem do souboru; kvůli velikosti vypnuto.
  sessionLog: false,
  // Pojmenované sady voleb pro přenos.
  transferProfiles: [],
  // Segmentovaný přenos: od jaké velikosti (MB) a na kolik spojení. 0 vypíná.
  segmentedMinMb: 0,
  segmentCount: 4,
  // Písmo a přiblížení okna.
  uiFont: '', monoFont: '', listFontSize: 12.5, zoom: 1,
  // Odkud se dozvíme o nové verzi. Prázdné = nekontroluje se nic.
  updateRepo: '',
  checkUpdatesOnStart: false,
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
/**
 * Doplní do konfigurace to, co je společné pro všechna spojení.
 *
 * Keepalive i timeout jsou v nastavení, ne u relace: potíž s nimi bývá
 * v síti mezi počítačem a serverem, ne v jednom konkrétním serveru.
 */
function withNetwork(cfg) {
  const keep = settings.keepaliveSeconds;
  return {
    ...cfg,
    keepaliveMs: keep === 0 ? 0 : (Number(keep) || 10) * 1000,
    connectTimeoutMs: (Number(settings.connectTimeoutSeconds) || 25) * 1000,
    // Anonymní přihlášení je jen zavedená dvojice jméno/heslo.
    username: cfg.anonymous ? 'anonymous' : cfg.username,
    password: cfg.anonymous ? 'anonymous@' : cfg.password,
  };
}

async function openAdapterFor(config) {
  const a = makeAdapter(config.protocol);
  const kdo = config.name || config.host;
  const hooks = config.protocol === 'ftp'
    ? { verifyCertificate: () => false, log: (z) => sessionLog.write(kdo, z) }
    : {
      verifyHostKey: makeHostKeyHook(config).hook,
      verifyTunnelHostKey: config.tunnelHost ? makeHostKeyHook(tunnelCfgOf(config)).hook : undefined,
      log: (z) => sessionLog.write(kdo, z),
    };
  await a.connect(withNetwork(config), hooks);
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

    const zapis = (z) => sessionLog.write(effective.name || effective.host, z);
    const hooks = isFtp
      ? { verifyCertificate: (info) => { cert.seen = info; return false; }, log: zapis }
      : {
        verifyHostKey: hostKey.hook,
        verifyTunnelHostKey: tunnelKey ? tunnelKey.hook : undefined,
        log: zapis,
      };

    try {
      await adapter.connect(withNetwork(effective), hooks);
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

/**
 * Přiblížení okna.
 *
 * Dělá se přes zoom, ne přes velikost písma: celé rozhraní se zvětší
 * proporcionálně a nic se nerozsype. Nastavuje to hlavní proces, protože
 * okno k `webFrame` z izolovaného kontextu nemá přístup.
 */
function applyZoom() {
  if (!win) return;
  const z = Math.min(2, Math.max(0.6, Number(settings.zoom) || 1));
  win.webContents.setZoomFactor(z);
}

function applyTheme() {
  nativeTheme.themeSource = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
  if (win) win.setBackgroundColor(windowBackground());
}

/**
 * Zjistí, jestli je venku novější verze.
 *
 * Ptáme se GitHubu na poslední vydání zadaného repozitáře. Dokud není kam se
 * dívat, nekontroluje se nic — stahovat aktualizace odnikud nejde a předstírat
 * kontrolu by bylo horší než ji nemít.
 *
 * Nic se nestahuje ani neinstaluje: dozvíte se, že je nová verze, a odkaz si
 * otevřete sami. Automatická instalace by potřebovala podepsanou aplikaci
 * a to je jiná liga.
 */
async function checkForUpdate() {
  const repo = String(settings.updateRepo || '').trim().replace(/^https?:\/\/github\.com\//, '');
  const current = app.getVersion();
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { current, configured: false };
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Charon/${current}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw new Error(`Repozitář ${repo} nemá žádné vydání (nebo neexistuje)`);
  if (!res.ok) throw new Error(`GitHub odpověděl ${res.status}`);

  const data = await res.json();
  const latest = String(data.tag_name || data.name || '').trim();
  return {
    current,
    configured: true,
    latest,
    newer: Version.isNewer(current, latest),
    url: data.html_url || `https://github.com/${repo}/releases`,
    notes: String(data.body || '').slice(0, 2000),
    published: data.published_at || null,
  };
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
    onQueueDrained: (session, souhrn) => afterQueue(session, souhrn),
  };
}

/**
 * Co udělat, až fronta dojede.
 *
 * Odpojení i uspání jsou nevratné zásahy, takže se dělají jen na výslovné
 * přání a nikdy, když něco selhalo — po chybě chce člověk vidět, co se stalo,
 * ne najít uspaný počítač.
 */
async function afterQueue(session, souhrn) {
  const akce = settings.queueDoneAction || 'none';
  if (akce === 'none' || (!souhrn.done && !souhrn.failed)) return;

  const kde = session.describe().name;
  const co = `${souhrn.done} ${souhrn.done === 1 ? 'položka' : souhrn.done < 5 ? 'položky' : 'položek'}`;
  const potiz = souhrn.failed
    ? `, ${souhrn.failed} ${souhrn.failed === 1 ? 'selhala' : 'selhalo'}`
    : '';

  if (Notification.isSupported()) {
    new Notification({
      title: souhrn.failed ? 'Přenosy skončily s chybou' : 'Přenosy dokončeny',
      body: `${kde}: ${co}${potiz}`,
    }).show();
  }
  log(souhrn.failed ? 'warn' : 'ok', `${kde}: fronta dojela — ${co}${potiz}`);

  // Po chybě se neodpojujeme ani neusínáme; to by chybu jen schovalo.
  if (souhrn.failed) return;

  if (akce === 'disconnect') {
    await manager.remove(session.id).catch(() => {});
    sendSessions();
    log('ok', `${kde}: odpojeno po dokončení fronty`);
  } else if (akce === 'sleep') {
    log('ok', 'Usínám po dokončení fronty…');
    // Necháme hlášku doběhnout do okna, ať je po probuzení vidět, co se stalo.
    setTimeout(() => { execFileAsync('pmset', ['sleepnow']).catch(() => {}); }, 1500);
  }
}

/**
 * Aplikace, ve které se má soubor otevřít.
 *
 * Pravidla se čtou odshora a platí první, které sedne — tak se dá obecné
 * pravidlo nechat dole. Bez pravidel platí výchozí editor; bez něj rozhodne
 * systém podle přípony, což je u obrázku či PDF to jediné rozumné.
 */
function editorFor(remotePath) {
  const jmeno = posix.basename(remotePath);
  for (const pravidlo of settings.editorRules || []) {
    if (!pravidlo || !pravidlo.mask || !pravidlo.app) continue;
    const m = compileMask(pravidlo.mask);
    if (m && m.match(jmeno, false)) return pravidlo.app;
  }
  return settings.editor || undefined;
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
  // Složky vznikají mimo frontu, práva se jim ale mají řídit stejnou
  // kaskádou jako souborům — přenos nad relací nad nastavením.
  const pravaSlozek = perms.dirMode(perms.resolve(extra.perms || {}, session.queue.perms));
  try {
    for (const j of jobs.filter((x) => x.direction === 'mkdirRemote')) {
      await a.mkdir(j.remotePath, true).catch(() => {});
      await perms.apply(a, j.remotePath, pravaSlozek);
    }
  } finally {
    session.transferPool().release(a);
  }

  // Příznaky (třeba moveFrom) musí být na položce hned při zařazení. Fronta
  // se rozeběhne okamžitě, takže dodatečné označení už nemusí stihnout.
  const { onlyNewer: jenNove, ...priznaky } = extra;
  let files = jobs.filter((x) => x.direction === 'up').map((j) => ({ ...j, ...priznaky }));
  let unchanged = 0;
  if (jenNove) {
    const b = await session.transferPool().acquire();
    try {
      const res = await onlyNewer(b, files, { direction: 'up' });
      files = res.jobs;
      unchanged = res.skipped;
    } finally {
      session.transferPool().release(b);
    }
  }
  return {
    count: files.length, skipped: stats.skipped, unchanged, ids: session.queue.add(files),
  };
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
  const { onlyNewer: jenNove, ...priznaky } = extra;
  let files = jobs.map((j) => ({ ...j, ...priznaky }));
  let unchanged = 0;
  if (jenNove) {
    const res = await onlyNewer(a, files, { direction: 'down' });
    files = res.jobs;
    unchanged = res.skipped;
  }
  return {
    count: files.length, skipped: stats.skipped, unchanged, ids: session.queue.add(files),
  };
}

/**
 * Přeloží profil přenosu na volby, které se přilepí ke každé položce.
 *
 * Profil je jednorázová odchylka pro jednu dávku, ne trvalá změna nastavení —
 * proto se nesou na položkách fronty a ne v ní samotné. Prázdný profil
 * znamená „platí, co je v nastavení".
 */
function profileOptions(profil) {
  if (!profil) return {};
  const out = {};
  // Stačí jedno vyplněné pole; co profil neurčí, dodědí se z relace a
  // z nastavení aplikace.
  if (profil.uploadPerms || profil.uploadFileMode || profil.uploadDirMode) {
    out.perms = {
      uploadPerms: profil.uploadPerms,
      uploadFileMode: profil.uploadFileMode,
      uploadDirMode: profil.uploadDirMode,
    };
  }
  if (profil.textMask !== undefined) {
    out.text = {
      mask: compileMask(profil.textMask || ''),
      eol: profil.serverEol === 'crlf' ? 'crlf' : 'lf',
    };
  }
  return out;
}

/**
 * Vyřadí soubory, které na druhé straně už jsou stejné.
 *
 * Porovnává se velikost a čas změny se stejnou tolerancí jako u synchronizace
 * — FTP hlásí čas často jen na minuty. Když se stav cíle nedá zjistit, položka
 * ve frontě zůstává: přeskočit soubor, o kterém nic nevíme, by znamenalo
 * tvářit se, že je přenesený.
 */
async function onlyNewer(adapter, jobs, { direction }) {
  const tolerance = adapter.protocol === 'ftp' ? 61000 : 2000;
  // V textovém režimu se mění konce řádků, takže velikost na obou stranách
  // sedět nemůže. U takových souborů rozhoduje jen čas — jinak by se pořád
  // dokola přenášely znovu.
  const textMask = compileMask(settings.textMask || '');
  const out = [];
  let skipped = 0;

  for (const j of jobs) {
    try {
      const [zdroj, cil] = direction === 'up'
        ? [await fsp.stat(j.localPath), await adapter.stat(j.remotePath)]
        : [await adapter.stat(j.remotePath), await fsp.stat(j.localPath)];

      const jeText = textMask && textMask.match(posix.basename(j.remotePath), false);
      const zdrojCas = zdroj.mtimeMs ?? zdroj.mtime;
      const cilCas = cil.mtimeMs ?? cil.mtime;
      const stejne = (jeText || zdroj.size === cil.size)
        && zdrojCas && cilCas && Math.abs(zdrojCas - cilCas) <= tolerance;
      // Starší zdroj taky nemá co přepisovat — od toho je „jen nové a změněné".
      const starsi = zdrojCas && cilCas && cilCas - zdrojCas > tolerance;

      if (stejne || starsi) { skipped += 1; continue; }
    } catch {
      // Cíl neexistuje (nebo se nedá přečíst) — tedy nový soubor, přenášíme.
    }
    out.push(j);
  }
  return { jobs: out, skipped };
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
  // Přiblížení se musí nastavit až po načtení; před ním ho Chromium zahodí.
  win.webContents.once('did-finish-load', applyZoom);
  // Nástroje pro vývojáře jen na výslovné vyžádání. Pouhé spuštění ze zdrojáků
  // (`npm run dev`) je otevírat nemá — překážejí a k ničemu nejsou.
  if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const template = [
    {
      label: 'Charon',
      submenu: [
        { label: 'O aplikaci Charon', click: () => send('menu', 'about') },
        { type: 'separator' },
        // Systémová zkratka pro nastavení; bez ní se do něj jde jen myší.
        { label: 'Nastavení…', accelerator: 'Cmd+,', click: () => send('menu', 'settings') },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    },
    {
      label: 'Soubor',
      submenu: [
        { label: 'Připojit v nové záložce…', accelerator: 'Cmd+O', click: () => send('menu', 'connect') },
        { label: 'Zavřít záložku', accelerator: 'Cmd+W', click: () => send('menu', 'closetab') },
        { label: 'Pracovní plochy…', accelerator: 'Shift+Cmd+O', click: () => send('menu', 'workspaces') },
        { label: 'Relace…', accelerator: 'Cmd+K', click: () => send('menu', 'sites') },
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
        { label: 'Porovnat panely', accelerator: 'Cmd+D', click: () => send('menu', 'compare') },
        { type: 'separator' },
        { label: 'Zvětšit', accelerator: 'Cmd+Plus', click: () => send('menu', 'zoomin') },
        { label: 'Zmenšit', accelerator: 'Cmd+-', click: () => send('menu', 'zoomout') },
        { label: 'Původní velikost', accelerator: 'Cmd+0', click: () => send('menu', 'zoomreset') },
        { label: 'Synchronizované procházení', accelerator: 'Cmd+Y', click: () => send('menu', 'syncbrowse') },
        { type: 'separator' },
        { label: 'Otevřít z adresy…', accelerator: 'Cmd+L', click: () => send('menu', 'openurl') },
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
    if (patch.zoom !== undefined) applyZoom();
    if (patch.sessionLog !== undefined) sessionLog.setEnabled(settings.sessionLog === true);
    // Nastavení přenosů platí pro všechny otevřené relace, ne jen pro tu vpředu.
    for (const s of manager.all()) s.applySettings(settings);
    return settings;
  });

  // --- uložené relace ---
  handle('sites:list', async () => sites.list());
  handle('sites:save', async (site) => {
    const id = await sites.upsert(site);
    // Práva se dají změnit u relace, která je zrovna otevřená — čekat na
    // příští připojení by znamenalo, že se změna tiše neprojeví.
    for (const s of manager.all()) {
      if (s.siteId !== id) continue;
      s.config.uploadPerms = site.uploadPerms || '';
      s.config.uploadFileMode = site.uploadFileMode || '';
      s.config.uploadDirMode = site.uploadDirMode || '';
      s.applySettings(settings);
    }
    return id;
  });
  handle('sites:reveal', async ({ id, field }) => sites.reveal(id, field));
  handle('sites:delete', async (id) => { await sites.remove(id); return true; });
  handle('sites:sync', async ({ id, sync }) => { await sites.setSync(id, sync); return true; });
  handle('sites:duplicate', async (id) => sites.duplicate(id));

  /**
   * Hromadné přejmenování. Kroky přicházejí spočítané z okna včetně pořadí,
   * ve kterém se nic nepřepíše; tady se jen provedou a spočítá se, co selhalo.
   * Jeden nepovedený krok ostatní nezastaví — polovina přejmenovaná a půlka ne
   * je horší než jasně ohlášená chyba u konkrétních souborů.
   */
  /**
   * Otevře Terminál.
   *
   * Lokálně stačí složka. U serveru sestavíme příkaz `ssh` z údajů relace
   * a necháme uživatele, ať ho odešle sám — heslo mu do terminálu psát
   * nebudeme a tiše spouštět příkazy jeho jménem taky ne. U FTP není co
   * otevírat, tam žádný shell není.
   */
  handle('term:open', async ({ sid, side, dir }) => {
    if (side === 'local') {
      await execFileAsync('open', ['-a', 'Terminal', dir]);
      return { opened: 'local' };
    }

    const session = sessionOf(sid);
    const cfg = session.config;
    if (cfg.protocol !== 'sftp') throw new Error('Terminál umí jen SFTP — FTP žádný shell nemá');

    const prikaz = sshCommand(cfg, dir);

    clipboard.writeText(prikaz);
    await execFileAsync('open', ['-a', 'Terminal', os.homedir()]);
    return { opened: 'remote', command: prikaz };
  });

  handle('files:renameMany', async ({ sid, side, dir, steps }) => {
    const failed = [];
    let renamed = 0;

    for (const krok of steps) {
      try {
        if (side === 'local') {
          await fsp.rename(path.join(dir, krok.from), path.join(dir, krok.to));
        } else {
          const a = browseOf(sid);
          await a.rename(posix.join(dir, krok.from), posix.join(dir, krok.to));
        }
        // Dočasné odklizení se do počtu nepočítá, to je jen mezikrok.
        if (!krok.temp) renamed += 1;
      } catch (err) {
        failed.push(`${krok.from}: ${err.message}`);
      }
    }

    if (side !== 'local' && manager.has(sid)) sessionOf(sid).listCache.clear();
    return { renamed, failed };
  });

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

  /**
   * Relace z ~/.ssh/config. Když soubor neexistuje nebo v něm nic není,
   * necháme uživatele vybrat jiný — konfigurace bývá i jinde.
   */
  handle('ssh:read', async ({ file } = {}) => {
    const target = file || sshConfig.defaultPath();
    const res = sshConfig.read(target);
    return { ...res, total: res.sessions.length, masterPassword: false, source: 'ssh' };
  });

  handle('ssh:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Vyberte konfiguraci OpenSSH',
      defaultPath: path.dirname(sshConfig.defaultPath()),
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const out = sshConfig.read(res.filePaths[0]);
    return { ...out, total: out.sessions.length, masterPassword: false, source: 'ssh' };
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
  handle('remote:list', async ({ sid, path: remotePath, refresh }) => {
    const session = sessionOf(sid);
    const a = browseOf(sid);
    const target = normalizeRemote(remotePath || await a.home());

    // Ruční obnovení se paměti neptá — od toho tam ta klávesa je.
    if (!refresh) {
      const cached = session.listCache.get(target);
      if (cached) return { path: target, entries: cached, cached: true };
    }

    const entries = await a.list(target);
    session.listCache.set(target, entries);
    return { path: target, entries };
  });

  handle('remote:home', async ({ sid }) => browseOf(sid).home());
  handle('remote:mkdir', async ({ sid, path: p }) => {
    await browseOf(sid).mkdir(p, true);
    sessionOf(sid).listCache.clear();
    return true;
  });
  handle('remote:rename', async ({ sid, from, to }) => {
    await browseOf(sid).rename(from, to);
    sessionOf(sid).listCache.clear();
    return true;
  });
  handle('remote:chmod', async ({ sid, remotePath, mode }) => {
    await browseOf(sid).chmod(remotePath, mode);
    sessionOf(sid).listCache.clear();
    return true;
  });
  /** Kopie souboru na serveru — bez stahování, když to server umožní. */
  /**
   * Stáhne soubor do dočasné složky a otevře ho v systémem přiřazené aplikaci.
   * Změny se nesledují — na to je editace se zpětným nahráním.
   */
  handle('remote:openExternal', async ({ sid, remotePath }) => {
    const session = sessionOf(sid);
    const a = session.requireBrowse();
    const dir = path.join(os.tmpdir(), 'charon-open');
    await fsp.mkdir(dir, { recursive: true });
    const local = path.join(dir, posix.basename(remotePath));

    await a.download(remotePath, local, {});
    const chyba = await shell.openPath(local);
    if (chyba) throw new Error(chyba);
    return { path: local };
  });

  handle('clipboard:write', async (text) => { clipboard.writeText(String(text || '')); return true; });

  handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
  }));

  handle('app:checkUpdate', async () => checkForUpdate());
  handle('app:openExternal', async (url) => {
    // Jen http(s); `openExternal` jinak umí spustit i jiné druhy odkazů.
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Neplatný odkaz');
    await shell.openExternal(url);
    return true;
  });

  /** Otevře složku se záznamy ve Finderu — hledat ji ručně by byla otrava. */
  handle('log:reveal', async () => {
    const dir = path.join(app.getPath('userData'), 'logs');
    await fsp.mkdir(dir, { recursive: true });
    shell.openPath(dir);
    return { dir };
  });

  handle('remote:copy', async ({ sid, from, to }) => {
    const session = sessionOf(sid);
    const res = await session.requireBrowse().copy(from, to);
    session.listCache.clear();
    if (res && res.serverSide === false) {
      log('warn', 'Server nepustil shell, kopie tekla přes tento počítač');
    }
    return res || {};
  });

  handle('remote:symlink', async ({ sid, target, linkPath }) => {
    const session = sessionOf(sid);
    await session.requireBrowse().symlink(target, linkPath);
    session.listCache.clear();
    return true;
  });

  /** Ruční nastavení času změny; v adaptéru už je kvůli synchronizaci. */
  handle('remote:touch', async ({ sid, paths, mtime }) => {
    const session = sessionOf(sid);
    const a = session.requireBrowse();
    // Adaptéry pracují s milisekundami, stejně jako `fs`.
    const failed = [];
    for (const p of paths) {
      try { await a.utimes(p, mtime, mtime); } catch (err) { failed.push(`${p}: ${err.message}`); }
    }
    session.listCache.clear();
    return { count: paths.length - failed.length, failed };
  });

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
    sid, paths, fileMode, dirExec, owner, group, recursive,
  }) => {
    // Složky se odvozují od práv souborů: buď stejná, nebo se spouštěním
    // navíc. Dvě nezávislá čísla se ve výsledku stejně vždycky lišila jen
    // tímhle bitem.
    const dirMode = dirExec ? perms.addExec(fileMode) : fileMode;
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
    sessionOf(sid).listCache.clear();
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
    session.listCache.clear();
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
    sessionOf(sid).listCache.clear();
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
  handle('queue:hold', async ({ sid, id }) => { sessionOf(sid).queue.holdItem(id); return true; });
  handle('queue:release', async ({ sid, id }) => { sessionOf(sid).queue.releaseItem(id); return true; });
  handle('queue:move', async ({ sid, id, to }) => sessionOf(sid).queue.moveItem(id, to));
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

  handle('transfer:upload', async ({
    sid, items, remoteDir, mask, onlyNewer, profile,
  }) => {
    const { count, skipped, unchanged } = await enqueueUpload(
      sessionOf(sid), items, remoteDir,
      { onlyNewer: Boolean(onlyNewer), ...profileOptions(profile) },
      effectiveMask(mask),
    );
    return { count, skipped, unchanged };
  });

  handle('transfer:download', async ({
    sid, items, localDir, mask, onlyNewer, profile,
  }) => {
    const { count, skipped, unchanged } = await enqueueDownload(
      sessionOf(sid), items, localDir,
      { onlyNewer: Boolean(onlyNewer), ...profileOptions(profile) },
      effectiveMask(mask),
    );
    return { count, skipped, unchanged };
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
  handle('sync:compare', async ({
    sid, localDir, remoteDir, direction, criteria, deleteExtra, mask, mode, onlyExisting,
  }) => {
    const a = browseOf(sid);
    return compare(a, localDir, remoteDir, {
      direction, criteria, deleteExtra, mask, mode, onlyExisting,
    });
  });

  handle('sync:apply', async ({ sid, actions }) => {
    const session = sessionOf(sid);
    const a = session.requireBrowse();
    const jobs = [];
    let touched = 0;
    const failed = [];
    for (const act of actions) {
      switch (act.action) {
        case 'mkdirRemote':
          await a.mkdir(act.remotePath, true).catch(() => {});
          await perms.apply(a, act.remotePath, perms.dirMode(session.queue.perms));
          break;
        case 'mkdirLocal': await fsp.mkdir(act.localPath, { recursive: true }); break;
        // conflictResolved: v náhledu synchronizace uživatel o přepisu
        // rozhodl, druhý dotaz na každý soubor by byl jen otrava.
        case 'upload': jobs.push({ direction: 'up', localPath: act.localPath, remotePath: act.remotePath, size: act.size, conflictResolved: true }); break;
        case 'download': jobs.push({ direction: 'down', localPath: act.localPath, remotePath: act.remotePath, size: act.size, conflictResolved: true }); break;
        case 'deleteRemote': await a.removeFile(act.remotePath); break;
        case 'rmdirRemote': await a.removeDir(act.remotePath, true); break;
        case 'deleteLocal': await shell.trashItem(act.localPath); break;
        // Srovnání času: obsah se nepřenáší, mění se jen razítko. Když to
        // server neumí, řekne se to — mlčky vynechat by znamenalo, že příští
        // porovnání ukáže totéž a nikdo nebude vědět proč.
        case 'touchRemote':
          try {
            await a.utimes(act.remotePath, act.mtime, act.mtime);
            touched += 1;
          } catch (err) {
            failed.push(`${act.rel}: ${err.message}`);
          }
          break;
        case 'touchLocal':
          try {
            await fsp.utimes(act.localPath, new Date(act.mtime), new Date(act.mtime));
            touched += 1;
          } catch (err) {
            failed.push(`${act.rel}: ${err.message}`);
          }
          break;
        default: break; // 'conflict' se bez rozhodnutí uživatele nedělá
      }
    }
    session.queue.add(jobs);
    // Zakládání složek při synchronizaci mění server ještě před přenosy.
    session.listCache.clear();
    if (failed.length) {
      log('warn', `Čas se nepodařilo srovnat u ${failed.length} ${
        failed.length === 1 ? 'souboru' : 'souborů'}: ${failed[0]}`);
    }
    return { transfers: jobs.length, touched, failed: failed.length };
  });

  // --- editace se zpětným nahráním ---
  handle('edit:open', async ({ sid, remotePath }) => {
    const session = sessionOf(sid);
    session.requireBrowse();
    return session.editWatcher.open(remotePath, { editor: editorFor(remotePath) });
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

  // Při spuštění ze zdrojáků si Electron bere svou vlastní ikonu; v Docku pak
  // svítí atom místo Charona. V sestavené aplikaci ji řeší electron-builder.
  if (!app.isPackaged && process.platform === 'darwin') {
    const ikona = path.join(__dirname, '..', '..', 'build', 'icon.iconset', 'icon_512x512.png');
    try { app.dock.setIcon(ikona); } catch { /* ikona se ještě nevykreslila */ }
  }
  sites = new SiteStore(app.getPath('userData'));
  await sites.load();
  manager = new SessionManager();
  queueStore = new QueueStore(app.getPath('userData'));
  await queueStore.load();
  sessionLog = new SessionLog(path.join(app.getPath('userData'), 'logs'));
  sessionLog.setEnabled(settings.sessionLog === true);

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
