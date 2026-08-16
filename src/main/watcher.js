'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const posix = path.posix;
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

const FileMask = require('../common/mask');
const { TEMP_SUFFIX } = require('./queue');

/**
 * Hlídání složky s automatickým nahráváním.
 *
 * WinSCP tomu říká „Keep remote directory up to date". Sleduje lokální strom
 * a každou změnu rovnou nahraje na server — pro každodenní nasazování je to
 * to, kvůli čemu člověk klienta vlastně otevírá.
 *
 * Mazání na serveru je schválně dobrovolné a ve výchozím stavu vypnuté.
 * Hlídání běží na pozadí a smazaný soubor je nevratná věc; tohle rozhodnutí
 * má padnout vědomě, ne omylem.
 */
class FolderWatcher extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.queue fronta přenosů
   * @param {Function} opts.getAdapter spojení pro operace se složkami a mazání
   * @param {Function} [opts.removeRemote] smazání na serveru (typicky do koše)
   */
  constructor({ queue, getAdapter, removeRemote }) {
    super();
    this.queue = queue;
    this.getAdapter = getAdapter;
    this.removeRemote = removeRemote || null;

    this.watcher = null;
    this.localDir = '';
    this.remoteDir = '';
    this.mask = null;
    this.maskText = '';
    this.deleteRemote = false;
    this.startedAt = null;
    this.stats = { uploaded: 0, deleted: 0, errors: 0 };
    this.lastEvent = null;
    /** Zpožděné akce podle cesty — editory ukládají po dávkách. */
    this.timers = new Map();
    this.inFlight = new Set();
  }

  get running() {
    return Boolean(this.watcher);
  }

  status() {
    return {
      running: this.running,
      localDir: this.localDir,
      remoteDir: this.remoteDir,
      mask: this.maskText,
      deleteRemote: this.deleteRemote,
      startedAt: this.startedAt,
      pending: this.timers.size + this.inFlight.size,
      ...this.stats,
    };
  }

  /** Vzdálený protějšek lokální cesty. */
  _remoteFor(localPath) {
    const rel = path.relative(this.localDir, localPath).split(path.sep).join('/');
    return rel ? posix.join(this.remoteDir, rel) : this.remoteDir;
  }

  /**
   * Rozhodne, co chokidar vůbec nemá hlásit. Rozepsané soubory ignorujeme
   * vždycky — vznikají při stahování do téhle složky a nahrát je zpátky
   * na server by byl kolotoč.
   */
  _ignored(target, stats) {
    if (target === this.localDir) return false;
    if (target.endsWith(TEMP_SUFFIX)) return true;
    if (!this.mask) return false;

    const name = path.basename(target);
    // Bez stats nevíme, jestli jde o složku; složky pouštíme, ať se strom
    // vůbec projde, a soubor se stejně posoudí ještě jednou při události.
    if (stats && stats.isDirectory()) return !this.mask.allowDir(name);
    if (!stats) return false;
    return !this.mask.matchFile(name);
  }

  async start({
    localDir, remoteDir, mask = '', deleteRemote = false, initialSync = false,
  }) {
    if (this.running) throw new Error('Hlídání už běží');

    const st = await fsp.stat(localDir).catch(() => null);
    if (!st || !st.isDirectory()) throw new Error(`Složka ${localDir} neexistuje`);

    this.localDir = path.resolve(localDir);
    this.remoteDir = remoteDir.replace(/\/+$/, '') || '/';
    this.maskText = mask;
    const compiled = mask && mask.trim() ? FileMask.compile(mask) : null;
    this.mask = compiled && !compiled.empty ? compiled : null;
    this.deleteRemote = Boolean(deleteRemote);
    this.stats = { uploaded: 0, deleted: 0, errors: 0 };
    this.startedAt = Date.now();

    if (initialSync) await this._initialSync();

    this.watcher = chokidar.watch(this.localDir, {
      ignoreInitial: true, // úvodní srovnání řeší _initialSync, ne záplava událostí
      ignored: (t, s) => this._ignored(t, s),
      // Editory zapisují po částech nebo přes přejmenování — počkáme, až se
      // velikost ustálí, jinak bychom nahráli půlku souboru.
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });

    this.watcher.on('add', (p) => this._schedule(p, 'upload'));
    this.watcher.on('change', (p) => this._schedule(p, 'upload'));
    this.watcher.on('addDir', (p) => this._schedule(p, 'mkdir'));
    this.watcher.on('unlink', (p) => this._schedule(p, 'delete'));
    this.watcher.on('unlinkDir', (p) => this._schedule(p, 'rmdir'));
    this.watcher.on('error', (err) => this._fail('sledování', err));

    this._emit(`Hlídám ${this.localDir} → ${this.remoteDir}`);
    return this.status();
  }

  /** Srovná stav před začátkem hlídání, ať se nenahrává jen to, co se změní potom. */
  async _initialSync() {
    // Načítá se až tady, aby modul nešel do kruhu přes main.
    const { compare } = require('./sync');
    const adapter = await this.getAdapter();
    const res = await compare(adapter, this.localDir, this.remoteDir, {
      direction: 'toRemote',
      criteria: 'timeSize',
      mask: this.maskText,
    });

    for (const a of res.actions.filter((x) => x.action === 'mkdirRemote')) {
      await adapter.mkdir(a.remotePath, true).catch(() => {});
    }
    const uploads = res.actions.filter((a) => a.action === 'upload');
    if (uploads.length) {
      this.queue.add(uploads.map((a) => ({
        direction: 'up', localPath: a.localPath, remotePath: a.remotePath, size: a.size,
        conflictResolved: true,
      })));
      this.stats.uploaded += uploads.length;
    }
    this._emit(`Úvodní srovnání: ${uploads.length} k nahrání`);
  }

  /** Sloučí rychlé série událostí na jedné cestě do jedné akce. */
  _schedule(localPath, action) {
    const key = `${action}:${localPath}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this._run(localPath, action).catch((err) => this._fail(localPath, err));
    }, 250));
  }

  async _run(localPath, action) {
    if (!this.running) return;
    const remotePath = this._remoteFor(localPath);
    this.inFlight.add(localPath);

    try {
      if (action === 'upload') {
        const st = await fsp.stat(localPath).catch(() => null);
        if (!st || !st.isFile()) return;
        // conflictResolved: o přepisu rozhodl uživatel tím, že hlídání zapnul.
        // Ptát se u každé změny by z automatiky udělalo obtěžování.
        this.queue.add([{
          direction: 'up', localPath, remotePath, size: st.size, conflictResolved: true,
        }]);
        this.stats.uploaded += 1;
        this._emit(`↑ ${path.basename(localPath)}`);
        return;
      }

      if (action === 'mkdir') {
        const adapter = await this.getAdapter();
        await adapter.mkdir(remotePath, true).catch(() => {});
        this._emit(`+ ${path.basename(localPath)}/`);
        return;
      }

      if (!this.deleteRemote) return; // mazání je vypnuté, jen to necháme být

      if (action === 'delete') {
        if (this.removeRemote) await this.removeRemote(remotePath);
        else await (await this.getAdapter()).removeFile(remotePath);
        this.stats.deleted += 1;
        this._emit(`× ${path.basename(localPath)}`);
        return;
      }

      if (action === 'rmdir') {
        if (this.removeRemote) await this.removeRemote(remotePath);
        else await (await this.getAdapter()).removeDir(remotePath, true);
        this.stats.deleted += 1;
        this._emit(`× ${path.basename(localPath)}/`);
      }
    } finally {
      this.inFlight.delete(localPath);
    }
  }

  _fail(what, err) {
    this.stats.errors += 1;
    const text = `Hlídání složky — ${path.basename(String(what))}: ${err.message}`;
    this.emit('log', { level: 'error', text });
    this._emit(text);
  }

  _emit(text) {
    this.lastEvent = { text, at: Date.now() };
    this.emit('update', this.status());
  }

  async stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this._emit('Hlídání zastaveno');
    return this.status();
  }
}

module.exports = { FolderWatcher };
