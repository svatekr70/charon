'use strict';

const fs = require('fs');
const net = require('net');
const ftp = require('basic-ftp');
const tlscerts = require('../tlscerts');
const { makeThrottle } = require('../throttle');

/**
 * FTP / FTPS adaptér se stejným rozhraním jako SftpAdapter.
 *
 * basic-ftp drží jedno řídicí spojení a neumí paralelní příkazy, proto si
 * aplikace drží zvlášť klienta pro procházení a zvlášť pro přenosy.
 */
class FtpAdapter {
  constructor() {
    this.client = new ftp.Client(60000);
    this.client.ftp.encoding = encodingOf(this._cfg);
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
    // Záznam komunikace. basic-ftp posílá do `verbose` celý rozhovor včetně
    // odpovědí serveru — přesně to, co je při potížích potřeba vidět.
    if (hooks.log) {
      this.client.ftp.verbose = true;
      this.client.ftp.log = (zprava) => hooks.log(zprava);
    }
    // Timeout se nastavuje na klientovi, ne v jednotlivých příkazech.
    if (Number(cfg.connectTimeoutMs)) this.client.ftp.timeout = Number(cfg.connectTimeoutMs);
    // Kódování názvů souborů. Starší servery UTF-8 neumí a názvy s diakritikou
    // pak dorazí jako změť; „auto" nechá rozhodnout server podle FEAT.
    this.client.ftp.encoding = encodingOf(cfg);
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

    const latin = encodingOf(cfg) === 'latin1';

    // UTF-8 zapínáme před přihlášením kvůli diakritice ve jméně nebo heslu.
    if (!latin) await this.client.sendIgnoringError('OPTS UTF8 ON');
    await this.client.login(cfg.username || 'anonymous', cfg.password || 'anonymous@');
    await this.client.useDefaultSettings();

    // useDefaultSettings pošle „OPTS UTF8 ON" samo od sebe. Když si uživatel
    // vyžádal latin1, musíme to vzít zpátky — jinak by server posílal názvy
    // v UTF-8, my je četli jako latin1 a diakritika by se rozsypala.
    if (latin) await this.client.sendIgnoringError('OPTS UTF8 OFF');
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

  /**
   * Posun času serveru v milisekundách.
   *
   * Starší FTP servery hlásí v textovém výpisu čas v místní zóně a bez údaje
   * o tom, v jaké. Porovnávání podle času pak lže o celé hodiny. Ruční korekce
   * je jediné, co s tím jde dělat.
   */
  get timeShiftMs() {
    return (Number(this._cfg && this._cfg.timeShiftMinutes) || 0) * 60000;
  }

  /**
   * Přepočte čas z textového výpisu.
   *
   * Schválně jen ten. `MDTM` i `MLSD` vracejí podle RFC 3659 čas v UTC, takže
   * jsou správně samy o sobě — posunout je by z opravy udělalo chybu.
   */
  _shift(ms) {
    return ms === null || ms === undefined ? ms : ms + this.timeShiftMs;
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
        // Posun se týká jen času z textového výpisu; MLSD je v UTC.
        mtime: precise ? e.modifiedAt.getTime() : this._shift(parseListDate(e.rawModifiedAt)),
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
        e.mtime = (await this.client.lastMod(full)).getTime();   // MDTM je v UTC
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
    // Typ schválně netvrdíme: `SIZE` na složce jeden server odmítne a druhý
    // na ni vrátí číslo, takže „soubor" by byla lež. Kdo to potřebuje vědět,
    // zeptá se výpisu (`isDir()` v session.js).
    return { size, mtime, isDirectory: null, mode: null };
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

  /**
   * FTP nemá shell — příkazy jde spouštět jen přes SFTP. Radši to řekneme
   * rovnou, než aby uživatel hledal, proč se nic nestalo.
   */
  // eslint-disable-next-line class-methods-use-this
  exec() {
    throw new Error('Spouštění příkazů na serveru umí jen SFTP, ne FTP');
  }

  // eslint-disable-next-line class-methods-use-this
  chown() {
    throw new Error('Změnu vlastníka umí jen SFTP, ne FTP');
  }

  /**
   * Kontrolní součet přes XCRC / XMD5. Nejsou ve standardu a spousta serverů
   * je nemá — pak to řekneme rovnou místo tichého selhání.
   */
  async checksum(remotePath, algo = 'md5') {
    const cmd = algo === 'md5' ? 'XMD5' : 'XCRC';
    try {
      const res = await this.client.send(`${cmd} ${remotePath}`);
      const hash = String(res.message).trim().split(/\s+/).pop();
      if (/^[0-9a-f]{8,}$/i.test(hash)) return { algo, hash, tool: cmd };
      throw new Error('nesrozumitelná odpověď');
    } catch (err) {
      throw new Error(`Server neumí ${cmd}: ${err.message}`);
    }
  }

  /** Přejmenování přes existující cíl; ne každý server RNTO na obsazené jméno pustí. */
  async replace(from, to) {
    try {
      await this.client.rename(from, to);
      return;
    } catch { /* cíl nejspíš existuje */ }

    await this.client.remove(to, true);
    await this.client.rename(from, to);
  }

  /** FTP kopii na serveru neumí; protokol pro ni nemá příkaz. */
  async copy() {
    throw new Error('Kopie na serveru jde jen přes SFTP — FTP na to nemá příkaz. '
      + 'Stáhněte soubor a nahrajte ho pod jiným názvem.');
  }

  async symlink() {
    throw new Error('Symbolické odkazy umí jen SFTP');
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

  async download(remotePath, localPath, {
    startAt = 0, onProgress, signal, limiters, transform,
  } = {}) {
    await this.ensureConnected();
    return this._withProgress(startAt, onProgress, signal, async () => {
      const ws = fs.createWriteStream(localPath, startAt > 0 ? { flags: 'a' } : { flags: 'w' });
      const throttle = makeThrottle(limiters);
      // Textový režim: převod konců řádků těsně před zápisem na disk.
      const prevod = transform ? transform() : null;

      if (!throttle && !prevod) {
        await this.client.downloadTo(ws, remotePath, startAt);
        return;
      }
      // Knihovna zapisuje do toho, co jí předáme — podstrčíme jí začátek
      // řetězu a ten teprve sype do souboru.
      const prvni = throttle || prevod;
      let proud = prvni;
      if (throttle && prevod) proud = proud.pipe(prevod);
      proud.pipe(ws);
      await this.client.downloadTo(prvni, remotePath, startAt);
    });
  }

  async upload(localPath, remotePath, {
    startAt = 0, onProgress, signal, limiters, transform,
  } = {}) {
    await this.ensureConnected();
    return this._withProgress(startAt, onProgress, signal, async () => {
      const throttle = makeThrottle(limiters);
      const source = () => {
        const rs = fs.createReadStream(localPath, startAt > 0 ? { start: startAt } : {});
        let proud = throttle ? rs.pipe(throttle) : rs;
        if (transform) proud = proud.pipe(transform());
        return proud;
      };
      if (startAt > 0) await this.client.appendFrom(source(), remotePath);
      else await this.client.uploadFrom(source(), remotePath);
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
/**
 * Kódování názvů pro `basic-ftp`.
 *
 * Knihovna umí to, co umí `Buffer.toString` — tedy `utf8` a `latin1`. „Auto"
 * necháváme na knihovně: zapne UTF-8, když ho server ohlásí ve FEAT.
 */
function encodingOf(cfg) {
  const volba = cfg && cfg.encoding ? String(cfg.encoding) : 'auto';
  if (volba === 'latin1') return 'latin1';
  if (volba === 'utf8') return 'utf8';
  return undefined; // auto — rozhodne knihovna podle serveru
}

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

module.exports = { FtpAdapter, parseListDate, encodingOf };
