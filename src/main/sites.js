'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const vault = require('./vault');

/**
 * Uložené relace ("záložky"). Struktura odpovídá tomu, co umí WinSCP importér,
 * takže import je jen mapování 1:1 plus vygenerování id.
 */
class SiteStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'sites.json');
    this.sites = [];
  }

  async load() {
    try {
      this.sites = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      this.sites = [];
    }
    return this.sites;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    // Zapisujeme přes dočasný soubor, aby pád uprostřed zápisu nesmazal záložky.
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.sites, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  /** Seznam pro UI — bez hesel. */
  list() {
    return this.sites.map(({ password, passphrase, ...rest }) => ({
      ...rest,
      hasPassword: Boolean(password),
      hasPassphrase: Boolean(passphrase),
    }));
  }

  async upsert(site) {
    const id = site.id || crypto.randomUUID();
    const existing = this.sites.find((s) => s.id === id);

    const record = {
      id,
      name: site.name || site.host,
      folder: site.folder || '',
      protocol: site.protocol === 'ftp' ? 'ftp' : 'sftp',
      host: site.host,
      port: Number(site.port) || (site.protocol === 'ftp' ? 21 : 22),
      username: site.username || '',
      ftps: site.ftps || 'none',
      privateKeyPath: site.privateKeyPath || '',
      useAgent: Boolean(site.useAgent),
      remoteDir: site.remoteDir || '',
      localDir: site.localDir || '',
      rejectUnauthorized: site.rejectUnauthorized !== false,
      // Otisky potvrzené uživatelem; mění je jen setHostKey/setTlsFingerprint.
      hostKeyFingerprint: existing ? existing.hostKeyFingerprint || '' : '',
      tlsFingerprint: existing ? existing.tlsFingerprint || '' : '',
      useRecycleBin: site.useRecycleBin !== undefined ? Boolean(site.useRecycleBin) : true,
      recycleBinPath: site.recycleBinPath || '',
      recycleBinDays: Number(site.recycleBinDays) || 0,
      password: existing ? existing.password : '',
      passphrase: existing ? existing.passphrase : '',
    };

    // Změna serveru, portu nebo uživatele znamená jiný stroj — starý otisk
    // by pak potvrzoval něco jiného, než k čemu se připojujeme.
    if (existing && (existing.host !== record.host || Number(existing.port) !== Number(record.port))) {
      record.hostKeyFingerprint = '';
      record.tlsFingerprint = '';
    }

    // Heslo přepisujeme jen když přišlo — jinak si necháme to uložené.
    if (site.password !== undefined) record.password = await vault.encrypt(site.password);
    if (site.passphrase !== undefined) record.passphrase = await vault.encrypt(site.passphrase);

    if (existing) Object.assign(existing, record);
    else this.sites.push(record);

    await this.save();
    return id;
  }

  /** Uloží potvrzený otisk klíče serveru (SFTP). */
  async setHostKey(id, fingerprint) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    site.hostKeyFingerprint = fingerprint || '';
    await this.save();
  }

  /** Uloží potvrzený otisk TLS certifikátu (FTPS). */
  async setTlsFingerprint(id, fingerprint) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    site.tlsFingerprint = fingerprint || '';
    await this.save();
  }

  async remove(id) {
    this.sites = this.sites.filter((s) => s.id !== id);
    await this.save();
  }

  /** Plná konfigurace pro připojení, včetně rozšifrovaných hesel. */
  async resolve(id) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) throw new Error('Relace neexistuje');
    return {
      ...site,
      password: await vault.decrypt(site.password),
      passphrase: await vault.decrypt(site.passphrase),
    };
  }

  /** Hromadný import (WinSCP). Vrací počty. */
  async importMany(sessions, { overwrite = false } = {}) {
    let added = 0;
    let skipped = 0;
    for (const s of sessions) {
      const dup = this.sites.find(
        (x) => x.host === s.host && x.username === s.username && Number(x.port) === Number(s.port),
      );
      if (dup && !overwrite) { skipped += 1; continue; }

      const folder = s.name.includes('/') ? s.name.slice(0, s.name.lastIndexOf('/')) : '';
      const leaf = s.name.includes('/') ? s.name.slice(s.name.lastIndexOf('/') + 1) : s.name;

      await this.upsert({
        id: dup ? dup.id : undefined,
        name: leaf,
        folder,
        protocol: s.protocol,
        host: s.host,
        port: s.port,
        username: s.username,
        ftps: s.ftps,
        password: s.password || '',
        passphrase: s.passphrase || '',
        privateKeyPath: convertWindowsKeyPath(s.privateKeyPath),
        remoteDir: s.remoteDir,
        localDir: '', // windowsová cesta na Macu nedává smysl
      });
      added += 1;
    }
    return { added, skipped };
  }
}

/**
 * WinSCP ukládá cestu ke klíči jako windowsovou cestu k .ppk souboru.
 * Na Macu neexistuje, takže si ji jen poznamenáme jako komentář v názvu —
 * uživatel si klíč doplní ručně (a .ppk je navíc potřeba převést na OpenSSH).
 */
function convertWindowsKeyPath(p) {
  if (!p) return '';
  return /^[A-Za-z]:\\/.test(p) ? '' : p;
}

module.exports = { SiteStore, convertWindowsKeyPath };
