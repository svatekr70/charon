/**
 * Masky souborů ve stylu WinSCP.
 *
 * Používá se na výběr podle masky, na filtr v panelu a na hledání souborů;
 * později poslouží i pro výběr souborů k přenosu a k synchronizaci, proto
 * modul žije mimo hlavní proces i mimo okno a načítají si ho oba.
 *
 * Podporováno:
 *   *            libovolný počet znaků
 *   ?            právě jeden znak
 *   [abc] [a-z]  jeden znak z výčtu nebo rozsahu
 *   [*]          zápis hvězdičky jako obyčejného znaku
 *   a; b, c      víc masek najednou (středník i čárka)
 *   vzor | vzor  za svislítkem je výluka, ta má přednost
 *   slozka/      maska platí jen pro adresáře
 *
 * Porovnává se bez ohledu na velikost písmen, stejně jako ve WinSCP.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FileMask = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  /** Převede jednu masku na regulární výraz. */
  function toRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i];

      if (ch === '[') {
        const end = pattern.indexOf(']', i + 1);
        if (end === -1) { out += '\\['; continue; }
        const body = pattern.slice(i + 1, end);
        i = end;
        // [*] a [?] jsou zápisy pro znaky samotné, ne pro třídu
        if (body === '*' || body === '?' || body === '[') { out += `\\${body}`; continue; }
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        continue;
      }

      if (ch === '*') { out += '.*'; continue; }
      if (ch === '?') { out += '.'; continue; }
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`, 'i');
  }

  function splitPatterns(text) {
    return String(text)
      .split(/[;,]/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  /**
   * Zkompiluje zápis masky (včetně výluky za `|`) na objekt s metodou match.
   * Prázdný zápis odpovídá všemu.
   */
  function compile(text) {
    const raw = String(text || '').trim();
    const [includePart, excludePart] = raw.split('|');

    const build = (part) => splitPatterns(part || '').map((p) => {
      const dirOnly = p.endsWith('/');
      const bare = dirOnly ? p.slice(0, -1) : p;
      return { dirOnly, rx: toRegExp(bare || '*') };
    });

    const include = build(includePart);
    const exclude = build(excludePart);

    const hit = (rules, name, isDir) => rules.some(
      (r) => (!r.dirOnly || isDir) && r.rx.test(name),
    );

    return {
      empty: include.length === 0 && exclude.length === 0,

      /**
       * @param {string} name název souboru nebo složky
       * @param {boolean} isDir jde o adresář
       */
      match(name, isDir = false) {
        // Výluka přebíjí zahrnutí, stejně jako ve WinSCP.
        if (exclude.length && hit(exclude, name, isDir)) return false;
        if (!include.length) return true;
        return hit(include, name, isDir);
      },

      /** Rozhodnutí o souboru — plné pravidlo se zahrnutím i výlukou. */
      matchFile(name) {
        if (exclude.length && hit(exclude, name, false)) return false;
        if (!include.length) return true;
        return hit(include, name, false);
      },

      /**
       * Smí se do složky sestoupit?
       *
       * Na složky se schválně uplatní jen výluky. Kdyby platilo i zahrnutí,
       * maska `*.php` by zakázala vstup do každé podsložky a rekurzivní přenos
       * by nenašel vůbec nic. Vyloučit `.git/` naopak smysl dává a ušetří
       * spoustu zbytečné práce.
       */
      allowDir(name) {
        return !(exclude.length && hit(exclude, name, true));
      },
    };
  }

  /** Jednorázové porovnání; na opakované použití je lepší compile(). */
  function match(text, name, isDir = false) {
    return compile(text).match(name, isDir);
  }

  return { compile, match, toRegExp };
}));
