'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Záznam komunikace se serverem do souboru.
 *
 * Když se server chová divně — zavírá spojení, hlásí nesmysly, tváří se, že
 * soubor neexistuje — je tohle jediné, co pomůže. Ve stavovém řádku je vidět
 * závěr, tady je vidět rozhovor.
 *
 * Zapisuje se řádek po řádku a rovnou, ne přes vyrovnávací paměť: log má
 * cenu hlavně u pádů, a to je přesně situace, kdy se nedopsané řádky ztratí.
 *
 * **Hesla se do logu nedostanou.** Příkaz `PASS` se zkracuje a u SSH se
 * zaznamenávají jen zprávy knihovny, ne obsah spojení.
 */

/** Co je potřeba schovat, než se řádek zapíše. */
const TAJNOSTI = [
  // FTP: „PASS tajne" → „PASS ***"
  [/^(\s*(?:>|<)?\s*PASS)\s+.*$/im, '$1 ***'],
  // Někdy se heslo objeví jako součást URL.
  [/(:\/\/[^:@\s]+):[^@\s]+@/g, '$1:***@'],
];

function zamaskuj(text) {
  let out = String(text);
  for (const [vzor, nahrada] of TAJNOSTI) out = out.replace(vzor, nahrada);
  return out;
}

class SessionLog {
  /**
   * @param {string} dir kam soubory ukládat
   * @param {object} [opts]
   * @param {number} [opts.maxBytes] nad tuhle velikost se soubor odloží stranou
   */
  constructor(dir, { maxBytes = 5 * 1024 * 1024 } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.enabled = false;
    this.file = null;
    this.stream = null;
    // Kolik je v souboru bajtů. Počítáme si to sami, protože soubor zůstává
    // otevřený celý den — kdybychom se ptali jen při otevírání, k odložení
    // přerostlého logu by nikdy nedošlo.
    this.written = 0;
  }

  setEnabled(on) {
    if (Boolean(on) === this.enabled) return;
    this.enabled = Boolean(on);
    if (!this.enabled) this.close();
  }

  /** Cesta k dnešnímu souboru; jeden den = jeden soubor. */
  _todayFile() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return path.join(this.dir, `charon-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
  }

  _open() {
    const cil = this._todayFile();
    if (this.stream && this.file === cil) return this.stream;

    this.close();
    fs.mkdirSync(this.dir, { recursive: true });

    this.written = 0;
    try {
      this.written = fs.statSync(cil).size;
    } catch { /* soubor ještě není */ }

    this.file = cil;
    this.stream = fs.createWriteStream(cil, { flags: 'a' });
    this.stream.on('error', () => { this.stream = null; });
    return this.stream;
  }

  /**
   * Zapíše řádek.
   *
   * @param {string} kdo která relace — ať se dá poznat, kdo mluví
   * @param {string} text
   */
  write(kdo, text) {
    if (!this.enabled) return;
    let stream = this._open();
    if (!stream) return;

    // Přerostlý log odložíme stranou; jinak by po týdnu ladění zabral disk.
    if (this.written > this.maxBytes) {
      const stary = this.file;
      this.close();
      try { fs.renameSync(stary, `${stary}.1`); } catch { /* nevadí */ }
      stream = this._open();
      if (!stream) return;
    }

    const cas = new Date().toISOString().slice(11, 23);
    for (const radek of zamaskuj(text).split(/\r?\n/)) {
      if (!radek.trim()) continue;
      const out = `${cas} [${kdo}] ${radek}\n`;
      this.written += Buffer.byteLength(out);
      stream.write(out);
    }
  }

  close() {
    if (this.stream) {
      try { this.stream.end(); } catch { /* už zavřený */ }
      this.stream = null;
    }
    this.file = null;
  }
}

module.exports = { SessionLog, zamaskuj };
