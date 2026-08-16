'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Nedokončené přenosy, které mají přežít zavření aplikace.
 *
 * Ukládá se jen to, co se ještě nestalo — hotové a zrušené položky nemají
 * proč přežít. Rozepsané soubory `.filepart` na disku a na serveru zůstávají,
 * takže je po obnovení z čeho navázat.
 *
 * Klíčem je uložená relace. Podle serveru a uživatele by se pletly dvě relace
 * na stejný stroj s jiným cílovým adresářem.
 */
class QueueStore {
  /**
   * @param {string} userDataDir kam se soubor ukládá
   * @param {object} [opts]
   * @param {number} [opts.delayMs] jak dlouho se čeká na další změnu
   * @param {number} [opts.maxWaitMs] nejdéle, co se smí odkládat zápis
   */
  constructor(userDataDir, { delayMs = 500, maxWaitMs = 3000 } = {}) {
    this.file = path.join(userDataDir, 'queue.json');
    this.data = {};
    this.timer = null;
    this.delayMs = delayMs;
    this.maxWaitMs = maxWaitMs;
    this.lastWrite = 0;
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      this.data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    return this.data;
  }

  /** Položky čekající na obnovení pro danou relaci. */
  pending(key) {
    if (!key) return [];
    const entry = this.data[key];
    return entry && Array.isArray(entry.items) ? entry.items : [];
  }

  /**
   * Zapamatuje si stav fronty. Ukládá se se zpožděním — během přenosu chodí
   * hlášení několikrát za sekundu a zapisovat při každém by bylo zbytečné.
   */
  remember(key, items, { name = '' } = {}) {
    if (!key) return;
    const keep = items
      .filter((i) => ['pending', 'active', 'paused', 'error'].includes(i.status))
      .map((i) => ({
        direction: i.direction,
        localPath: i.localPath,
        remotePath: i.remotePath,
        size: i.size,
        // Běžící přenos si po restartu pamatujeme jako pozastavený; nic jiného
        // z něj nezbylo než rozepsaný soubor.
        transferred: i.transferred,
        speedLimit: i.speedLimit || 0,
        conflictResolved: Boolean(i.conflictResolved),
        moveFrom: i.moveFrom || null,
      }));

    if (keep.length) this.data[key] = { name, at: Date.now(), items: keep };
    else delete this.data[key];
    this._scheduleSave();
  }

  forget(key) {
    if (!key) return;
    delete this.data[key];
    this._scheduleSave();
  }

  /**
   * Zápis se odkládá, ale jen do určité míry.
   *
   * Během přenosu chodí hlášení několikrát za vteřinu. Samotné odkládání by se
   * tím pořád dokola posouvalo a k zápisu by nedošlo nikdy — tedy přesně
   * v situaci, kvůli které to celé je. Proto platí strop: jednou za `maxWaitMs`
   * se uloží tak jako tak.
   */
  _scheduleSave() {
    const since = Date.now() - this.lastWrite;
    if (since >= this.maxWaitMs) {
      this.save().catch(() => {});
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save().catch(() => {}),
      Math.min(this.delayMs, this.maxWaitMs - since));
  }

  async save() {
    clearTimeout(this.timer);
    this.lastWrite = Date.now();
    // Zápisy řadíme za sebe; dva naráz by si přepisovaly dočasný soubor.
    this.writing = this.writing.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fsp.rename(tmp, this.file);
    }, () => {});
    return this.writing;
  }
}

module.exports = { QueueStore };
