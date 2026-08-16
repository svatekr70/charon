'use strict';

/**
 * Vyrovnávací paměť výpisů složek.
 *
 * Proklikávání sem a tam znamená načítat tutéž složku pořád dokola; na pomalé
 * lince je to nejvíc znát právě u návratu o úroveň výš. Uložený výpis to
 * odbaví okamžitě.
 *
 * Zastaralý výpis je ale horší než pomalý — člověk podle něj maže a přepisuje.
 * Proto:
 *   • záznam platí jen krátce (výchozí půl minuty),
 *   • jakýkoliv zápis přes tuto relaci vyhodí celou paměť, ne jen dotčenou
 *     složku: přejmenování, mazání i nahrání se dotýkají i míst, o kterých
 *     dopředu nevíme (koš, nadřazená složka, cíl přesunu),
 *   • ruční obnovení (⌘R) se paměti neptá vůbec.
 *
 * Vyhazovat radši víc, než je nutné, je tady levné — nejhorší, co se stane,
 * je jedno načtení navíc.
 */
class ListCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] jak dlouho záznam platí
   * @param {number} [opts.max] kolik složek si nejvýš pamatovat
   */
  constructor({ ttlMs = 30000, max = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.enabled = true;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    if (!this.enabled) this.clear();
  }

  /** Uložený výpis, nebo `null` když není nebo už neplatí. */
  get(path) {
    if (!this.enabled) return null;
    const hit = this.entries.get(path);
    if (!hit) { this.misses += 1; return null; }
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(path);
      this.misses += 1;
      return null;
    }
    // Čerstvě použité patří na konec, ať se zahazuje to nejstarší.
    this.entries.delete(path);
    this.entries.set(path, hit);
    this.hits += 1;
    return hit.entries;
  }

  set(path, entries) {
    if (!this.enabled) return;
    this.entries.delete(path);
    this.entries.set(path, { at: Date.now(), entries });
    while (this.entries.size > this.max) {
      const nejstarsi = this.entries.keys().next().value;
      this.entries.delete(nejstarsi);
    }
  }

  /** Zapomene všechno. Volá se po každém zápisu na server. */
  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { ListCache };
