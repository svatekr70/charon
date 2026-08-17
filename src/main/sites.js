'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const vault = require('./vault');
const { repairMojibake } = require('./winscp-import');

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
    await this._repairNames();
    return this.sites;
  }

  /**
   * Napraví názvy rozsypané dřívějším importem z WinSCP.
   *
   * Escapované bajty se kdysi četly po jednom, takže se ze „Šárka" stalo
   * „Å ÃƒÂ¡rka". Opravit to jde spolehlivě zpětným převodem, tak to uděláme
   * jednou při načtení — ručně přejmenovat devatenáct složek by byla otrava.
   */
  async _repairNames() {
    let zmeneno = 0;
    for (const site of this.sites) {
      for (const pole of ['name', 'folder', 'note']) {
        const opraveno = repairMojibake(site[pole]);
        if (opraveno !== undefined && opraveno !== site[pole]) {
          site[pole] = opraveno;
          zmeneno += 1;
        }
      }
    }
    if (zmeneno) await this.save();
    return zmeneno;
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
    return this.sites.map(({
      password, passphrase, tunnelPassword, proxyPassword, ...rest
    }) => ({
      ...rest,
      hasPassword: Boolean(password),
      hasPassphrase: Boolean(passphrase),
      hasTunnelPassword: Boolean(tunnelPassword),
      hasProxyPassword: Boolean(proxyPassword),
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
      // Práva nahraných souborů pro tenhle server. Prázdné = platí nastavení
      // aplikace; vyplňuje se jen tam, kde se hosting chová jinak než zbytek.
      uploadPerms: site.uploadPerms || '',
      uploadFileMode: site.uploadFileMode || '',
      uploadDirMode: site.uploadDirMode || '',
      rejectUnauthorized: site.rejectUnauthorized !== false,
      // Otisky potvrzené uživatelem; mění je jen setHostKey/setTlsFingerprint.
      hostKeyFingerprint: existing ? existing.hostKeyFingerprint || '' : '',
      tunnelHostKeyFingerprint: existing ? existing.tunnelHostKeyFingerprint || '' : '',
      tlsFingerprint: existing ? existing.tlsFingerprint || '' : '',
      // Vizuální pojistka: barva a poznámka, aby se produkce nepletla s testem.
      // Jen pro FTP: starší servery neumí UTF-8 a hlásí čas v místní zóně.
      anonymous: Boolean(site.anonymous),
      encoding: site.encoding || 'auto',
      timeShiftMinutes: Number(site.timeShiftMinutes) || 0,
      color: site.color || '',
      note: site.note || '',
      useRecycleBin: site.useRecycleBin !== undefined ? Boolean(site.useRecycleBin) : true,
      recycleBinPath: site.recycleBinPath || '',
      recycleBinDays: Number(site.recycleBinDays) || 0,
      // Cesta k serveru, když nevede přímo (jen SFTP).
      tunnelHost: site.tunnelHost || '',
      tunnelPort: Number(site.tunnelPort) || 22,
      tunnelUsername: site.tunnelUsername || '',
      tunnelKeyPath: site.tunnelKeyPath || '',
      proxyType: site.proxyType || 'none',
      proxyHost: site.proxyHost || '',
      proxyPort: Number(site.proxyPort) || 0,
      proxyUsername: site.proxyUsername || '',
      // Naposledy použité nastavení synchronizace; mění ho jen setSync.
      sync: existing ? existing.sync || null : null,
      tunnelPassword: existing ? existing.tunnelPassword : '',
      proxyPassword: existing ? existing.proxyPassword : '',
      password: existing ? existing.password : '',
      passphrase: existing ? existing.passphrase : '',
    };

    // Změna serveru, portu nebo uživatele znamená jiný stroj — starý otisk
    // by pak potvrzoval něco jiného, než k čemu se připojujeme.
    if (existing && (existing.host !== record.host || Number(existing.port) !== Number(record.port))) {
      record.hostKeyFingerprint = '';
      record.tlsFingerprint = '';
    }
    // Totéž pro bránu — po její výměně nemá starý otisk co potvrzovat.
    if (existing && (existing.tunnelHost !== record.tunnelHost
      || Number(existing.tunnelPort) !== Number(record.tunnelPort))) {
      record.tunnelHostKeyFingerprint = '';
    }

    // Heslo přepisujeme jen když přišlo — jinak si necháme to uložené.
    if (site.password !== undefined) record.password = await vault.encrypt(site.password);
    if (site.passphrase !== undefined) record.passphrase = await vault.encrypt(site.passphrase);
    if (site.tunnelPassword !== undefined) record.tunnelPassword = await vault.encrypt(site.tunnelPassword);
    if (site.proxyPassword !== undefined) record.proxyPassword = await vault.encrypt(site.proxyPassword);

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

  /**
   * Zapamatuje si nastavení synchronizace u relace.
   *
   * Ukládá se směr, kritérium, maska a mazání — ne cesty. Ty určují panely,
   * ve kterých člověk zrovna stojí, a předvyplnit je odjinud by znamenalo
   * synchronizovat něco jiného, než na co se dívá.
   */
  async setSync(id, sync) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    site.sync = sync ? {
      direction: String(sync.direction || ''),
      criteria: String(sync.criteria || ''),
      mask: String(sync.mask || ''),
      deleteExtra: Boolean(sync.deleteExtra),
    } : null;
    await this.save();
  }

  /** Uloží potvrzený otisk klíče brány, přes kterou se jde. */
  async setTunnelHostKey(id, fingerprint) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    site.tunnelHostKeyFingerprint = fingerprint || '';
    await this.save();
  }

  /** Uloží potvrzený otisk TLS certifikátu (FTPS). */
  async setTlsFingerprint(id, fingerprint) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) return;
    site.tlsFingerprint = fingerprint || '';
    await this.save();
  }

  /**
   * Kopie relace i s hesly.
   *
   * Dělá se to tady, a ne v okně: okno hesla nemá — dostane je jen na
   * vyžádání okem u pole — takže kopie sestavená tam by o ně přišla.
   */
  async duplicate(id) {
    const site = this.sites.find((s) => s.id === id);
    if (!site) throw new Error('Relace neexistuje');

    const zaklad = `${site.name} (kopie)`;
    let name = zaklad;
    for (let i = 2; this.sites.some((s) => s.name === name && s.folder === site.folder); i += 1) {
      name = `${zaklad} ${i}`;
    }

    const kopie = { ...site, id: crypto.randomUUID(), name };
    this.sites.push(kopie);
    await this.save();
    return kopie.id;
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
      tunnelPassword: await vault.decrypt(site.tunnelPassword),
      proxyPassword: await vault.decrypt(site.proxyPassword),
    };
  }

  /**
   * Rozšifruje jedno uložené heslo.
   *
   * Do okna se hesla jinak neposílají — tohle je jediná cesta a otevře ji až
   * kliknutí na oko v editoru relace. Vrací se vždy jen to jedno pole, o které
   * si okno řeklo, ne celá relace.
   */
  async reveal(id, field) {
    const povolena = ['password', 'passphrase', 'tunnelPassword', 'proxyPassword'];
    if (!povolena.includes(field)) throw new Error('Tohle pole není heslo');
    const site = this.sites.find((s) => s.id === id);
    if (!site) throw new Error('Relace neexistuje');
    return vault.decrypt(site[field]);
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
        // Bránu zná import z ~/.ssh/config (ProxyJump); z WinSCP nechodí.
        tunnelHost: s.tunnelHost || '',
        tunnelPort: s.tunnelPort || 22,
        tunnelUsername: s.tunnelUsername || '',
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
