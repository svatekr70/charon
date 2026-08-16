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

/**
 * Rozbalí vybranou položku na jednotlivé soubory pro frontu přenosů.
 *
 * Maska se testuje na jednom místě — hned na začátku, ať jde o kořen výběru
 * nebo o položku hluboko ve stromu. Díky tomu platí i na složku, kterou
 * uživatel označil ručně; kdyby ne, vyloučené `node_modules/` by se po
 * označení a F5 stejně nahrálo a maska by mlčky neplatila.
 */
async function expandLocal(localPath, remoteBase, out = [], mask = null, stats = { skipped: 0 }) {
  const st = await fsp.stat(localPath).catch(() => null);
  if (!st) return out;
  const name = path.basename(localPath);

  if (st.isFile()) {
    if (mask && !mask.matchFile(name)) { stats.skipped += 1; return out; }
    out.push({ direction: 'up', localPath, remotePath: remoteBase, size: st.size });
    return out;
  }
  if (!st.isDirectory()) return out;
  if (mask && !mask.allowDir(name)) { stats.skipped += 1; return out; }

  const entries = await fsp.readdir(localPath, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) {
    // Prázdnou složku je potřeba na serveru založit zvlášť, žádný soubor
    // ji tam jinak nevytvoří.
    out.push({ direction: 'mkdirRemote', remotePath: remoteBase });
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    await expandLocal(path.join(localPath, e.name), posix.join(remoteBase, e.name), out, mask, stats);
  }
  return out;
}

/** Totéž opačným směrem. */
async function expandRemote(adapter, remotePath, localBase, out = [], mask = null, stats = { skipped: 0 }) {
  const name = posix.basename(remotePath);
  let entries = null;
  try { entries = await adapter.list(remotePath); } catch { /* není adresář */ }

  if (entries === null) {
    if (mask && !mask.matchFile(name)) { stats.skipped += 1; return out; }
    const st = await adapter.stat(remotePath);
    out.push({ direction: 'down', remotePath, localPath: localBase, size: st.size });
    return out;
  }

  if (mask && !mask.allowDir(name)) { stats.skipped += 1; return out; }
  await fsp.mkdir(localBase, { recursive: true });

  for (const e of entries) {
    if (e.name === '.' || e.name === '..' || e.type === 'l') continue;
    const r = posix.join(remotePath, e.name);
    const l = path.join(localBase, e.name);
    if (e.type === 'd') {
      await expandRemote(adapter, r, l, out, mask, stats);
    } else {
      if (mask && !mask.matchFile(e.name)) { stats.skipped += 1; continue; }
      out.push({ direction: 'down', remotePath: r, localPath: l, size: e.size });
    }
  }
  return out;
}

/**
 * Rekurzivní změna práv na serveru.
 *
 * Složky a soubory dostávají jiná práva — 755 a 644 dávají smysl vedle sebe,
 * 644 na složce by ji znepřístupnilo. Proto se předávají obě hodnoty.
 */
async function remoteChmod(adapter, target, { fileMode, dirMode, depth = 0 }, stats = { files: 0, dirs: 0 }) {
  if (depth > MAX_DEPTH) return stats;

  let entries = null;
  try { entries = await adapter.list(target); } catch { /* není složka */ }

  if (entries === null) {
    if (fileMode !== null) { await adapter.chmod(target, fileMode); stats.files += 1; }
    return stats;
  }

  if (dirMode !== null) { await adapter.chmod(target, dirMode); stats.dirs += 1; }
  for (const e of entries) {
    if (e.name === '.' || e.name === '..' || e.type === 'l') continue;
    await remoteChmod(adapter, posix.join(target, e.name), { fileMode, dirMode, depth: depth + 1 }, stats);
  }
  return stats;
}

module.exports = {
  localDirSize, remoteDirSize, Finder, expandLocal, expandRemote, remoteChmod, MAX_DEPTH,
};
