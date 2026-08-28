/**
 * Pořadí, ve kterém se fronta ukazuje.
 *
 * Fronta si drží položky v tom pořadí, v jakém se do ní přidaly — na tom
 * stojí, co se bude přenášet dřív. Dívat se na ni takhle ale nejde: u dávky
 * o tisíci souborech je právě přenášená položka někde uprostřed a člověk
 * ji musí hledat. Proto se pro zobrazení řadí podle stavu:
 *
 *   běžící → chybné → pozastavené → čekající → zrušené → hotové
 *
 * Uvnitř každé skupiny zůstává původní pořadí fronty, takže „posunout
 * nahoru" u čekající položky je i na obrazovce vidět tam, kde se čekalo.
 * Chyby jsou hned pod běžícími schválně: to je jediné, co po sobě žádá
 * zásah, a v dlouhé frontě by jinak zapadly.
 *
 * Řadí se jen pohled, ne fronta samotná. Kdyby se přerovnávalo pole
 * v hlavním procesu, změnilo by se i to, co přijde na řadu.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QueueView = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  /** Menší číslo je výš. Neznámý stav skončí mezi čekajícími. */
  const RANK = {
    active: 0,
    error: 1,
    paused: 2,
    pending: 3,
    canceled: 4,
    skipped: 4,
    done: 5,
  };

  function rank(item) {
    const r = RANK[item && item.status];
    return r === undefined ? RANK.pending : r;
  }

  /**
   * Setřídí položky pro zobrazení.
   *
   * @param {Array} items položky fronty
   * @param {number} [limit] kolik jich nejvýš vrátit; 0 = všechny.
   *   Ořezává se až po setřídění, takže při stovkách hotových položek
   *   zůstane vidět to, co se právě děje, a ne začátek dávky.
   */
  function order(items, limit = 0) {
    const list = (items || [])
      .map((it, i) => ({ it, i }))
      .sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i)
      .map((x) => x.it);
    return limit > 0 ? list.slice(0, limit) : list;
  }

  return { order, rank, RANK };
}));
