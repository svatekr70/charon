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
 * @param {'diff'|'newer'|'timestamps'} opts.mode  co se má přenášet:
 *   `diff` přenese vše, co se liší (cíl bude přesnou kopií zdroje),
 *   `newer` jen to, co je na zdroji novější (nepřepíše čerstvější práci
 *   na druhé straně), `timestamps` nepřenáší nic a jen srovná časy u souborů,
 *   které se liší pouze jimi.
 * @param {boolean} opts.onlyExisting nezakládat nic nového; aktualizovat jen to,
 *   co má protějšek na obou stranách
 * @param {boolean} opts.deleteExtra  smazat, co na druhé straně nemá protějšek
 * @param {number} opts.toleranceMs   FTP hlásí čas často jen na minuty
 * @param {string} opts.mask          maska souborů, prázdná = bez omezení
 */
async function compare(adapter, localRoot, remoteRoot, opts = {}) {
  const {
    direction = 'toRemote',
    criteria = 'timeSize',
    mode = 'diff',
    onlyExisting = false,
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

  // Režim, který jen srovnává časy, nesmí nic vytvořit ani smazat — a stejně
  // tak režim, který má jen aktualizovat, co na obou stranách už je.
  const jenCasy = mode === 'timestamps';
  const zaklada = !jenCasy && !onlyExisting;

  // Adresáře nejdřív, aby při aplikaci existovaly dřív než soubory v nich.
  if (zaklada) {
    for (const [rel, l] of local) {
      if (l.type !== 'd' || remote.has(rel)) continue;
      if (wantsUp) actions.push({ action: 'mkdirRemote', rel, remotePath: rPath(rel), size: 0 });
    }
    for (const [rel, r] of remote) {
      if (r.type !== 'd' || local.has(rel)) continue;
      if (wantsDown) actions.push({ action: 'mkdirLocal', rel, localPath: lPath(rel), size: 0 });
    }
  }

  const nahrat = (rel, l, why) => ({ action: 'upload', rel, localPath: lPath(rel), remotePath: rPath(rel), size: l.size, why });
  const stahnout = (rel, r, why) => ({ action: 'download', rel, localPath: lPath(rel), remotePath: rPath(rel), size: r.size, why });

  for (const [rel, l] of local) {
    if (l.type !== 'f') continue;
    const r = remote.get(rel);
    if (!r) {
      if (wantsUp && zaklada) {
        actions.push(nahrat(rel, l, 'chybí na serveru'));
      } else if (wantsDown && deleteExtra && !jenCasy) {
        actions.push({ action: 'deleteLocal', rel, localPath: lPath(rel), size: l.size, why: 'není na serveru' });
      }
      continue;
    }
    if (r.type !== 'f' || !differs(l, r)) continue;

    // Srovnání času: obsah nechat být, jen dorovnat razítko. Když se liší
    // i velikost, obsah stejný není a sahat na čas by jen zamaskovalo rozdíl.
    if (jenCasy) {
      if (l.size !== r.size) continue;
      if (wantsUp && (direction !== 'both' || newerLocal(l, r))) {
        actions.push({ action: 'touchRemote', rel, remotePath: rPath(rel), localPath: lPath(rel), size: 0, mtime: l.mtime, why: 'srovnat čas podle lokálního' });
      } else if (wantsDown) {
        actions.push({ action: 'touchLocal', rel, localPath: lPath(rel), remotePath: rPath(rel), size: 0, mtime: r.mtime, why: 'srovnat čas podle serveru' });
      }
      continue;
    }

    if (direction === 'both') {
      if (newerLocal(l, r)) actions.push(nahrat(rel, l, 'lokální je novější'));
      else if (newerRemote(l, r)) actions.push(stahnout(rel, r, 'vzdálený je novější'));
      else {
        actions.push({
          action: 'conflict', rel, localPath: lPath(rel), remotePath: rPath(rel),
          size: l.size, why: 'liší se velikostí, čas je stejný',
          localSize: l.size, remoteSize: r.size, localMtime: l.mtime, remoteMtime: r.mtime,
        });
      }
    } else if (wantsUp) {
      // Režim „jen novější" nepřepíše čerstvější práci na druhé straně;
      // co je na cíli novější, se ohlásí jako konflikt, ne že se to ztratí.
      if (mode === 'newer' && !newerLocal(l, r)) {
        actions.push({
          action: 'conflict', rel, localPath: lPath(rel), remotePath: rPath(rel),
          size: l.size, why: newerRemote(l, r) ? 'na serveru je novější' : 'liší se, čas je stejný',
          localSize: l.size, remoteSize: r.size, localMtime: l.mtime, remoteMtime: r.mtime,
        });
      } else {
        actions.push(nahrat(rel, l, describeDiff(l, r)));
      }
    } else if (mode === 'newer' && !newerRemote(l, r)) {
      actions.push({
        action: 'conflict', rel, localPath: lPath(rel), remotePath: rPath(rel),
        size: r.size, why: newerLocal(l, r) ? 'lokální je novější' : 'liší se, čas je stejný',
        localSize: l.size, remoteSize: r.size, localMtime: l.mtime, remoteMtime: r.mtime,
      });
    } else {
      actions.push(stahnout(rel, r, describeDiff(r, l)));
    }
  }

  for (const [rel, r] of remote) {
    if (r.type !== 'f' || local.has(rel)) continue;
    if (wantsDown && zaklada) {
      actions.push(stahnout(rel, r, 'chybí lokálně'));
    } else if (wantsUp && deleteExtra && !jenCasy) {
      actions.push({ action: 'deleteRemote', rel, remotePath: rPath(rel), size: r.size, why: 'není lokálně' });
    }
  }

  if (deleteExtra && !jenCasy) {
    for (const [rel, r] of remote) {
      if (r.type === 'd' && !local.has(rel) && wantsUp) {
        actions.push({ action: 'rmdirRemote', rel, remotePath: rPath(rel), size: 0, why: 'není lokálně' });
      }
    }
  }

  const order = {
    mkdirLocal: 0, mkdirRemote: 0, upload: 1, download: 1,
    touchRemote: 1, touchLocal: 1, conflict: 2,
    deleteLocal: 3, deleteRemote: 3, rmdirRemote: 4,
  };
  actions.sort((a, b) => (order[a.action] - order[b.action]) || a.rel.localeCompare(b.rel, 'cs'));

  return {
    actions,
    localCount: [...local.values()].filter((v) => v.type === 'f').length,
    remoteCount: [...remote.values()].filter((v) => v.type === 'f').length,
    skipped: stats.skipped,
    toleranceMs,
    mode,
  };
}

function describeDiff(a, b) {
  if (a.size !== b.size) return `jiná velikost (${a.size} / ${b.size} B)`;
  return 'jiný čas změny';
}

module.exports = { compare, walkLocal, walkRemote };
