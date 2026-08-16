'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { makeThrottle } = require('../throttle');

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
      readyTimeout: 25000,
      keepaliveInterval: 10000,
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

    try {
      await this.client.connect(opts);
    } catch (err) {
      // Selhání handshaku kvůli odmítnutému klíči hlásí knihovna obecnou
      // hláškou — nahradíme ji tou, která říká, co se opravdu stalo.
      if (this._hostKeyRejected) {
        throw Object.assign(new Error(this._hostKeyRejected), { hostKeyRejected: true });
      }
      throw err;
    }
    this.connected = true;
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    try { await this.client.end(); } catch { /* spojení už mohlo spadnout */ }
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

  async chmod(remotePath, mode) {
    await this.client.chmod(remotePath, mode);
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
  download(remotePath, localPath, { startAt = 0, onProgress, signal, limiters } = {}) {
    return new Promise((resolve, reject) => {
      const rs = this.client.createReadStream(remotePath, startAt > 0 ? { start: startAt } : {});
      const ws = fs.createWriteStream(localPath, startAt > 0 ? { flags: 'a' } : { flags: 'w' });
      pumpStreams(rs, ws, startAt, onProgress, signal, resolve, reject, limiters);
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
  upload(localPath, remotePath, { startAt = 0, onProgress, signal, limiters } = {}) {
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(localPath, startAt > 0 ? { start: startAt } : {});
      const ws = this.client.createWriteStream(
        remotePath,
        startAt > 0 ? { flags: 'r+', start: startAt } : { flags: 'w' },
      );
      pumpStreams(rs, ws, startAt, onProgress, signal, resolve, reject, limiters);
    });
  }
}

function pumpStreams(rs, ws, startAt, onProgress, signal, resolve, reject, limiters) {
  let transferred = startAt;
  let settled = false;
  const throttle = makeThrottle(limiters);

  const finish = (err) => {
    if (settled) return;
    settled = true;
    if (signal) signal.removeListener('abort', onAbort);
    if (err) {
      rs.destroy();
      if (throttle) throttle.destroy();
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
  ws.on('close', () => finish(null));

  if (throttle) rs.pipe(throttle).pipe(ws);
  else rs.pipe(ws);
  return undefined;
}

function rightsToOctal(rights) {
  if (!rights) return null;
  const bit = (s) => (s.includes('r') ? 4 : 0) + (s.includes('w') ? 2 : 0) + (s.includes('x') ? 1 : 0);
  return (bit(rights.user || '') * 64) + (bit(rights.group || '') * 8) + bit(rights.other || '');
}

module.exports = { SftpAdapter, expandHome };
