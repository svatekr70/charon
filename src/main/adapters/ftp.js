'use strict';

const fs = require('fs');
const net = require('net');
const ftp = require('basic-ftp');
const tlscerts = require('../tlscerts');

/**
 * FTP / FTPS adaptér se stejným rozhraním jako SftpAdapter.
 *
 * basic-ftp drží jedno řídicí spojení a neumí paralelní příkazy, proto si
 * aplikace drží zvlášť klienta pro procházení a zvlášť pro přenosy.
 */
class FtpAdapter {
  constructor() {
    this.client = new ftp.Client(60000);
    this.client.ftp.encoding = 'utf8';
    this.connected = false;
    this.protocol = 'ftp';
    this._cfg = null;
    /** Popis potvrzeného certifikátu (jen u FTPS). */
    this.certificate = null;
  }

  /**
   * @param {object} cfg konfigurace relace
   * @param {object} [hooks]
   * @param {(info) => Promise<boolean>} [hooks.verifyCertificate]
   *   Rozhodne o certifikátu, kterému systém nevěří. Bez něj se spojení
   *   ukončí — nikdy nepokračujeme s neověřeným certifikátem.
   *
   * Nevoláme `access()`, ale jeho kroky zvlášť. Jde o to vsunout kontrolu
   * certifikátu mezi TLS handshake a `login()`: kdybychom ověřovali až po
   * připojení, uživatelské jméno a heslo už by byly na cestě k serveru,
   * který se za něj možná jen vydává.
   */
  async connect(cfg, hooks = {}) {
    this._cfg = cfg;
    const mode = cfg.ftps === 'implicit' ? 'implicit' : cfg.ftps === 'explicit' ? 'explicit' : 'none';
    const port = Number(cfg.port) || (mode === 'implicit' ? 990 : 21);

    // rejectUnauthorized:false schválně — ověřujeme si sami, abychom mohli
    // nabídnout potvrzení otisku místo tvrdého odmítnutí. Heslo jde ven až
    // po tom ověření, takže se tím nic neotevírá.
    const secureOptions = {
      rejectUnauthorized: false,
      host: cfg.host,
    };
    // SNI smí nést jen doménové jméno. U připojení na holou IP by Node
    // rovnou vyhodil výjimku, tak ho tam vůbec nedáváme.
    if (net.isIP(cfg.host) === 0) secureOptions.servername = cfg.host;

    if (mode === 'implicit') await this.client.connectImplicitTLS(cfg.host, port, secureOptions);
    else await this.client.connect(cfg.host, port);

    if (mode === 'explicit') await this.client.useTLS(secureOptions);

    if (mode !== 'none') await this._verifyCertificate(cfg, hooks);

    // UTF-8 zapínáme před přihlášením kvůli diakritice ve jméně nebo heslu.
    await this.client.sendIgnoringError('OPTS UTF8 ON');
    await this.client.login(cfg.username || 'anonymous', cfg.password || 'anonymous@');
    await this.client.useDefaultSettings();
    this.connected = true;
  }

  async _verifyCertificate(cfg, hooks) {
    const seen = tlscerts.inspectSocket(this.client.ftp.socket, cfg.host);
    const info = tlscerts.classify({
      ...seen,
      storedFingerprint: cfg.tlsFingerprint || '',
      acceptAny: cfg.rejectUnauthorized === false,
    });

    if (info.verdict === 'trusted') {
      this.certificate = info;
      return;
    }

    const ok = hooks.verifyCertificate ? await hooks.verifyCertificate(info) : false;
    if (!ok) {
      try { this.client.close(); } catch { /* už zavřeno */ }
      throw Object.assign(
        new Error(info.verdict === 'mismatch'
          ? 'Certifikát serveru se změnil — připojení zrušeno'
          : 'Certifikát serveru nebyl potvrzen'),
        { certRejected: true, certInfo: info },
      );
    }
    this.certificate = info;
  }

  /** Po abortu je řídicí spojení zavřené — tímhle ho oživíme. */
  async ensureConnected() {
    if (this.connected && !this.client.closed) return;
    this.client = new ftp.Client(60000);
    this.client.ftp.encoding = 'utf8';
    this.connected = false;
    // Bez hooku: po výpadku se na certifikát neptáme znovu, jen musí sedět
    // s tím, co už bylo potvrzeno. Když nesedí, spojení se neobnoví.
    await this.connect(this._cfg);
  }

  async disconnect() {
    this.connected = false;
    try { this.client.close(); } catch { /* už zavřeno */ }
  }

  async home() {
    return this.client.pwd();
  }

  async list(remotePath) {
    const raw = await this.client.list(remotePath);
    return raw.map((e) => {
      // MLSD dává přesný čas v UTC. Když ho server neumí, zbude textový výpis
      // typu "Aug 16 14:06" — bez roku, bez sekund a bez časové zóny. Ten se dá
      // použít na zobrazení, ale ne na porovnávání; proto ten příznak.
      const precise = Boolean(e.modifiedAt);
      return {
        name: e.name,
        type: e.type === 2 ? 'd' : e.type === 3 ? 'l' : 'f',
        size: e.size,
        mtime: precise ? e.modifiedAt.getTime() : parseListDate(e.rawModifiedAt),
        mtimePrecise: precise,
        rawMtime: e.rawModifiedAt || null,
        mode: typeof e.permissions === 'object' && e.permissions
          ? (e.permissions.user * 64) + (e.permissions.group * 8) + e.permissions.world
          : null,
      };
    });
  }

