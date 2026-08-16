'use strict';

const path = require('path');

const posix = path.posix;
const { TransferQueue } = require('./queue');
const { EditWatcher } = require('./editor-watch');
const { FolderWatcher } = require('./watcher');
const { AdapterPool } = require('./pool');
const { RemoteTrash } = require('./trash');
const { Finder } = require('./browse');

/**
 * Jedno připojení se vším, co k němu patří.
 *
 * Původně byl stav spojení jeden na celou aplikaci. Aby šlo mít otevřených
 * víc serverů naráz, drží si každá relace vlastní spojení pro procházení,
 * vlastní zásobu spojení pro přenosy, vlastní frontu, hlídání složky
 * i sledované soubory v editoru. Nic z toho se mezi relacemi nesdílí —
 * přenos v jedné záložce tak nemůže spadnout kvůli tomu, co se děje v jiné.
 */
class Session {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {object} opts.config rozšifrovaná konfigurace relace
   * @param {string|null} opts.siteId id uložené relace, když z ní pochází
   * @param {object} opts.deps závislosti od hlavního procesu
   * @param {Function} opts.deps.openAdapter připojí nový adaptér (s ověřením)
   * @param {Function} opts.deps.send pošle událost do okna
   * @param {Function} opts.deps.askConflict zeptá se na přepis souboru
   * @param {Function} opts.deps.log zapíše do stavového řádku
   * @param {Function} opts.deps.settings vrátí aktuální nastavení
   */
  constructor({ id, config, siteId, deps }) {
    this.id = id;
    this.config = config;
    this.siteId = siteId || null;
    this.deps = deps;

    this.status = 'disconnected';
    // Fronta se pamatuje podle uložené relace; bez ní podle serveru a cíle.
    this.persistKey = siteId || `${config.protocol}://${config.username}@${config.host}:${config.port}${config.remoteDir || ''}`;
    this.browse = null;
    this.home = '/';
    this.pool = null;
    this.finder = null;
    this.closing = false;
    this.reconnecting = false;
    // Dokud se nerozhodne, co s frontou z minula, nesmíme ji přepsat. Prázdná
    // fronta nové relace by ji jinak smazala dřív, než se stačíme zeptat.
    this.queueAdopted = false;

    const settings = deps.settings();

    this.queue = new TransferQueue({
      concurrency: settings.maxConcurrent || 1,
      acquireAdapter: () => this.transferPool().acquire(),
      releaseAdapter: (a) => this.transferPool().release(a),
      onConflict: (info) => deps.askConflict(this.id, info),
      onMoveSource: (item) => this.removeSource(item),
    });
    this.queue.setSpeedLimit((settings.speedLimitKb || 0) * 1024);
    this.queue.setTempName(settings.tempName !== false, (settings.tempNameMinKb || 0) * 1024);
    this.queue.on('update', (snap) => {
      this.emit('queue', snap);
      // Nedokončené přenosy si pamatujeme, aby přežily zavření aplikace.
      if (deps.rememberQueue && this.queueAdopted) {
        deps.rememberQueue(this.persistKey, snap.items, this.describe().name);
      }
    });

    this.editWatcher = new EditWatcher({
      queue: this.queue,
      connectionKey: () => `${config.protocol}://${config.username}@${config.host}:${config.port}`,
      getAdapter: async () => this.requireBrowse(),
      askOverwrite: (info) => deps.askEditOverwrite(this.id, info),
    });
    this.editWatcher.on('update', (list) => this.emit('edit', list));
    this.editWatcher.on('log', ({ level, text }) => deps.log(level, text));

    this.folderWatcher = new FolderWatcher({
      queue: this.queue,
      getAdapter: async () => this.requireBrowse(),
      removeRemote: (remotePath) => this.removeRemote(remotePath),
    });
    this.folderWatcher.on('update', (st) => this.emit('watch', st));
    this.folderWatcher.on('log', ({ level, text }) => deps.log(level, text));
  }

  /** Události nesou id relace, aby je okno přiřadilo správné záložce. */
  emit(channel, payload) {
    this.deps.send(channel, { sid: this.id, payload });
  }

  get connected() {
    return this.status === 'connected';
  }

  requireBrowse() {
    if (!this.browse || !this.connected) throw new Error('Nejste připojeni');
    return this.browse;
  }

  /** Popis pro záložku v okně. */
  describe() {
    return {
      id: this.id,
      siteId: this.siteId,
      status: this.status,
      name: this.config.name || this.config.host,
      host: this.config.host,
      username: this.config.username,
      protocol: this.config.protocol,
      useRecycleBin: Boolean(this.config.useRecycleBin),
    };
  }

  async connect(adapter, home) {
    this.browse = adapter;
    this.status = 'connected';
    this.home = home;
    adapter.onLost = (reason) => {
      if (this.browse !== adapter) return;
      this.status = 'disconnected';
      this.emit('conn', this.describe());
      // Zavíráme-li sami, není co obnovovat.
      if (this.closing) return;
      this.deps.log('warn', `${this.describe().name}: spojení skončilo — ${reason}`);
      this.reconnect().catch(() => {});
    };
  }

