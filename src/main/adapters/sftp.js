'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { makeThrottle } = require('../throttle');
const { shellQuote } = require('../commands');
const { buildPath } = require('../netpath');

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * SFTP adaptér. Rozhraní je společné s FtpAdapter, takže zbytek aplikace
 * nemusí vědět, který protokol je zrovna aktivní.
 */
class SftpAdapter {
  constructor() {
    // Výchozí posluchače knihovny píšou rovnou do konzole ("Global end
    // listener…"), což zaplevelí výstup a skutečné odpojení v tom zapadne.
    // Bereme si je na sebe: ztrátu spojení ohlásíme volajícímu a hlavně
    // přestaneme adaptér považovat za připojený.
    this.client = new SftpClient('ftp-cli', {
      error: (err) => this._lost(err && err.message ? err.message : 'chyba spojení'),
      end: () => this._lost('spojení bylo ukončeno'),
      close: () => this._lost('spojení bylo zavřeno'),
    });
    this.connected = false;
    this.protocol = 'sftp';
    /** Uklidí tunel nebo proxy, když se přes ně šlo. */
    this.cleanupPath = null;
    /** @type {null | ((reason: string) => void)} */
    this.onLost = null;
  }

  _lost(reason) {
    if (!this.connected) return; // odpojili jsme se sami, není co hlásit
    this.connected = false;
    if (this.onLost) this.onLost(reason);
  }

  /**
   * @param {object} cfg konfigurace relace
   * @param {object} [hooks]
   * @param {(info: {keyBuffer: Buffer}) => Promise<boolean>} [hooks.verifyHostKey]
   *   Rozhoduje, jestli se má klíč serveru přijmout. Když se nepředá,
   *   spojení se odmítne — nikdy nechceme tiše přijmout cokoliv.
   */
  async connect(cfg, hooks = {}) {
    const opts = {
      host: cfg.host,
      port: Number(cfg.port) || 22,
      username: cfg.username,
      // Keepalive drží spojení při nečinnosti, ale některé servery ho
      // nesnesou a spojení kvůli němu naopak zavřou. Proto se dá vypnout.
      readyTimeout: Number(cfg.connectTimeoutMs) || 25000,
      keepaliveInterval: cfg.keepaliveMs === 0 ? 0 : (Number(cfg.keepaliveMs) || 10000),
      keepaliveCountMax: 6,
    };

    // Ověření identity serveru. `hostHash` schválně nenastavujeme, ať dostaneme
    // syrový klíč a otisk si spočítáme sami (stejně jako OpenSSH).
    this._hostKeyRejected = null;
    opts.hostVerifier = (keyBuffer, verify) => {
      Promise.resolve()
        .then(() => (hooks.verifyHostKey ? hooks.verifyHostKey({ keyBuffer }) : false))
        .then((ok) => {
          if (!ok) this._hostKeyRejected = this._hostKeyRejected || 'Klíč serveru nebyl potvrzen';
          verify(Boolean(ok));
        })
        .catch((err) => {
          this._hostKeyRejected = err.message;
          verify(false);
        });
    };

    if (cfg.privateKeyPath) {
      opts.privateKey = fs.readFileSync(expandHome(cfg.privateKeyPath));
      if (cfg.passphrase) opts.passphrase = cfg.passphrase;
    }
    if (cfg.password) opts.password = cfg.password;

    // ssh-agent použijeme jen když není jiná metoda — jinak by server mohl
    // vyčerpat limit pokusů o autentizaci nabízením všech klíčů v agentovi.
    const wantsAgent = cfg.useAgent || (!cfg.password && !cfg.privateKeyPath);
    if (wantsAgent && process.env.SSH_AUTH_SOCK) opts.agent = process.env.SSH_AUTH_SOCK;

    // Když se jde přes proxy nebo bránu, spojení otevřeme sami a knihovně
    // ho jen podstrčíme.
    const routed = await buildPath({ ...cfg, verifyTunnelHostKey: hooks.verifyTunnelHostKey });
    if (routed.sock) {
      opts.sock = routed.sock;
      this.cleanupPath = routed.cleanup;
    }

    try {
      await this.client.connect(opts);
    } catch (err) {
      // Selhání handshaku kvůli odmítnutému klíči hlásí knihovna obecnou
      // hláškou — nahradíme ji tou, která říká, co se opravdu stalo.
      if (this.cleanupPath) { this.cleanupPath(); this.cleanupPath = null; }
      if (this._hostKeyRejected) {
        throw Object.assign(new Error(this._hostKeyRejected), { hostKeyRejected: true });
      }
      throw err;
    }
    this.connected = true;
  }

