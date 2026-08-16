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
  constructor({ queue, connectionKey }) {
    super();
    this.queue = queue;
    this.connectionKey = connectionKey;
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

    const entry = {
      remotePath,
      localPath,
      uploads: 0,
      lastUpload: null,
      status: 'watching',
      busy: false,
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
      // conflictResolved: přepsat vzdálený soubor je přesně to, co uživatel
      // uložením chtěl — ptát se při každém Cmd+S by bylo k nepoužití.
      await this.queue.addAndWait({
        direction: 'up', remotePath: entry.remotePath, localPath: entry.localPath, conflictResolved: true,
      });
      entry.uploads += 1;
      entry.lastUpload = Date.now();
      entry.status = 'watching';
      this.emit('log', { level: 'ok', text: `Uloženo na server: ${entry.remotePath}` });
    } catch (err) {
      entry.status = 'error';
      this.emit('log', { level: 'error', text: `Nahrání ${entry.remotePath} selhalo: ${err.message}` });
    } finally {
      entry.busy = false;
      this._emit();
    }
  }

  async stop(remotePath) {
    const entry = this.watched.get(remotePath);
    if (!entry) return;
    await entry.watcher.close();
    this.watched.delete(remotePath);
    this._emit();
  }

  async stopAll() {
    await Promise.all([...this.watched.values()].map((e) => e.watcher.close()));
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