  /**
   * Doplní přesné časy změny přes MDTM (vrací UTC na sekundu). Volá to
   * synchronizace, kde by nepřesný čas z textového výpisu vedl k tomu, že se
   * pořád dokola přenášejí stejné soubory. Pro pouhé zobrazení se to nedělá —
   * je to jeden příkaz na soubor navíc.
   */
  async refineMtimes(dirPath, entries) {
    for (const e of entries) {
      if (e.type !== 'f' || e.mtimePrecise) continue;
      try {
        const full = `${dirPath.replace(/\/$/, '')}/${e.name}`;
        e.mtime = (await this.client.lastMod(full)).getTime();
        e.mtimePrecise = true;
      } catch {
        e.mtime = null; // server neumí ani MDTM — porovnáváme jen podle velikosti
      }
    }
    return entries;
  }

  async stat(remotePath) {
    const size = await this.client.size(remotePath);
    let mtime = null;
    try { mtime = (await this.client.lastMod(remotePath)).getTime(); } catch { /* MDTM nepodporováno */ }
    return { size, mtime, isDirectory: false, mode: null };
  }

  async exists(remotePath) {
    try { await this.client.size(remotePath); return true; } catch { return false; }
  }

  async mkdir(remotePath) {
    await this.client.ensureDir(remotePath);
    // ensureDir nechá klienta ve vytvořeném adresáři, vracíme se na kořen
    await this.client.cd('/');
  }

  async removeFile(remotePath) {
    await this.client.remove(remotePath, true);
  }

  async removeDir(remotePath) {
    await this.client.removeDir(remotePath);
  }

  async rename(from, to) {
    await this.client.rename(from, to);
  }

  async chmod(remotePath, mode) {
    // Není součástí FTP standardu; většina serverů rozumí SITE CHMOD.
    await this.client.send(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${remotePath}`);
  }

  /**
   * Zachování času změny přes MFMT. Není v původním FTP standardu, ale umí ho
   * prakticky každý dnešní server; když ne, přenos kvůli tomu neselže.
   */
  async utimes(remotePath, atimeMs, mtimeMs) {
    const d = new Date(mtimeMs);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
      + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    await this.client.send(`MFMT ${stamp} ${remotePath}`);
  }

  async download(remotePath, localPath, { startAt = 0, onProgress, signal } = {}) {
    await this.ensureConnected();
    return this._withProgress(startAt, onProgress, signal, async () => {
      const ws = fs.createWriteStream(localPath, startAt > 0 ? { flags: 'a' } : { flags: 'w' });
      await this.client.downloadTo(ws, remotePath, startAt);
    });
  }

  async upload(localPath, remotePath, { startAt = 0, onProgress, signal } = {}) {
    await this.ensureConnected();
    return this._withProgress(startAt, onProgress, signal, async () => {
      if (startAt > 0) {
        await this.client.appendFrom(fs.createReadStream(localPath, { start: startAt }), remotePath);
      } else {
        await this.client.uploadFrom(localPath, remotePath);
      }
    });
  }

  /**
   * Obalí přenos sledováním průběhu a možností přerušení. FTP neumí přenos
   * zrušit jinak než zavřením spojení, takže abort = close + příště reconnect.
   */
  async _withProgress(startAt, onProgress, signal, run) {
    let transferred = startAt;
    this.client.trackProgress((info) => {
      transferred = startAt + info.bytes;
      if (onProgress) onProgress(transferred);
    });

    const onAbort = () => { try { this.client.close(); } catch { /* už zavřeno */ } };
    if (signal) {
      if (signal.aborted) { this.client.trackProgress(); throw Object.assign(new Error('Přenos přerušen'), { aborted: true }); }
      signal.once('abort', onAbort);
    }

    try {
      await run();
      return transferred;
    } catch (err) {
      if (signal && signal.aborted) throw Object.assign(new Error('Přenos přerušen'), { aborted: true });
      throw err;
    } finally {
      if (signal) signal.removeListener('abort', onAbort);
      this.client.trackProgress();
    }
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Rozparsuje datum z textového výpisu FTP. Časová zóna v něm není, takže
 * se bere jako místní čas serveru — na zobrazení to stačí, na porovnávání ne.
 */
function parseListDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // Unixový tvar: "Aug 16 14:06" (letošní) nebo "Aug 16 2025" (starší)
  const unix = /^([A-Za-z]{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/.exec(s);
  if (unix) {
    const month = MONTHS.indexOf(unix[1].toLowerCase());
    if (month === -1) return null;
    const day = Number(unix[2]);
    if (unix[3]) return new Date(Number(unix[3]), month, day).getTime();

    // Bez roku: je to posledních ~6 měsíců. Když by datum vyšlo do budoucna,
    // patří do loňska.
    const now = new Date();
    let year = now.getFullYear();
    let d = new Date(year, month, day, Number(unix[4]), Number(unix[5]));
    if (d.getTime() > now.getTime() + 86400000) {
      year -= 1;
      d = new Date(year, month, day, Number(unix[4]), Number(unix[5]));
    }
    return d.getTime();
  }

  // Tvar MS-DOS: "08-16-25  02:06PM"
  const dos = /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(AM|PM)$/i.exec(s);
  if (dos) {
    let hour = Number(dos[4]) % 12;
    if (dos[6].toUpperCase() === 'PM') hour += 12;
    const yy = Number(dos[3]);
    return new Date(yy + (yy < 70 ? 2000 : 1900), Number(dos[1]) - 1, Number(dos[2]), hour, Number(dos[5])).getTime();
  }

  const fallback = Date.parse(s);
  return Number.isNaN(fallback) ? null : fallback;
}

module.exports = { FtpAdapter, parseListDate };
