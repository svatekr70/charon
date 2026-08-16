'use strict';

const { Transform } = require('stream');

/**
 * Omezení rychlosti přenosu.
 *
 * Použitý model je „děravý kbelík": tokeny (bajty) přitékají zadanou rychlostí
 * a přenos si je odebírá. Zásoba je omezená na jednu sekundu dopředu, takže po
 * chvíli nečinnosti nevyletí přenos na několikanásobek limitu.
 *
 * Jeden omezovač může být sdílený víc souběžnými přenosy — pak platí limit
 * dohromady, ne na každý zvlášť. To je celý smysl: uživatel zadává, kolik smí
 * ubrat z linky, ne kolik smí jeden soubor.
 */
class RateLimiter {
  /**
   * @param {number} bytesPerSecond 0 znamená bez omezení
   * @param {Function} [now] zdroj času; testy si ho podstrčí
   */
  constructor(bytesPerSecond = 0, now = () => Date.now()) {
    this.now = now;
    this.rate = Math.max(0, Math.floor(bytesPerSecond) || 0);
    this.tokens = this.rate;
    this.last = now();
    // Odběry řadíme za sebe, jinak by se čekající praly o tytéž tokeny.
    this.chain = Promise.resolve();
  }

  get unlimited() {
    return this.rate <= 0;
  }

  setRate(bytesPerSecond) {
    this._refill();
    this.rate = Math.max(0, Math.floor(bytesPerSecond) || 0);
    if (this.tokens > this.rate) this.tokens = this.rate;
  }

  _refill() {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    if (this.rate > 0) this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
  }

  /** Počká, až bude možné odeslat `bytes` bajtů. */
  take(bytes) {
    if (this.unlimited || bytes <= 0) return Promise.resolve();
    const next = this.chain.then(() => this._consume(bytes));
    // Chyba jednoho odběru nesmí zablokovat frontu dalších.
    this.chain = next.catch(() => {});
    return next;
  }

  async _consume(bytes) {
    let remaining = bytes;
    while (remaining > 0) {
      this._refill();
      if (this.unlimited) return; // limit se mezitím vypnul

      if (this.tokens >= 1) {
        // Odebíráme i po částech. Kdybychom čekali na celou dávku, u dávky
        // větší než sekundový limit by se nedočkala nikdy — zásoba je stropem.
        const use = Math.min(this.tokens, remaining);
        this.tokens -= use;
        remaining -= use;
        if (remaining <= 0) return;
      }

      const waitMs = Math.ceil((remaining / this.rate) * 1000);
      // Po kouscích, aby šlo limit měnit i uprostřed dlouhého čekání.
      await sleep(Math.max(5, Math.min(200, waitMs)));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Průchozí stream, který data propustí jen tak rychle, jak dovolí omezovače.
 * Bere jich víc — typicky globální limit a limit jedné položky fronty; projít
 * musí obojím.
 */
class ThrottleStream extends Transform {
  constructor(limiters = []) {
    super();
    this.limiters = limiters.filter((l) => l && !l.unlimited);
  }

  _transform(chunk, _enc, cb) {
    if (!this.limiters.length) { cb(null, chunk); return; }
    this._pace(chunk).then(() => cb(null, chunk), cb);
  }

  async _pace(chunk) {
    // Dávky ze SFTP mají ~32 kB. Při nízkém limitu by to znamenalo vteřinové
    // skoky, tak si je krájíme na menší kousky a přenos je plynulý.
    const slice = Math.max(4096, Math.floor(this.slowestRate() / 20) || 4096);
    for (let off = 0; off < chunk.length; off += slice) {
      const size = Math.min(slice, chunk.length - off);
      await Promise.all(this.limiters.map((l) => l.take(size)));
    }
  }

  slowestRate() {
    return this.limiters.reduce((min, l) => Math.min(min, l.rate), Infinity);
  }
}

/** Vrátí throttle, nebo null když není co omezovat. */
function makeThrottle(limiters) {
  const active = (limiters || []).filter((l) => l && !l.unlimited);
  return active.length ? new ThrottleStream(active) : null;
}

module.exports = { RateLimiter, ThrottleStream, makeThrottle };