  async disconnect() {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) {
      try { await this.client.end(); } catch { /* spojení už mohlo spadnout */ }
    }
    if (this.cleanupPath) { this.cleanupPath(); this.cleanupPath = null; }
  }

  async home() {
    return this.client.cwd();
  }

  async list(remotePath) {
    const raw = await this.client.list(remotePath);
    return raw.map((e) => ({
      name: e.name,
      type: e.type === 'd' ? 'd' : e.type === 'l' ? 'l' : 'f',
      size: e.size,
      mtime: e.modifyTime,
      mode: rightsToOctal(e.rights),
      owner: e.owner,
      group: e.group,
    }));
  }

  async stat(remotePath) {
    const s = await this.client.stat(remotePath);
    return { size: s.size, mtime: s.modifyTime, isDirectory: s.isDirectory, mode: s.mode & 0o777 };
  }

  async exists(remotePath) {
    return Boolean(await this.client.exists(remotePath));
  }

  async mkdir(remotePath, recursive = true) {
    await this.client.mkdir(remotePath, recursive);
  }

  async removeFile(remotePath) {
    await this.client.delete(remotePath, true);
  }

  async removeDir(remotePath, recursive = true) {
    await this.client.rmdir(remotePath, recursive);
  }

  async rename(from, to) {
    await this.client.rename(from, to);
  }

  /**
   * Přejmenování přes existující cíl.
   *
   * Obyčejné SFTP rename podle specifikace selže, když cíl existuje — proto
   * nejdřív zkusíme rozšíření posix-rename@openssh.com, které umí nahradit
   * jedním krokem a bez okamžiku, kdy soubor neexistuje. Když ho server nemá,
   * zbývá smazat a přejmenovat.
   */
  async replace(from, to) {
    try {
      await this.client.posixRename(from, to);
      return;
    } catch { /* server rozšíření nemá */ }

    try {
      await this.client.rename(from, to);
      return;
    } catch { /* cíl nejspíš existuje */ }

    await this.client.delete(to, true);
    await this.client.rename(from, to);
  }

  /**
   * Kopie souboru přímo na serveru.
   *
   * Nejdřív zkusíme `cp` přes shell — data pak vůbec neopustí server a kopie
   * je hotová okamžitě i u velkého souboru.
   *
   * Když to nevyjde, protéká kopie skrz nás. Důvodů je víc než jeden: server
   * nemusí shell pouštět vůbec, a i když ho pustí, může být SFTP uzavřené
   * v jiném kořeni než shell — pak `cp` tutéž cestu prostě nenajde. V obou
   * případech je záskok lepší než odmítnout práci.
   */
  async copy(from, to) {
    let duvod = null;
    try {
      const res = await this.exec(`cp -p -- ${shellQuote(from)} ${shellQuote(to)}`, { timeoutMs: 60000 });
      if (res.code === 0) return { serverSide: true };
      duvod = (res.output || '').trim() || `cp skončilo s kódem ${res.code}`;
    } catch (err) {
      duvod = err && err.message ? err.message : 'shell není k dispozici';
    }

    try {
      await this.client.rcopy(from, to);
      return { serverSide: false, reason: duvod };
    } catch (err) {
      throw new Error(`${err.message} (přes shell to taky nešlo: ${duvod})`);
    }
  }

  /** Symbolický odkaz. Cíl se nekontroluje — smí ukazovat i jinam. */
  async symlink(target, linkPath) {
    return new Promise((resolve, reject) => {
      this.client.sftp.symlink(target, linkPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async chmod(remotePath, mode) {
    await this.client.chmod(remotePath, mode);
  }

  /** Změna vlastníka a skupiny; SFTP zná jen čísla, ne jména. */
  chown(remotePath, uid, gid) {
    return new Promise((resolve, reject) => {
      this.client.sftp.chown(remotePath, Number(uid), Number(gid), (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Kontrolní součet souboru na serveru.
   *
   * SFTP ho neumí, počítá se tedy příkazem přes SSH. Různé systémy mají různé
   * nástroje, proto se zkouší postupně — a vrací se první, který projde.
   */
  async checksum(remotePath, algo = 'sha256') {
    const tools = algo === 'md5'
      ? ['md5sum', 'md5 -q']
      : [`${algo}sum`, `shasum -a ${algo.replace('sha', '')}`];

    for (const tool of tools) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.exec(`${tool} ${shellQuote(remotePath)}`, { timeoutMs: 120000 })
        .catch(() => null);
      if (res && res.code === 0) {
        const hash = res.output.trim().split(/\s+/)[0];
        if (/^[0-9a-f]{16,}$/i.test(hash)) return { algo, hash, tool: tool.split(' ')[0] };
      }
    }
    throw new Error(`Server neumí spočítat ${algo} — chybí md5sum, shasum ani ${algo}sum`);
  }

  /**
   * Spustí příkaz na serveru přes SSH.
   *
   * Každé spuštění je samostatný neinteraktivní shell, takže `cd` mezi
   * příkazy nedrží. Pracovní adresář proto vkládáme před příkaz — jinak by
   * všechno běželo v domovském adresáři, což je proti očekávání člověka,
   * který kouká na otevřenou složku v panelu.
   */
  exec(command, { cwd = '', onData, timeoutMs = 60000, maxOutput = 1024 * 1024 } = {}) {
    const client = this.client.client; // ssh2 Client uvnitř ssh2-sftp-client
    if (!client) throw new Error('Nejste připojeni');

    const full = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;

    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      let truncated = false;
      let timer = null;

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const collect = (text, kind) => {
        if (output.length < maxOutput) {
          output += text;
          if (output.length >= maxOutput) {
            truncated = true;
            output = output.slice(0, maxOutput);
          }
        }
        if (onData) onData(text, kind);
      };

      client.exec(full, (err, stream) => {
        // Servery nastavené jen pro přenos souborů shell nepustí. Označíme to,
        // ať se volající může zařídit jinak místo aby to hlásil jako chybu.
        if (err) { finish(reject, Object.assign(err, { noShell: true })); return; }

        timer = setTimeout(() => {
          try { stream.close(); } catch { /* už zavřený */ }
          finish(reject, new Error(`Příkaz běžel déle než ${Math.round(timeoutMs / 1000)} s a byl přerušen`));
        }, timeoutMs);

        stream.on('data', (d) => collect(d.toString('utf8'), 'out'));
        stream.stderr.on('data', (d) => collect(d.toString('utf8'), 'err'));
        stream.on('error', (e) => finish(reject, e));
        stream.on('close', (code, signalName) => {
          finish(resolve, {
            code: code ?? 0, signal: signalName || null, output, truncated, command: full,
          });
        });
      });
    });
  }

  /**
   * Nastaví čas změny vzdáleného souboru. Bez toho by měl každý nahraný
   * soubor čas "teď" a synchronizace by ho příště zase označila za změněný.
   */
  utimes(remotePath, atimeMs, mtimeMs) {
    return new Promise((resolve, reject) => {
      this.client.sftp.utimes(
        remotePath,
        Math.floor(atimeMs / 1000),
        Math.floor(mtimeMs / 1000),
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * Stažení s podporou navázání. `startAt > 0` znamená, že lokální soubor
   * už obsahuje prvních startAt bajtů a dopisujeme za ně.
   */
  download(remotePath, localPath, {
    startAt = 0, onProgress, signal, limiters, transform,
  } = {}) {
    return new Promise((resolve, reject) => {
      const rs = this.client.createReadStream(remotePath, startAt > 0 ? { start: startAt } : {});
      const ws = fs.createWriteStream(localPath, startAt > 0 ? { flags: 'a' } : { flags: 'w' });
      pumpStreams(rs, ws, startAt, onProgress, signal, resolve, reject, limiters, transform);
    });
  }

  /**
   * Upload s podporou navázání (dopsání za existující bajty na serveru).
   *
   * Pro navázání schválně nepoužíváme režim 'a'. Knihovna si v něm zjišťuje
   * pozici asynchronně přes fstat, takže když se zápis rozjede dřív, než
   * odpověď dorazí, začne zapisovat od nuly — soubor na serveru se tím ořízne
   * a přijdeme o už přenesenou část. S 'r+' a explicitním `start` je pozice
   * nastavená rovnou v konstruktoru a žádný závod nevzniká.
   */
  upload(localPath, remotePath, {
    startAt = 0, onProgress, signal, limiters, transform,
  } = {}) {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(localPath, startAt > 0 ? { start: startAt } : {});
      const ws = this.client.createWriteStream(
        remotePath,
        startAt > 0 ? { flags: 'r+', start: startAt } : { flags: 'w' },
      );
      pumpStreams(rs, ws, startAt, onProgress, signal, resolve, reject, limiters, transform);
    });
  }
}

function pumpStreams(rs, ws, startAt, onProgress, signal, resolve, reject, limiters, transform) {
  let transferred = startAt;
  let settled = false;
  const throttle = makeThrottle(limiters);
  // Textový režim: převod konců řádků. Řadí se hned za čtení, aby se počítal
  // průběh podle zdroje — velikost po převodu je jiná a ukazatel by lhal.
  const prevod = transform ? transform() : null;

  const finish = (err) => {
    if (settled) return;
    settled = true;
    if (signal) signal.removeListener('abort', onAbort);
    if (err) {
      rs.destroy();
      if (throttle) throttle.destroy();
      if (prevod) prevod.destroy();
      ws.destroy();
      reject(err);
    } else {
      resolve(transferred);
    }
  };

  const onAbort = () => finish(Object.assign(new Error('Přenos přerušen'), { aborted: true }));

  if (signal) {
    if (signal.aborted) return onAbort();
    signal.once('abort', onAbort);
  }

  // Průběh počítáme až za omezovačem — před ním by ukazoval rychlost, kterou
  // data teprve mají projít.
  const counted = throttle || rs;
  counted.on('data', (chunk) => {
    transferred += chunk.length;
    if (onProgress) onProgress(transferred);
  });

  rs.on('error', finish);
  ws.on('error', finish);
  if (throttle) throttle.on('error', finish);
  if (prevod) prevod.on('error', finish);
  ws.on('close', () => finish(null));

  let proud = rs;
  if (throttle) proud = proud.pipe(throttle);
  if (prevod) proud = proud.pipe(prevod);
  proud.pipe(ws);
  return undefined;
}

function rightsToOctal(rights) {
  if (!rights) return null;
  const bit = (s) => (s.includes('r') ? 4 : 0) + (s.includes('w') ? 2 : 0) + (s.includes('x') ? 1 : 0);
  return (bit(rights.user || '') * 64) + (bit(rights.group || '') * 8) + bit(rights.other || '');
}

module.exports = { SftpAdapter, expandHome };
