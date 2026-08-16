'use strict';

/**
 * Zásoba spojení pro souběžné přenosy.
 *
 * Každý běžící přenos potřebuje vlastní spojení — u FTP proto, že jedno řídicí
 * spojení neumí dva příkazy naráz, u SFTP kvůli propustnosti. Servery ale
 * počet spojení z jedné adresy často omezují, takže když další otevřít nejde,
 * zásoba se sama zmenší a pracuje se s tím, co je. Přenosy kvůli tomu
 * neselžou, jen poběží po menších dávkách.
 */
class AdapterPool {
  /**
   * @param {object} opts
   * @param {Function} opts.open vytvoří a připojí nový adaptér
   * @param {number} [opts.max] kolik spojení nejvýš
   * @param {Function} [opts.onShrink] zavolá se, když server další spojení nepustil
   */
  constructor({ open, max = 1, onShrink = () => {} }) {
    this.open = open;
    this.max = Math.max(1, max);
    this.onShrink = onShrink;
    this.all = [];
    this.free = [];
    this.waiters = [];
    this.closed = false;
  }

  setMax(n) {
    this.max = Math.max(1, Math.floor(n) || 1);
  }

  get size() {
    return this.all.length;
  }

  get busy() {
    return this.all.length - this.free.length;
  }

  /** Vrátí volné spojení, otevře nové, nebo počká, až se nějaké uvolní. */
  async acquire() {
    if (this.closed) throw new Error('Zásoba spojení je zavřená');

    for (;;) {
      const reused = this._takeFree();
      if (reused) return reused;

      if (this.all.length < this.max) {
        try {
          const adapter = await this.open();
          this.all.push(adapter);
          return adapter;
        } catch (err) {
          // První spojení musí projít — bez něj není co dělat.
          if (this.all.length === 0) throw err;
          // Další už ne: server jich nejspíš víc nedovolí. Zmenšíme se
          // a počkáme na to, co už máme.
          this.max = this.all.length;
          this.onShrink(this.max, err);
        }
      }

      await this._waitForFree();
    }
  }

  release(adapter) {
    if (!adapter) return;
    // Spadlé spojení do zásoby nevracíme, jen ho zapomeneme.
    if (this.closed || !adapter.connected) {
      this.all = this.all.filter((a) => a !== adapter);
      adapter.disconnect?.().catch(() => {});
    } else if (this.all.length > this.max) {
      // Zásoba se mezitím zmenšila — přebytek zavřeme.
      this.all = this.all.filter((a) => a !== adapter);
      adapter.disconnect?.().catch(() => {});
    } else {
      this.free.push(adapter);
    }
    this._wake();
  }

  async closeAll() {
    this.closed = true;
    const all = this.all;
    this.all = [];
    this.free = [];
    this._wake();
    await Promise.all(all.map((a) => (a.disconnect ? a.disconnect().catch(() => {}) : null)));
  }

  _takeFree() {
    while (this.free.length) {
      const a = this.free.pop();
      if (a.connected) return a;
      this.all = this.all.filter((x) => x !== a);
    }
    return null;
  }

  _waitForFree() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  _wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (this.closed) w.reject(new Error('Zásoba spojení je zavřená'));
      else w.resolve();
    }
  }
}

module.exports = { AdapterPool };
