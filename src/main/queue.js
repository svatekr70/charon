'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { RateLimiter } = require('./throttle');
const perms = require('./perms');

/**
 * Přípona rozepsaného souboru. Stejnou používá WinSCP, takže když se přenos
 * nedokončí, je i z jiného klienta na první pohled vidět, co se stalo.
 */
/** Okno, ze kterého se počítá celková rychlost a odhad času. */
const SPEED_WINDOW_MS = 8000;

const TEMP_SUFFIX = '.filepart';

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
    // Kolik bajtů fronta opravdu přenesla, a vzorky pro výpočet rychlosti.
    this.moved = 0;
    this.samples = [];
    // Práva nahraných souborů; výchozí je nechat je na serveru.
    this.perms = {};
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
    /**
     * Přenášet přes dočasný název a nahradit cíl až po dokončení. Na živém
     * webu jinak může návštěvník trefit poloviční soubor.
     */
    this.useTempName = true;
    /** Od jaké velikosti dočasný název používat; 0 = vždy. */
    this.tempNameMinBytes = 0;
  }

  /** Práva nahraných souborů (Nastavení → Přenosy). */
  setPermissions(settings) {
    this.perms = settings || {};
  }

  setTempName(enabled, minBytes = 0) {
    this.useTempName = Boolean(enabled);
    this.tempNameMinBytes = Math.max(0, Math.floor(minBytes) || 0);
  }

  /** Rozhodne, jestli se konkrétní přenos povede přes dočasný název. */
  _tempFor(size) {
    if (!this.useTempName) return null;
    if (this.tempNameMinBytes && (size || 0) < this.tempNameMinBytes) return null;
    return TEMP_SUFFIX;
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
      // Pozastaveno ručně? Takovou položku nerozeběhne ani společné
      // „Pokračovat".
      held: false,
      speedLimit: Math.max(0, Math.floor(j.speedLimit) || 0),
      limiter: null,
      // Cesta rozepsaného souboru, dokud přenos běží.
      tempPath: null,
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
      // Položku, kterou uživatel pozastavil ručně, nechává společné
      // „Pokračovat" na pokoji — jinak by se rozeběhla přesně ta jedna,
      // které se chtěl vyhnout.
      if (it.status === 'paused' && !it.held) it.status = 'pending';
    }
    this._emitUpdate(true);
    this._kick();
  }

  /**
   * Pozastaví jednu položku, aniž by stála celá fronta.
   *
   * Běžící přenos se přeruší; rozepsaný soubor zůstává, takže se na něj dá
   * navázat. Ostatní pracovníci jedou dál.
   */
  holdItem(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it || !['pending', 'active', 'paused'].includes(it.status)) return;
    it.held = true;
    if (it.status === 'active') {
      const token = this.active.get(id);
      if (token) token.abort('pause');
    } else {
      it.status = 'paused';
    }
    this._emitUpdate(true);
  }

  /** Vrátí ručně pozastavenou položku zpátky do hry. */
  releaseItem(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    it.held = false;
    if (it.status === 'paused' && !this.paused) it.status = 'pending';
    this._emitUpdate(true);
    this._kick();
  }

  /**
   * Přesune čekající položku ve frontě.
   *
   * Řadí se jen mezi čekajícími — běžící přenos přeskočit nejde a hotové
   * položky pořadí nezajímá. `to` je 'up', 'down' nebo 'top'.
   */
  moveItem(id, to) {
    const cekajici = this.items
      .map((it, i) => ({ it, i }))
      .filter((x) => x.it.status === 'pending');
    const kde = cekajici.findIndex((x) => x.it.id === id);
    if (kde === -1) return false;

    let cil;
    if (to === 'top') cil = 0;
    else if (to === 'up') cil = kde - 1;
    else if (to === 'down') cil = kde + 1;
    else return false;
    if (cil < 0 || cil >= cekajici.length || cil === kde) return false;

    // Prohazujeme pozice v poli, takže nečekající položky zůstanou, kde byly.
    if (to === 'top') {
      const [vyjmuta] = this.items.splice(cekajici[kde].i, 1);
      this.items.splice(cekajici[0].i, 0, vyjmuta);
    } else {
      const a = cekajici[kde].i;
      const b = cekajici[cil].i;
      [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    }
    this._emitUpdate(true);
    return true;
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

  /**
   * Zaznamená přenesené bajty pro výpočet celkové rychlosti.
   *
   * Rychlost jednotlivé položky je průměr od jejího začátku — na odhad času
   * se nehodí, protože po dokončení položky ze součtu zmizí a odhad poskočí.
   * Proto se měří průtok celé fronty v posuvném okně.
   */
  _sample(delta) {
    if (delta > 0) this.moved += delta;
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    // Vzorkujeme nejvýš pětkrát za vteřinu; častěji by to jen zabíralo paměť.
    if (last && now - last.t < 200) { last.t = now; last.moved = this.moved; return; }
    this.samples.push({ t: now, moved: this.moved });
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) this.samples.shift();
  }

  /** Průměrná rychlost za posledních pár vteřin, v bajtech za vteřinu. */
  _windowSpeed() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.5) return 0;
    // Když se poslední vzorek nehýbe, přenos stojí — okno by pak lhalo.
    if (Date.now() - last.t > 2000) return 0;
    return Math.round((last.moved - first.moved) / dt);
  }

  snapshot() {
    const open = this.items.filter((i) => ['pending', 'active', 'paused'].includes(i.status));
    const totalBytes = open.reduce((a, i) => a + (i.size || 0), 0);
    const doneBytes = open.reduce((a, i) => a + i.transferred, 0);
    const speed = this.items
      .filter((i) => i.status === 'active')
      .reduce((a, i) => a + (i.speed || 0), 0);
    // Položka bez známé velikosti se do součtu započítat nedá; radši to
    // přiznáme, než abychom ukazovali odhad, který nemůže vyjít.
    const unknown = open.filter((i) => !i.size).length;
    const speedAvg = this.paused ? 0 : this._windowSpeed();
    const remaining = Math.max(0, totalBytes - doneBytes);
    const eta = speedAvg > 0 && remaining > 0 && !unknown
      ? Math.round(remaining / speedAvg)
      : null;

    return {
      items: this.items,
      paused: this.paused,
      speedAvg,
      eta,
      unknownSizes: unknown,
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
          // Po pauze rozepsaný soubor necháme — je z čeho navázat. Po zrušení
          // by po sobě jen zbyl nepořádek, tak ho uklidíme.
          if (item.status === 'canceled') await this._dropPartial(item, adapter);
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
      // Do celkové rychlosti počítáme jen přírůstek. Po navázání začíná
      // `bytes` na velikosti rozepsaného souboru a ta se přenášet nemusela.
      this._sample(Math.max(0, bytes - (item.transferred || 0)));
      item.transferred = bytes;
      const elapsed = (Date.now() - item.startedAt) / 1000;
      if (elapsed > 0.3) item.speed = Math.round(bytes / elapsed);
      this._emitUpdate();
    };

    if (item.direction === 'up') {
      await fsp.access(item.localPath, fs.constants.R_OK);
      const local = await fsp.stat(item.localPath);
      item.size = local.size;

      const suffix = this._tempFor(local.size);
      const decision = await this._checkConflict(adapter, item, {
        size: local.size, mtime: local.mtimeMs,
      }, suffix ? item.remotePath + suffix : item.remotePath);
      if (decision === 'skipped') return 'skipped';

      // Cestu k zápisu skládáme až po dotazu: volba „přejmenovat" cíl mění,
      // a kdybychom ji spočítali dřív, zapsalo by se na původní jméno —
      // tedy přesně do souboru, který měl zůstat nedotčený.
      const writePath = suffix ? item.remotePath + suffix : item.remotePath;
      item.tempPath = suffix ? writePath : null;

      const startAt = await this._resumeOffset(item, local.size, () => adapter.stat(writePath));
      item.transferred = startAt;

      const parent = posixDirname(item.remotePath);
      if (parent && parent !== '.') await adapter.mkdir(parent, true).catch(() => {});

      if (startAt < local.size || local.size === 0) {
        await adapter.upload(item.localPath, writePath, { startAt, onProgress, signal: token, limiters });
      }

      // Čas změny nastavujeme ještě na rozepsaném souboru — přejmenování ho
      // zachová a ušetří se tím jedno kolo navíc. Bez něj by synchronizace
      // soubor příště zase označila za rozdílný; server to ale umět nemusí.
      await adapter.utimes(writePath, local.atimeMs, local.mtimeMs).catch(() => {});

      if (suffix) {
        try {
          await adapter.replace(writePath, item.remotePath);
        } catch (err) {
          throw new Error(`Soubor se přenesl, ale nešlo ho přejmenovat z ${posixBasename(writePath)}`
            + ` na ${posixBasename(item.remotePath)}: ${err.message}.`
            + ' Zkuste vypnout přenos přes dočasný název v nastavení.');
        }
        item.tempPath = null;
      }

      // Práva až na konečné cestě: kdybychom je nastavili na `.filepart`,
      // přejmenování by je sice zachovalo, ale při vypnutém dočasném názvu
      // by se to chovalo jinak. Takhle je to stejné v obou případech.
      const chyba = await perms.apply(adapter, item.remotePath, perms.fileMode(this.perms, local.mode));
      if (chyba) item.note = `práva se nenastavila — ${chyba}`;
    } else {
      const remote = await adapter.stat(item.remotePath);
      item.size = remote.size;

      const suffix = this._tempFor(remote.size);
      const decision = await this._checkConflict(adapter, item, {
        size: remote.size, mtime: remote.mtime,
      }, suffix ? item.localPath + suffix : item.localPath);
      if (decision === 'skipped') return 'skipped';

      // Až po dotazu — „přejmenovat" mění cíl, viz nahrávání výš.
      const writePath = suffix ? item.localPath + suffix : item.localPath;
      item.tempPath = suffix ? writePath : null;

      await fsp.mkdir(path.dirname(item.localPath), { recursive: true });
      const startAt = await this._resumeOffset(item, remote.size, () => fsp.stat(writePath));
      item.transferred = startAt;

      if (startAt < remote.size || remote.size === 0) {
        await adapter.download(item.remotePath, writePath, { startAt, onProgress, signal: token, limiters });
      }

      if (remote.mtime) {
        const t = new Date(remote.mtime);
        await fsp.utimes(writePath, t, t).catch(() => {});
      }

      // Lokálně přejmenování přes existující soubor funguje vždycky.
      if (suffix) {
        await fsp.rename(writePath, item.localPath);
        item.tempPath = null;
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
  async _checkConflict(adapter, item, source, writePath) {
    if (item.conflictResolved || item.transferred > 0) return 'proceed';
    if (!this.onConflict && !this.policy) return 'proceed';
    if (this.policy === 'overwrite') return 'proceed'; // ušetříme dotaz na server

    const finalPath = item.direction === 'up' ? item.remotePath : item.localPath;
    const target = await this._statPath(adapter, item.direction, finalPath);
    if (!target) return 'proceed'; // cíl neexistuje, není co řešit

    // Při přenosu přes dočasný název leží rozepsaná data jinde než v cíli,
    // takže navázat jde na ně, ne na hotový soubor pod cílovým jménem.
    const partial = writePath && writePath !== finalPath
      ? await this._statPath(adapter, item.direction, writePath)
      : target;

    let choice = this.policy;
    if (!choice) {
      const answer = await this._askConflict({
        direction: item.direction,
        localPath: item.localPath,
        remotePath: item.remotePath,
        source,
        target,
        canResume: Boolean(partial && partial.size > 0 && partial.size < source.size),
      });
      choice = (answer && answer.action) || 'skip';
      if (answer && answer.applyToAll) this.policy = choice;
    }

    switch (choice) {
      case 'overwrite':
        return 'proceed';

      case 'resume':
        // Navázání řeší _resumeOffset, kterému stačí transferred > 0.
        item.transferred = partial ? partial.size : 0;
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

  /** Smaže rozepsaný soubor; selhání úklidu nesmí přebít původní důvod konce. */
  async _dropPartial(item, adapter) {
    if (!item.tempPath) return;
    try {
      if (item.direction === 'up') await adapter?.removeFile(item.tempPath);
      else await fsp.unlink(item.tempPath);
    } catch { /* nevadí, zůstane po něm jen soubor navíc */ }
    item.tempPath = null;
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

  /** Vlastnosti souboru na dané cestě, nebo null když neexistuje. */
  async _statPath(adapter, direction, target) {
    try {
      if (direction === 'up') {
        // FTP na adresáři SIZE neumí a vrátí chybu — sem se tedy dostane
        // jen skutečný soubor.
        const st = await adapter.stat(target);
        return { size: st.size, mtime: st.mtime };
      }
      const st = await fsp.stat(target);
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

  /**
   * Kolik bajtů rozepsaného souboru se dá použít.
   *
   * Navazuje se jen tam, kde už něco přeneseno bylo (transferred > 0) —
   * u nové položky se píše od začátku. Cizí rozepsaný soubor z dřívějška
   * tedy nikdy nepoužijeme mlčky; mohl by pocházet z jiné verze zdroje.
   */
  async _resumeOffset(item, sourceSize, statTarget) {
    if (item.transferred <= 0) return 0;
    try {
      const st = await statTarget();
      return st.size > 0 && st.size <= sourceSize ? st.size : 0;
    } catch {
      return 0;
    }
  }
}

function posixBasename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function posixDirname(p) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

module.exports = { TransferQueue, AbortToken, posixDirname, TEMP_SUFFIX };