  /**
   * Obnovení spadlého spojení.
   *
   * Zkouší se několikrát s rostoucí prodlevou — výpadek linky nebo restart
   * serveru je otázka vteřin a bez tohohle by uživatel musel klikat sám.
   * Rozepsané přenosy se po obnovení rozeběhnou dál; navazovat na ně už
   * fronta umí.
   */
  async reconnect({ attempts = [1000, 3000, 8000] } = {}) {
    if (this.reconnecting || this.closing) return false;
    this.reconnecting = true;

    // Zásoba spojení pro přenosy je taky mrtvá; ať se otevře znovu.
    if (this.pool) { await this.pool.closeAll().catch(() => {}); this.pool = null; }

    try {
      for (let i = 0; i < attempts.length; i += 1) {
        if (this.closing) return false;
        await wait(attempts[i]);
        if (this.closing) return false;

        this.status = 'connecting';
        this.emit('conn', this.describe());
        this.deps.log('warn', `${this.describe().name}: pokus o obnovení ${i + 1}/${attempts.length}…`);

        try {
          const adapter = await this.deps.openAdapter(this.config);
          const home = await adapter.home().catch(() => this.home);
          await this.connect(adapter, home);
          this.deps.log('ok', `${this.describe().name}: spojení obnoveno`);
          this.emit('conn', this.describe());
          // Co zbylo pozastavené výpadkem, se rozeběhne dál.
          this.queue.resume();
          return true;
        } catch (err) {
          this.deps.log('warn', `${this.describe().name}: ${err.message}`);
        }
      }

      this.status = 'disconnected';
      this.emit('conn', this.describe());
      this.deps.log('error', `${this.describe().name}: spojení se nepodařilo obnovit`);
      return false;
    } finally {
      this.reconnecting = false;
    }
  }

  transferPool() {
    if (!this.pool || this.pool.closed) {
      this.pool = new AdapterPool({
        open: () => this.deps.openAdapter(this.config),
        max: this.deps.settings().maxConcurrent || 1,
        onShrink: (n) => {
          this.queue.setConcurrency(n);
          this.deps.log('warn', `Server nepovolil další spojení — souběžnost snížena na ${n}`);
        },
      });
    }
    return this.pool;
  }

  /** Koš na serveru, nebo null když je u relace vypnutý. */
  getTrash(adapter = this.browse) {
    if (!this.config.useRecycleBin || !adapter) return null;
    const base = this.config.recycleBinPath || RemoteTrash.defaultPath(this.home);
    return new RemoteTrash(adapter, base);
  }

  /** Smazání na serveru — do koše, když ho relace má. */
  async removeRemote(remotePath) {
    const trash = this.getTrash();
    if (trash) { await trash.moveToTrash(remotePath); return; }
    const a = this.requireBrowse();
    if (await isDir(a, remotePath)) await a.removeDir(remotePath, true);
    else await a.removeFile(remotePath);
  }

  /** Odstranění zdroje po přesunu; lokálně řeší hlavní proces přes koš systému. */
  async removeSource(item) {
    if (item.moveFrom === 'local') {
      await this.deps.trashLocal(item.localPath);
      return;
    }
    await this.removeRemote(item.remotePath);
  }

  newFinder() {
    this.finder = new Finder();
    return this.finder;
  }

  applySettings(settings) {
    this.queue.setConcurrency(settings.maxConcurrent || 1);
    this.queue.setSpeedLimit((settings.speedLimitKb || 0) * 1024);
    this.queue.setTempName(settings.tempName !== false, (settings.tempNameMinKb || 0) * 1024);
    if (this.pool && !this.pool.closed) this.pool.setMax(settings.maxConcurrent || 1);
  }

  async close() {
    this.closing = true;
    this.status = 'disconnected';
    this.queue.cancelAll();
    if (this.finder) this.finder.cancel();
    await this.folderWatcher.stop().catch(() => {});
    await this.editWatcher.stopAll().catch(() => {});
    if (this.pool) { await this.pool.closeAll().catch(() => {}); this.pool = null; }
    if (this.browse) {
      this.browse.onLost = null;
      await this.browse.disconnect().catch(() => {});
      this.browse = null;
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Zjistí, jestli vzdálená cesta ukazuje na složku. */
async function isDir(adapter, remotePath) {
  try {
    const st = await adapter.stat(remotePath);
    if (typeof st.isDirectory === 'boolean') return st.isDirectory;
  } catch { /* FTP na složce SIZE neumí */ }
  try {
    await adapter.list(remotePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Správce otevřených relací. Drží pořadí záložek a která je vpředu.
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.order = [];
    this.activeId = null;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Relace už není otevřená');
    return s;
  }

  has(id) {
    return this.sessions.has(id);
  }

  add(session) {
    this.sessions.set(session.id, session);
    this.order.push(session.id);
    this.activeId = session.id;
    return session;
  }

  async remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.close();
    this.sessions.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = this.order[this.order.length - 1] || null;
  }

  setActive(id) {
    if (this.sessions.has(id)) this.activeId = id;
    return this.activeId;
  }

  list() {
    return this.order.map((id) => ({
      ...this.sessions.get(id).describe(),
      active: id === this.activeId,
    }));
  }

  all() {
    return this.order.map((id) => this.sessions.get(id));
  }

  async closeAll() {
    await Promise.all(this.all().map((s) => s.close().catch(() => {})));
    this.sessions.clear();
    this.order = [];
    this.activeId = null;
  }
}

module.exports = { Session, SessionManager, isDir };
