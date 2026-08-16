'use strict';

const posix = require('path').posix;

/**
 * Vzdálený koš.
 *
 * Lokálně se maže do systémového koše, na serveru se mazalo natvrdo — a to
 * zrovna tam, kde omyl bolí víc. Tenhle modul místo smazání přesune položku
 * pod složku koše a zachová v ní původní cestu, aby se dala ručně vrátit:
 *
 *   /var/www/html/index.php  →  <koš>/2026-08-16/var/www/html/index.php
 *
 * Přesun je jen přejmenování, takže nestojí žádný přenos dat. Pokud ho server
 * odmítne (koš na jiném svazku), chybu předáme volajícímu — nikdy nemažeme
 * natvrdo jako „záchranu".
 */

const DEFAULT_DIR_NAME = '.charon-trash';

/** Název složky pro dnešek. Datum bereme z parametru, ať jde test určit. */
function dayFolder(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

class RemoteTrash {
  /**
   * @param {object} adapter aktivní adaptér (SFTP nebo FTP)
   * @param {string} basePath absolutní cesta ke složce koše na serveru
   */
  constructor(adapter, basePath) {
    this.adapter = adapter;
    this.basePath = basePath;
  }

  /** Výchozí umístění koše — skrytá složka v domovském adresáři na serveru. */
  static defaultPath(home) {
    const base = home && home !== '.' ? home : '/';
    return posix.join(base, DEFAULT_DIR_NAME);
  }

  /**
   * Přesune položku do koše.
   * @returns {Promise<string>} nová cesta v koši
   */
  async moveToTrash(remotePath, now = new Date()) {
    const normalized = posix.normalize(remotePath).replace(/\/+$/, '') || '/';
    if (this._isInsideTrash(normalized)) {
      throw new Error('Položka už je v koši — smažte ji vysypáním koše');
    }

    const dayDir = posix.join(this.basePath, dayFolder(now));
    // Původní cestu zrcadlíme pod složku dne, aby bylo poznat, odkud pochází.
    const parent = posix.dirname(normalized);
    const targetDir = posix.join(dayDir, parent === '/' ? '' : parent);
    await this.adapter.mkdir(targetDir, true);

    const name = posix.basename(normalized);
    const finalName = await this._freeName(targetDir, name);
    const target = posix.join(targetDir, finalName);

    await this.adapter.rename(normalized, target);
    return target;
  }

  /** Najde volný název ve složce — při shodě přidá pořadové číslo. */
  async _freeName(dir, name) {
    let existing;
    try {
      existing = new Set((await this.adapter.list(dir)).map((e) => e.name));
    } catch {
      return name; // složka je čerstvě vytvořená a prázdná
    }
    if (!existing.has(name)) return name;

    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${stem}-${i}${ext}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('V koši je příliš mnoho položek stejného jména');
  }

  _isInsideTrash(remotePath) {
    const base = this.basePath.replace(/\/+$/, '');
    return remotePath === base || remotePath.startsWith(`${base}/`);
  }

  /** Obsah koše po dnech, včetně počtu položek. */
  async listDays() {
    let entries;
    try {
      entries = await this.adapter.list(this.basePath);
    } catch {
      return []; // koš ještě neexistuje
    }
    return entries
      .filter((e) => e.type === 'd' && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => ({ day: e.name, path: posix.join(this.basePath, e.name) }))
      .sort((a, b) => b.day.localeCompare(a.day));
  }

  /** Nevratně smaže celý obsah koše. */
  async empty() {
    const days = await this.listDays();
    for (const d of days) await this.adapter.removeDir(d.path, true);
    return days.length;
  }

  /**
   * Vyhodí z koše složky starší než zadaný počet dní.
   * @returns {Promise<string[]>} smazané dny
   */
  async cleanup(days, now = new Date()) {
    if (!days || days <= 0) return [];
    const cutoff = new Date(now.getTime() - days * 86400000);
    const limit = dayFolder(cutoff);

    const removed = [];
    for (const d of await this.listDays()) {
      if (d.day >= limit) continue; // porovnání řetězců stačí, formát je ISO
      await this.adapter.removeDir(d.path, true);
      removed.push(d.day);
    }
    return removed;
  }
}

module.exports = { RemoteTrash, dayFolder, DEFAULT_DIR_NAME };
