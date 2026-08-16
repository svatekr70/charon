/**
 * Porovnávání verzí.
 *
 * Textové porovnání tu nestačí: `1.10.0` je novější než `1.9.0`, ale abecedně
 * je to naopak. Předvydané verze (`1.2.0-beta.1`) jsou podle zvyklostí starší
 * než hotová `1.2.0` — kdo si nainstaluje beta verzi, nemá dostat hlášku, že
 * je k dispozici „novější" finální o kus zpátky.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Version = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  /** Rozloží `v1.2.3-beta.1` na čísla a předvydanou část. */
  function parse(text) {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(String(text || '').trim());
    if (!m) return null;
    return {
      cisla: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)],
      pre: m[4] || '',
    };
  }

  /**
   * @returns {number} záporné když `a` je starší, kladné když novější, 0 při shodě.
   *   Nesrozumitelnou verzi bereme jako nejstarší možnou.
   */
  function compare(a, b) {
    const x = parse(a);
    const y = parse(b);
    if (!x && !y) return 0;
    if (!x) return -1;
    if (!y) return 1;

    for (let i = 0; i < 3; i += 1) {
      if (x.cisla[i] !== y.cisla[i]) return x.cisla[i] - y.cisla[i];
    }
    // Bez předvydané části je verze hotová, a ta je novější než beta téhož čísla.
    if (x.pre === y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return comparePre(x.pre, y.pre);
  }

  /**
   * Porovná předvydané části podle pravidel semver.
   *
   * Dělí se tečkami a části, které jsou čísla, se porovnávají jako čísla —
   * jinak by `beta.10` vyšla starší než `beta.2`, protože textově je „1"
   * míň než „2".
   */
  function comparePre(a, b) {
    const ca = a.split('.');
    const cb = b.split('.');

    for (let i = 0; i < Math.max(ca.length, cb.length); i += 1) {
      // Kratší řada je starší: `beta` je před `beta.1`.
      if (ca[i] === undefined) return -1;
      if (cb[i] === undefined) return 1;
      if (ca[i] === cb[i]) continue;

      const na = /^\d+$/.test(ca[i]);
      const nb = /^\d+$/.test(cb[i]);
      if (na && nb) return Number(ca[i]) - Number(cb[i]);
      // Číslo je vždycky před textem (`1` < `alpha`).
      if (na !== nb) return na ? -1 : 1;
      return ca[i] < cb[i] ? -1 : 1;
    }
    return 0;
  }

  /** Je `latest` novější než `current`? */
  function isNewer(current, latest) {
    return compare(latest, current) > 0;
  }

  return { parse, compare, isNewer };
}));
