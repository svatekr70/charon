'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const FileMask = require('../common/mask');

/**
 * Porovnání lokálního a vzdáleného adresáře — jádro "Synchronizace adresářů"
 * z WinSCP. Nejdřív se vždy jen spočítá seznam akcí, teprve po potvrzení
 * uživatelem se z nich udělají položky fronty.
 */

const MAX_DEPTH = 32;

async function walkLocal(root, { depth = 0, base = '', mask = null, stats } = {}, out = new Map()) {
  if (depth > MAX_DEPTH) return out;
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // symlinky nesledujeme, aby nevznikly smyčky
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = path.join(root, rel);
    if (e.isDirectory()) {
      if (mask && !mask.allowDir(e.name)) { if (stats) stats.skipped += 1; continue; }
      out.set(rel, { type: 'd', size: 0, mtime: null });
      await walkLocal(root, { depth: depth + 1, base: rel, mask, stats }, out);
    } else if (e.isFile()) {
      if (mask && !mask.matchFile(e.name)) { if (stats) stats.skipped += 1; continue; }
      const st = await fsp.stat(full).catch(() => null);
      if (st) out.set(rel, { type: 'f', size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

async function walkRemote(adapter, root, { depth = 0, base = '', mask = null, stats } = {}, out = new Map()) {
  if (depth > MAX_DEPTH) return out;
  const dir = base ? `${root.replace(/\/$/, '')}/${base}` : root;
  let entries;
  try {
    entries = await adapter.list(dir);
    // FTP bez MLSD hlásí ve výpisu čas jen na minuty a bez časové zóny.
    // Adaptér ho umí doplnit přesně; jinak by porovnání podle času lhalo.
    if (adapter.refineMtimes) await adapter.refineMtimes(dir, entries);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.' || e.name === '..' || e.type === 'l') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.type === 'd') {
      if (mask && !mask.allowDir(e.name)) { if (stats) stats.skipped += 1; continue; }
      out.set(rel, { type: 'd', size: 0, mtime: null });
      await walkRemote(adapter, root, { depth: depth + 1, base: rel, mask, stats }, out);
    } else {
      if (mask && !mask.matchFile(e.name)) { if (stats) stats.skipped += 1; continue; }
      out.set(rel, { type: 'f', size: e.size, mtime: e.mtime });
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {'toRemote'|'toLocal'|'both'} opts.direction
 * @param {'time'|'size'|'timeSize'} opts.criteria
 * @param {boolean} opts.deleteExtra  smazat, co na druhé straně nemá protějšek
 * @param {number} opts.toleranceMs   FTP hlásí čas často jen na minuty
 * @param {string} opts.mask          maska souborů, prázdná = bez omezení
 */
async function compare(adapter, localRoot, remoteRoot, opts = {}) {
  const {
    direction = 'toRemote',
    criteria = 'timeSize',
    deleteExtra = false,
    mask: maskText = '',
    toleranceMs = adapter.protocol === 'ftp' ? 61000 : 2000,
  } = opts;

  // Maska platí na obou stranách. Kdyby platila jen na jedné, soubory
  // vyloučené vlevo by se vpravo tvářily jako přebytek k smazání.
  const compiled = maskText && String(maskText).trim() ? FileMask.compile(maskText) : null;
  const mask = compiled && !compiled.empty ? compiled : null;
  const stats = { skipped: 0 };

  const [local, remote] = await Promise.all([
    walkLocal(localRoot, { mask, stats }),
    walkRemote(adapter, remoteRoot, { mask, stats }),
  ]);

  const actions = [];
  const rPath = (rel) => `${remoteRoot.replace(/\/$/, '')}/${rel}`;
  const lPath = (rel) => path.join(localRoot, rel);

  const differs = (a, b) => {
    if (criteria === 'size') return a.size !== b.size;
    if (criteria === 'time') return Math.abs((a.mtime ?? 0) - (b.mtime ?? 0)) > toleranceMs;
    return a.size !== b.size || Math.abs((a.mtime ?? 0) - (b.mtime ?? 0)) > toleranceMs;
  };

  const newerLocal = (l, r) => (l.mtime ?? 0) - (r.mtime ?? 0) > toleranceMs;
  const newerRemote = (l, r) => (r.mtime ?? 0) - (l.mtime ?? 0) > toleranceMs;

  const wantsUp = direction === 'toRemote' || direction === 'both';
  const wantsDown = direction === 'toLocal' || direction === 'both';

  // Adresáře nejdřív, aby při aplikaci existovaly dřív než soubory v nich.
  for (const [rel, l] of local) {
    if (l.type !== 'd' || remote.has(rel)) continue;
    if (wantsUp) actions.push({ action: 'mkdirRemote', rel, remotePath: rPath(rel), size: 0 });
  }
  for (const [rel, r] of remote) {
    if (r.type !== 'd' || local.has(rel)) continue;
    if (wantsDown) actions.push({ action: 'mkdirLocal', rel, localPath: lPath(rel), size: 0 });
  }

  for (const [rel, l] of local) {
    if (l.type !== 'f') continue;
    const r = remote.get(rel);
    if (!r) {
      if (wantsUp) {
        actions.push({ action: 'upload', rel, localPath: lPath(rel), remotePath: rPath(rel), size: l.size, why: 'chybí na serveru' });
      } else if (wantsDown && deleteExtra) {
        actions.push({ action: 'deleteLocal', rel, localPath: lPath(rel), size: l.size, why: 'není na serveru' });
      }
      continue;
    }
    if (r.type !== 'f' || !differs(l, r)) continue;

    if (direction === 'both') {
      if (newerLocal(l, r)) actions.push({ action: 'upload', rel, localPath: lPath(rel), remotePath: rPath(rel), size: l.size, why: 'lokální je novější' });
      else if (newerRemote(l, r)) actions.push({ action: 'download', rel, localPath: lPath(rel), remotePath: rPath(rel), size: r.size, why: 'vzdálený je novější' });
      else actions.push({ action: 'conflict', rel, localPath: lPath(rel), remotePath: rPath(rel), size: l.size, why: 'liší se velikostí, čas je stejný' });
    } else if (wantsUp) {
      actions.push({ action: 'upload', rel, localPath: lPath(rel), remotePath: rPath(rel), size: l.size, why: describeDiff(l, r) });
    } else {
      actions.push({ action: 'download', rel, localPath: lPath(rel), remotePath: rPath(rel), size: r.size, why: describeDiff(r, l) });
    }
  }

  for (const [rel, r] of remote) {
    if (r.type !== 'f' || local.has(rel)) continue;
    if (wantsDown) {
      actions.push({ action: 'download', rel, localPath: lPath(rel), remotePath: rPath(rel), size: r.size, why: 'chybí lokálně' });
    } else if (wantsUp && deleteExtra) {
      actions.push({ action: 'deleteRemote', rel, remotePath: rPath(rel), size: r.size, why: 'není lokálně' });
    }
  }

  if (deleteExtra) {
    for (const [rel, r] of remote) {
      if (r.type === 'd' && !local.has(rel) && wantsUp) {
        actions.push({ action: 'rmdirRemote', rel, remotePath: rPath(rel), size: 0, why: 'není lokálně' });
      }
    }
  }

  const order = {
    mkdirLocal: 0, mkdirRemote: 0, upload: 1, download: 1, conflict: 2,
    deleteLocal: 3, deleteRemote: 3, rmdirRemote: 4,
  };
  actions.sort((a, b) => (order[a.action] - order[b.action]) || a.rel.localeCompare(b.rel, 'cs'));

  return {
    actions,
    localCount: [...local.values()].filter((v) => v.type === 'f').length,
    remoteCount: [...remote.values()].filter((v) => v.type === 'f').length,
    skipped: stats.skipped,
    toleranceMs,
  };
}

function describeDiff(a, b) {
  if (a.size !== b.size) return `jiná velikost (${a.size} / ${b.size} B)`;
  return 'jiný čas změny';
}

module.exports = { compare, walkLocal, walkRemote };
