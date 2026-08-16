'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');

/**
 * "Edit & auto-upload" — funkce, kvůli které lidem WinSCP na Macu nejvíc chybí.
 *
 * Soubor se stáhne do dočasného adresáře, otevře v editoru a hlídá se.
 * Jakmile ho editor uloží, automaticky se nahraje zpět na server.
 */
class EditWatcher extends EventEmitter {
  /**
   * @param {Function} [opts.getAdapter] spojení pro kontrolu, zda se soubor
   *   na serveru mezitím nezměnil
   * @param {Function} [opts.askOverwrite] zeptá se, když se změnil
   */
  constructor({
    queue, connectionKey, getAdapter, askOverwrite,
  }) {
    super();
    this.queue = queue;
    this.connectionKey = connectionKey;
    this.getAdapter = getAdapter || null;
    this.askOverwrite = askOverwrite || null;
    this.watched = new Map(); // remotePath -> {localPath, watcher, uploads, lastUpload, status}
    this.root = path.join(os.tmpdir(), 'charon-edit');
  }

  _localFor(remotePath) {
    // Hash cesty drží soubory oddělené, jméno zůstává čitelné kvůli editoru
    // (zvýrazňování syntaxe podle přípony).
    const hash = crypto.createHash('sha1').update(`${this.connectionKey()}::${remotePath}`).digest('hex').slice(0, 10);
    return path.join(this.root, hash, path.posix.basename(remotePath));
  }

  async open(remotePath, { editor } = {}) {
    const existing = this.watched.get(remotePath);
    if (existing) {
      await launchEditor(existing.localPath, editor);
      return { localPath: existing.localPath, reopened: true };
    }

    const localPath = this._localFor(remotePath);
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await this.queue.addAndWait({ direction: 'down', remotePath, localPath, conflictResolved: true });

    // Stav souboru na serveru v okamžiku stažení. Podle něj se pozná, jestli
    // do něj mezitím nesáhl někdo jiný.
    const known = await this._remoteState(remotePath);

    const entry = {
      remotePath,
      localPath,
      uploads: 0,
      lastUpload: null,
      status: 'watching',
      busy: false,
      known,
    };

    const watcher = chokidar.watch(localPath, {
      ignoreInitial: true,
      // Editory zapisují po částech nebo přes přejmenování — počkáme, až se
      // velikost ustálí, jinak bychom nahráli půlku souboru.
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });

    watcher.on('change', () => this._upload(entry));
    watcher.on('add', () => this._upload(entry)); // editor přepsal soubor přes rename
    watcher.on('error', (err) => this.emit('log', { level: 'error', text: `Sledování ${remotePath}: ${err.message}` }));

    entry.watcher = watcher;
    this.watched.set(remotePath, entry);
    this._emit();

    await launchEditor(localPath, editor);
    return { localPath, reopened: false };
  }

  async _upload(entry) {
    if (entry.busy) return;
    entry.busy = true;
    entry.status = 'uploading';
    this._emit();
    try {
      // Než přepíšeme, ověříme, že se soubor na serveru mezitím nezměnil.
      // Automatické nahrání jinak mlčky zahodí práci někoho jiného.
      const now = await this._remoteState(entry.remotePath);
      if (this._changed(entry.known, now)) {
        const answer = this.askOverwrite
          ? await this.askOverwrite({
            remotePath: entry.remotePath,
            known: entry.known,
            current: now,
          })
          : { action: 'skip' };

        if (!answer || answer.action !== 'overwrite') {
          entry.status = 'watching';
          this.emit('log', {
            level: 'warn',
            text: `${entry.remotePath} se na serveru mezitím změnil — nahrání přeskočeno`,
          });
          return;
        }
      }

      // conflictResolved: přepsat vzdálený soubor je přesně to, co uživatel
      // uložením chtěl — ptát se při každém Cmd+S by bylo k nepoužití.
      await this.queue.addAndWait({
        direction: 'up', remotePath: entry.remotePath, localPath: entry.localPath, conflictResolved: true,
      });
      entry.uploads += 1;
      entry.lastUpload = Date.now();
      entry.status = 'watching';
      // Po vlastním nahrání je nový stav ten náš, ne cizí zásah.
      entry.known = await this._remoteState(entry.remotePath);
      this.emit('log', { level: 'ok', text: `Uloženo na server: ${entry.remotePath}` });
    } catch (err) {
      entry.status = 'error';
      this.emit('log', { level: 'error', text: `Nahrání ${entry.remotePath} selhalo: ${err.message}` });
    } finally {
      entry.busy = false;
      this._emit();
    }
  }

  /** Velikost a čas souboru na serveru, nebo null když se nedá zjistit. */
  async _remoteState(remotePath) {
    if (!this.getAdapter) return null;
    try {
      const a = await this.getAdapter();
      const st = await a.stat(remotePath);
      return { size: st.size, mtime: st.mtime || null };
    } catch {
      return null;
    }
  }

  /**
   * Změnil se soubor na serveru?
   *
   * Když stav neznáme (server neumí čas, spadlo spojení), tváříme se, že
   * nezměnil — jinak by se u takového serveru nedalo uložit vůbec nic.
   * Tolerance je vteřina kvůli FTP, které čas hlásí na minuty.
   */
  // eslint-disable-next-line class-methods-use-this
  _changed(known, current) {
    if (!known || !current) return false;
    if (known.size !== current.size) return true;
    if (!known.mtime || !current.mtime) return false;
    return Math.abs(known.mtime - current.mtime) > 1000;
  }

  async stop(remotePath) {
    const entry = this.watched.get(remotePath);
    if (!entry) return;
    // Sledovač může chybět, když otevírání skončilo dřív, než se stihl založit.
    if (entry.watcher) await entry.watcher.close();
    this.watched.delete(remotePath);
    this._emit();
  }

  async stopAll() {
    await Promise.all([...this.watched.values()].map((e) => (e.watcher ? e.watcher.close() : null)));
    this.watched.clear();
    this._emit();
  }

  list() {
    return [...this.watched.values()].map(({ watcher, busy, ...rest }) => rest);
  }

  _emit() {
    this.emit('update', this.list());
  }
}

function launchEditor(localPath, editor) {
  return new Promise((resolve, reject) => {
    const args = editor ? ['-a', editor, localPath] : [localPath];
    execFile('open', args, (err) => (err ? reject(new Error(`Nepodařilo se otevřít editor: ${err.message}`)) : resolve()));
  });
}

module.exports = { EditWatcher };
