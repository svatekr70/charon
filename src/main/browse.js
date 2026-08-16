'use strict';

const fsp = require('fs').promises;
const path = require('path');

const posix = path.posix;
const FileMask = require('../common/mask');

/**
 * Procházení stromů: dopočítání velikosti složek a hledání souborů.
 *
 * Odděleno od hlavního procesu schválně — nic z toho nepotřebuje Electron,
 * takže se to dá testovat proti skutečnému serveru bez spouštění aplikace.
 */

/** Hlouběji než tohle se nezanořujeme; chrání to před smyčkami a překlepy. */
const MAX_DEPTH = 40;

/** Rekurzivně sečte velikost lokální složky. */
async function localDirSize(dir, depth = 0, acc = { bytes: 0, files: 0, dirs: 0 }) {
  if (depth > MAX_DEPTH) return acc;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }

  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // odkazy nesledujeme, dělaly by smyčky
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      acc.dirs += 1;
      await localDirSize(full, depth + 1, acc);
    } else {
      const st = await fsp.stat(full).catch(() => null);
      if (st) { acc.bytes += st.size; acc.files += 1; }
    }
  }
  return acc;
}

/** Totéž na serveru. */
async function remoteDirSize(adapter, dir, depth = 0, acc = { bytes: 0, files: 0, dirs: 0 }) {
  if (depth > MAX_DEPTH) return acc;
  let entries;
  try { entries = await adapter.list(dir); } catch { return acc; }

  for (const e of entries) {
    if (e.name === '.' || e.name === '..' || e.type === 'l') continue;
    if (e.type === 'd') {
      acc.dirs += 1;
      await remoteDirSize(adapter, posix.join(dir, e.name), depth + 1, acc);
    } else {
      acc.bytes += e.size || 0;
      acc.files += 1;
    }
  }
  return acc;
}

/**
 * Hledání souborů na serveru.
 *
 * Nálezy hlásí průběžně přes `onProgress`, aby se u velkých stromů dalo
 * začít pracovat dřív, než hledání doběhne. Jedna instance = jedno hledání;
 * `cancel()` ho zastaví na nejbližší položce.
 */
class Finder {
  constructor({ limit = 5000 } = {}) {
    this.canceled = false;
    this.running = false;
    this.limit = limit;
  }

  cancel() {
    this.canceled = true;
  }

  async run(adapter, root, maskText, { includeDirs = false, onProgress = () => {} } = {}) {
    if (this.running) throw new Error('Hledání už běží');
    this.running = true;
    this.canceled = false;

    const mask = FileMask.compile(maskText);
    const hits = [];
    let scanned = 0;

    const walk = async (dir, depth) => {
      if (this.canceled || depth > MAX_DEPTH || hits.length >= this.limit) return;
      let entries;
      try { entries = await adapter.list(dir); } catch { return; }

      for (const e of entries) {
        if (this.canceled || hits.length >= this.limit) return;
        if (e.name === '.' || e.name === '..') continue;
        scanned += 1;

        const full = posix.join(dir, e.name);
        const isDir = e.type === 'd';

        if ((!isDir || includeDirs) && mask.match(e.name, isDir)) {
          const hit = { path: full, dir, name: e.name, type: e.type, size: e.size, mtime: e.mtime };
          hits.push(hit);
          onProgress({ hit, scanned });
        } else if (scanned % 200 === 0) {
          onProgress({ scanned });
        }

        // Do odkazů nelezeme — vedly by ke smyčkám i mimo hledaný strom.
        if (isDir && e.type !== 'l') await walk(full, depth + 1);
      }
    };

    try {
      await walk(root, 0);
      return {
        hits,
        total: hits.length,
        scanned,
        canceled: this.canceled,
        truncated: hits.length >= this.limit,
      };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { localDirSize, remoteDirSize, Finder, MAX_DEPTH };
