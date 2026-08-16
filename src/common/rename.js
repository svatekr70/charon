/**
 * Hromadné přejmenování podle vzoru.
 *
 * Modul jen spočítá, co se na co přejmenuje — samotné přejmenování dělá až
 * volající. Díky tomu jde výsledek ukázat v náhledu dřív, než se čehokoliv
 * dotkneme, a jde ho testovat bez serveru.
 *
 * Hlídají se tři věci, které jinak končí ztrátou souboru:
 *   • dva soubory nesmí skončit pod stejným názvem,
 *   • nový název nesmí obsahovat lomítko (to už je jiná složka),
 *   • pokud název už ve složce existuje, řekne se to dopředu.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BulkRename = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  /** Rozdělí název na jméno a příponu. Soubor začínající tečkou příponu nemá. */
  function split(name) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return { base: name, ext: '' };
    return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Číslo do počítadla `{n}`, doplněné nulami na požadovanou šířku. */
  function counter(index, { start = 1, step = 1, pad = 1 } = {}) {
    const value = start + (index * step);
    return String(value).padStart(Math.max(1, pad), '0');
  }

  /**
   * @param {string[]} names názvy ve složce, které se mají přejmenovat
   * @param {object} opts
   * @param {string} opts.find co hledat; prázdné = jen dosadit počítadlo
   * @param {string} opts.replace čím nahradit; smí obsahovat `{n}`
   * @param {boolean} [opts.regex] brát `find` jako regulární výraz
   * @param {boolean} [opts.caseSensitive] rozlišovat velikost písmen
   * @param {'name'|'ext'|'full'} [opts.target] na kterou část názvu to platí
   * @param {number} [opts.start] první číslo počítadla
   * @param {number} [opts.step] krok počítadla
   * @param {number} [opts.pad] na kolik míst doplnit nulami
   * @param {string[]} [opts.existing] názvy, které ve složce už jsou
   * @returns {Array<{from: string, to: string, changed: boolean, error: string|null}>}
   */
  function plan(names, opts = {}) {
    const {
      find = '',
      replace = '',
      regex = false,
      caseSensitive = false,
      target = 'full',
      existing = [],
    } = opts;

    let matcher = null;
    if (find) {
      try {
        matcher = new RegExp(regex ? find : escapeRegExp(find), caseSensitive ? 'g' : 'gi');
      } catch (err) {
        // Rozbitý regulární výraz nesmí shodit dialog; ohlásíme ho u každé
        // položky, ať je vidět, že se nic nepřejmenuje.
        return names.map((from) => ({ from, to: from, changed: false, error: `chybný výraz: ${err.message}` }));
      }
    }

    const out = names.map((from, i) => {
      const { base, ext } = split(from);
      const cislo = counter(i, opts);
      const nahrada = String(replace).replace(/\{n\}/g, cislo);

      // Bez hledaného textu se náhrada prostě připojí — tak se dá dávka
      // očíslovat nebo označit příponou, aniž by se něco hledalo.
      const uprav = (text) => (matcher ? text.replace(matcher, nahrada) : text + nahrada);

      let to;
      if (target === 'name') to = ext ? `${uprav(base)}.${ext}` : uprav(base);
      else if (target === 'ext') to = ext ? `${base}.${uprav(ext)}` : base;
      else to = uprav(from);

      let error = null;
      if (!to) error = 'prázdný název';
      else if (to.includes('/')) error = 'název nesmí obsahovat lomítko';

      return { from, to, changed: to !== from, error };
    });

    // Kolize mezi novými názvy. Porovnáváme bez ohledu na velikost písmen —
    // na macOS ani na většině serverů se dva takové názvy vedle sebe nevejdou.
    const pocty = new Map();
    for (const r of out) {
      const k = r.to.toLowerCase();
      pocty.set(k, (pocty.get(k) || 0) + 1);
    }
    const puvodni = new Set(names.map((n) => n.toLowerCase()));
    const uzTam = new Set(existing.map((n) => n.toLowerCase()));

    for (const r of out) {
      if (r.error) continue;
      const k = r.to.toLowerCase();
      if (pocty.get(k) > 1) r.error = 'dva soubory by měly stejný název';
      // Přepsat cizí soubor je horší než nepřejmenovat; na existující název
      // ve složce (který se sám nepřejmenovává) upozorníme.
      else if (r.changed && uzTam.has(k) && !puvodni.has(k)) r.error = 'takový soubor už ve složce je';
    }

    return out;
  }

  /** Co se z plánu dá opravdu provést. */
  function applicable(rows) {
    return rows.filter((r) => r.changed && !r.error);
  }

  /**
   * Pořadí přejmenování, které nic nepřepíše.
   *
   * Zákeřný případ je posun názvů: `1.txt → 2.txt` a zároveň `2.txt → 3.txt`.
   * Ve výsledku si nic nepřekáží, ale kdyby se to provedlo popořadě, první
   * přejmenování by přepsalo soubor, který se teprve má přejmenovat — a ten by
   * byl nenávratně pryč. Takové soubory proto nejdřív odklidíme pod dočasný
   * název a teprve pak je pojmenujeme, jak mají být.
   *
   * @returns {Array<{from: string, to: string, temp: boolean}>}
   */
  function steps(rows) {
    const work = applicable(rows);
    const zdroje = new Set(work.map((r) => r.from.toLowerCase()));

    const rovnou = [];
    const odklidit = [];
    for (const r of work) {
      // Cíl je obsazený souborem, který se sám teprve přejmenovává.
      const kolize = zdroje.has(r.to.toLowerCase()) && r.to.toLowerCase() !== r.from.toLowerCase();
      if (kolize) odklidit.push(r);
      else rovnou.push(r);
    }

    const out = [];
    const docasne = new Map();
    odklidit.forEach((r, i) => {
      const tmp = `${r.from}.charon-rename-${i}`;
      docasne.set(r, tmp);
      out.push({ from: r.from, to: tmp, temp: true });
    });
    for (const r of rovnou) out.push({ from: r.from, to: r.to, temp: false });
    for (const r of odklidit) out.push({ from: docasne.get(r), to: r.to, temp: false });
    return out;
  }

  return { plan, applicable, steps, split, counter };
}));
