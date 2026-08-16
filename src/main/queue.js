'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { RateLimiter } = require('./throttle');

/** Jednoduchý přerušovací token — adaptéry na něj čekají přes .once('abort'). */
class AbortToken extends EventEmitter {
  constructor() {
    super();
    this.aborted = false;
    this.reason = null;
  }

  abort(reason = 'abort') {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.emit('abort', reason);
  }
}

/**
 * Fronta přenosů.
 *
 * Běží nad spojeními oddělenými od toho, kterým se prochází adresáře, a umí
 * jich mít víc naráz. U tisíců malých souborů rozhoduje latence, ne šířka
 * pásma, takže několik souběžných přenosů dělá násobný rozdíl.
 *
 * Rychlost se dá omezit globálně i u jedné položky; globální limit je sdílený
 * všemi pracovníky, aby platil dohromady, ne na každý přenos zvlášť.
 */
class TransferQueue extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.getAdapter vrátí adaptér pro přenosy
   * @param {Function} [opts.onConflict] zeptá se uživatele, co s existujícím
   *   cílovým souborem. Bez něj se cíl přepíše — což je v pořádku jen tam,
   *   kde o tom uživatel už rozhodl (synchronizace, uložení z editoru).
   * @param {Function} [opts.onMoveSource] smaže zdroj po úspěšném přenosu
   *   (přesun místo kopie). Fronta neví, kam se maže — to řeší volající.
   * @param {Function} opts.acquireAdapter půjčí spojení pro jeden přenos
   * @param {Function} [opts.releaseAdapter] vrátí spojení zpět do zásoby
   * @param {number} [opts.concurrency] kolik přenosů naráz
   */
  constructor({
    getAdapter, acquireAdapter, releaseAdapter, remoteJoin,
    onConflict, onMoveSource, concurrency = 1,
  }) {
    super();
    this.items = [];
    // getAdapter je zpětná kompatibilita pro volající, kteří zásobu neřeší
    // (typicky testy s jedním spojením).
    this.acquireAdapter = acquireAdapter || getAdapter;
    this.releaseAdapter = releaseAdapter || (() => {});
    this.remoteJoin = remoteJoin;
    this.onConflict = onConflict || null;
    this.onMoveSource = onMoveSource || null;
    this.concurrency = Math.max(1, concurrency);
    this.paused = false;
    this.workers = 0;
    /** id položky → přerušovací token právě běžícího přenosu */
    this.active = new Map();
    this._lastEmit = 0;
    // Volba „použít na všechny" platí do vyprázdnění fronty.
    this.policy = null;
    // Dotazy na konflikt řadíme za sebe, aby dva pracovníci nevyskočili
    // se dvěma dialogy naráz.
    this._conflictChain = Promise.resolve();
    /** Sdílený globální limit rychlosti; 0 = bez omezení. */
    this.limiter = new RateLimiter(0);
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Math.min(16, Math.floor(n) || 1));
    this._kick();
    this._emitUpdate(true);
  }

  /** Globální limit v bajtech za sekundu; 0 vypíná. */
  setSpeedLimit(bytesPerSecond) {
    this.limiter.setRate(bytesPerSecond);
    this._emitUpdate(true);
  }

  /** Limit jen pro jednu položku fronty. Projevit se může až u dalšího pokusu. */
  setItemSpeedLimit(id, bytesPerSecond) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    it.speedLimit = Math.max(0, Math.floor(bytesPerSecond) || 0);
    if (it.limiter) it.limiter.setRate(it.speedLimit);
    this._emitUpdate(true);
  }

  add(jobs) {
    const created = jobs.map((j) => ({
      id: crypto.randomUUID(),
      direction: j.direction, // 'up' | 'down'
      localPath: j.localPath,
      remotePath: j.remotePath,
      size: j.size ?? null,
      transferred: 0,
      status: 'pending',
      error: null,
      speed: 0,
      startedAt: null,
      // Přenosy, u kterých uživatel o přepisu už rozhodl jinde.
      conflictResolved: Boolean(j.conflictResolved),
      // Nastaví se u přesunu: 'local' nebo 'remote' podle toho, odkud se bere.
      moveFrom: j.moveFrom || null,
      speedLimit: Math.max(0, Math.floor(j.speedLimit) || 0),
      limiter: null,
      note: null,
    }));
    this.items.push(...created);
    this._emitUpdate(true);
    this._kick();
    return created.map((c) => c.id);
  }

  /** Zařadí jednu položku a počká, až doběhne. Používá editor při otevření/uložení. */
  addAndWait(job) {
    const [id] = this.add([job]);
    return new Promise((resolve, reject) => {
      const onUpdate = () => {
        const it = this.items.find((x) => x.id === id);
        if (!it || ['pending', 'active', 'paused'].includes(it.status)) return;
        this.off('update', onUpdate);
        if (it.status === 'done') resolve(it);
        else if (it.status === 'skipped') reject(new Error(it.note ? `Přeskočeno (${it.note})` : 'Přeskočeno'));
        else reject(new Error(it.error || 'Přenos zrušen'));
      };
      this.on('update', onUpdate);
      onUpdate();
    });
  }

  pause() {
    this.paused = true;
    for (const token of this.active.values()) token.abort('pause');
    this._emitUpdate(true);
  }

  resume() {
    this.paused = false;
    for (const it of this.items) {
      if (it.status === 'paused') it.status = 'pending';
    }
    this._emitUpdate(true);
    this._kick();
  }

  retry(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || (it.status !== 'error' && it.status !== 'canceled')) return;
    it.status = 'pending';
    it.error = null;
    this._emitUpdate(true);
    this._kick();
  }

  cancel(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    if (it.status === 'active') {
      it.status = 'canceled';
      const token = this.active.get(id);
      if (token) token.abort('cancel');
    } else if (it.status === 'pending' || it.status === 'paused') {
      it.status = 'canceled';
    }
    this._emitUpdate(true);
  }

  cancelAll() {
    this.policy = null;
    for (const it of this.items) {
      if (['pending', 'paused', 'active'].includes(it.status)) it.status = 'canceled';
    }
    for (const token of this.active.values()) token.abort('cancel');
    this._emitUpdate(true);
  }

  clearFinished() {
    this.items = this.items.filter((it) => !['done', 'canceled', 'skipped'].includes(it.status));
    this._emitUpdate(true);
  }

  snapshot() {
    const open = this.items.filter((i) => ['pending', 'active', 'paused'].includes(i.status));
    const totalBytes = open.reduce((a, i) => a + (i.size || 0), 0);
    const doneBytes = open.reduce((a, i) => a + i.transferred, 0);
    const speed = this.items
      .filter((i) => i.status === 'active')
      .reduce((a, i) => a + (i.speed || 0), 0);
    return {
      items: this.items,
      paused: this.paused,
      running: this.workers > 0,
      active: this.active.size,
      concurrency: this.concurrency,
      speedLimit: this.limiter.rate,
      speed,
      pending: open.length,
      totalBytes,
      doneBytes,
    };
  }

  _emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 120) return;
    this._lastEmit = now;
    this.emit('update', this.snapshot());
  }

  _kick() {
    if (this.paused) return;
    // Pracovníků pouštíme tolik, kolik je práce — nejvýš do zvoleného počtu.
    while (this.workers < this.concurrency && this.items.some((i) => i.status === 'pending')) {
      this.workers += 1;
      this._worker().catch(() => {}).finally(() => {
        this.workers -= 1;
        // Politika „použít na všechny" platí jen do vyprázdnění fronty;
        // zahodit ji smíme teprve když dojedou všichni pracovníci.
        if (this.workers === 0 && !this.items.some((i) => i.status === 'pending')) {
          this.policy = null;
        }
        this._emitUpdate(true);
        // Pokud mezitím přibyla práce (typicky Pauza a hned Pokračovat),
        // _kick() tehdy odešel s plným počtem pracovníků. Bez tohohle
        // dokopnutí by fronta zůstala stát napořád.
        if (!this.paused && this.items.some((i) => i.status === 'pending')) this._kick();
      });
    }
  }

  async _worker() {
    for (;;) {
      if (this.paused) return;
      const item = this.items.find((i) => i.status === 'pending');
      if (!item) return;

      item.status = 'active';
      item.startedAt = Date.now();
      item.limiter = item.speedLimit ? new RateLimiter(item.speedLimit) : null;

      const token = new AbortToken();
      this.active.set(item.id, token);
      this._emitUpdate(true);

      let adapter = null;
      try {
        adapter = await this.acquireAdapter();
        const outcome = await this._transfer(item, adapter, token);
        if (item.status === 'active') {
          if (outcome === 'skipped') {
            item.status = 'skipped';
          } else {
            item.status = 'done';
            item.transferred = item.size ?? item.transferred;
            // Zdroj mažeme až teď a jen při úspěchu. Kdyby se mazalo dřív
            // nebo bez ohledu na výsledek, jedna chyba by soubor ztratila.
            if (item.moveFrom && this.onMoveSource) {
              try {
                await this.onMoveSource(item);
                item.note = 'přesunuto';
              } catch (delErr) {
                item.note = `zdroj se nepodařilo smazat: ${delErr.message}`;
              }
            }
          }
        }
      } catch (err) {
        if (err && err.aborted) {
          // Rozlišíme pauzu (položka se vrátí do fronty) od zrušení.
          item.status = token.reason === 'pause' ? 'paused' : 'canceled';
        } else {
          item.status = 'error';
          item.error = err ? err.message : 'Neznámá chyba';
        }
      } finally {
        this.active.delete(item.id);
        item.limiter = null;
        if (adapter) this.releaseAdapter(adapter);
        this._emitUpdate(true);
      }
    }
  }

  async _transfer(item, adapter, token) {
    const limiters = [this.limiter, item.limiter];
    const onProgress = (bytes) => {
      item.transferred = bytes;
      const elapsed = (Date.now() - item.startedAt) / 1000;
      if (elapsed > 0.3) item.speed = Math.round(bytes / elapsed);
      this._emitUpdate();
    };

    if (item.direction === 'up') {
      await fsp.access(item.localPath, fs.constants.R_OK);
      const local = await fsp.stat(item.localPath);
      item.size = local.size;

      const decision = await this._checkConflict(adapter, item, {
        size: local.size, mtime: local.mtimeMs,
      });
      if (decision === 'skipped') return 'skipped';

      const startAt = await this._resumeOffsetForUpload(adapter, item, local.size);
      item.transferred = startAt;

      const parent = posixDirname(item.remotePath);
      if (parent && parent !== '.') await adapter.mkdir(parent, true).catch(() => {});

      if (startAt >= local.size && local.size > 0) return 'done'; // už je celý nahraný
      await adapter.upload(item.localPath, item.remotePath, { startAt, onProgress, signal: token, limiters });

      // Přeneseme i čas změny, jinak by synchronizace soubor příště zase
      // označila za rozdílný. Server to nemusí umět — pak jen mlčky přeskočíme.
      await adapter.utimes(item.remotePath, local.atimeMs, local.mtimeMs).catch(() => {});
    } else {
      const remote = await adapter.stat(item.remotePath);
      item.size = remote.size;

      const decision = await this._checkConflict(adapter, item, {
        size: remote.size, mtime: remote.mtime,
      });
      if (decision === 'skipped') return 'skipped';

      await fsp.mkdir(path.dirname(item.localPath), { recursive: true });
      const startAt = await this._resumeOffsetForDownload(item, remote.size);
      item.transferred = startAt;

      if (startAt >= remote.size && remote.size > 0) return 'done';
      await adapter.download(item.remotePath, item.localPath, { startAt, onProgress, signal: token, limiters });

      if (remote.mtime) {
        const t = new Date(remote.mtime);
        await fsp.utimes(item.localPath, t, t).catch(() => {});
      }
    }
    return 'done';
  }

  /**
   * Zjistí, jestli cíl už existuje, a případně se zeptá uživatele.
   * Podle odpovědi může upravit cílovou cestu (přejmenování) nebo nastavit
   * offset pro navázání.
   *
   * @returns {Promise<'proceed'|'skipped'>}
   */
  async _checkConflict(adapter, item, source) {
    if (item.conflictResolved || item.transferred > 0) return 'proceed';
    if (!this.onConflict && !this.policy) return 'proceed';
    if (this.policy === 'overwrite') return 'proceed'; // ušetříme dotaz na server

    const target = await this._statTarget(adapter, item);
    if (!target) return 'proceed'; // cíl neexistuje, není co řešit

    let choice = this.policy;
    if (!choice) {
      const answer = await this._askConflict({
        direction: item.direction,
        localPath: item.localPath,
        remotePath: item.remotePath,
        source,
        target,
        canResume: target.size > 0 && target.size < source.size,
      });
      choice = (answer && answer.action) || 'skip';
      if (answer && answer.applyToAll) this.policy = choice;
    }

    switch (choice) {
      case 'overwrite':
        return 'proceed';

      case 'resume':
        // Navázání řeší _resumeOffsetFor*, kterým stačí transferred > 0.
        item.transferred = target.size;
        return 'proceed';

      case 'newer': {
        const tolerance = adapter.protocol === 'ftp' ? 61000 : 2000;
        const newer = (source.mtime ?? 0) - (target.mtime ?? 0) > tolerance;
        if (!newer) item.note = 'cíl není starší';
        return newer ? 'proceed' : 'skipped';
      }

      case 'rename': {
        const renamed = await this._freeTargetPath(adapter, item);
        if (item.direction === 'up') item.remotePath = renamed;
        else item.localPath = renamed;
        item.note = 'přejmenováno';
        return 'proceed';
      }

      case 'cancel':
        this.cancelAll();
        return 'skipped';

      default:
        item.note = 'přeskočeno';
        return 'skipped';
    }
  }

  /**
   * Dotazy na konflikt jdou jeden po druhém. Se souběžnými přenosy by jinak
   * vyskočily dva dialogy naráz — a druhý by se ptal na něco, o čem uživatel
   * mezitím rozhodl volbou „použít na všechny".
   */
  _askConflict(info) {
    const next = this._conflictChain.then(() => {
      if (this.policy) return { action: this.policy };
      return this.onConflict(info);
    });
    this._conflictChain = next.catch(() => {});
    return next;
  }

  /** Vlastnosti cílového souboru, nebo null když neexistuje. */
  async _statTarget(adapter, item) {
    try {
      if (item.direction === 'up') {
        const st = await adapter.stat(item.remotePath);
        // FTP na adresáři SIZE neumí a vrátí chybu — sem se tedy dostane
        // jen skutečný soubor.
        return { size: st.size, mtime: st.mtime };
      }
      const st = await fsp.stat(item.localPath);
      return { size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /** Najde volnou cílovou cestu ve tvaru „název (2).přípona". */
  async _freeTargetPath(adapter, item) {
    const full = item.direction === 'up' ? item.remotePath : item.localPath;
    const sep = item.direction === 'up' ? '/' : path.sep;
    const dir = item.direction === 'up' ? posixDirname(full) : path.dirname(full);
    const name = full.slice(full.lastIndexOf(sep) + 1);

    let taken = new Set();
    try {
      taken = item.direction === 'up'
        ? new Set((await adapter.list(dir)).map((e) => e.name))
        : new Set(await fsp.readdir(dir));
    } catch { /* složka nejde přečíst — zkusíme první návrh */ }

    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${stem} (${i})${ext}`;
      if (!taken.has(candidate)) return `${dir}${dir.endsWith(sep) ? '' : sep}${candidate}`;
    }
    throw new Error('Nepodařilo se najít volný název');
  }

  /** Kolik bajtů už na serveru leží a dá se na ně navázat. */
  async _resumeOffsetForUpload(adapter, item, localSize) {
    if (item.transferred <= 0) return 0; // nová položka — přepisujeme od začátku
    try {
      const remote = await adapter.stat(item.remotePath);
      return remote.size > 0 && remote.size <= localSize ? remote.size : 0;
    } catch {
      return 0;
    }
  }

  async _resumeOffsetForDownload(item, remoteSize) {
    if (item.transferred <= 0) return 0;
    try {
      const local = await fsp.stat(item.localPath);
      return local.size > 0 && local.size <= remoteSize ? local.size : 0;
    } catch {
      return 0;
    }
  }
}

function posixDirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

module.exports = { TransferQueue, AbortToken, posixDirname };
