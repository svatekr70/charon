'use strict';

const { Transform } = require('stream');

/**
 * Převod konců řádků při přenosu — „textový režim" z WinSCP.
 *
 * Unix a Mac používají `LF`, Windows `CRLF`. Když se soubor přenáší mezi nimi
 * v binárním režimu, konce řádků zůstanou takové, jaké byly — a `.sh` skript
 * s `CRLF` se na serveru neprovede, `.bat` s `LF` zase na Windows.
 *
 * Převádí se proudem, ne načtením celého souboru: klidně to může být
 * stomegový log. Kvůli tomu je jediná zajímavá věc na celém modulu hranice
 * mezi kusy dat — když jeden skončí `CR` a další začne `LF`, patří k sobě
 * a nesmí se to rozpojit.
 */

const CR = 0x0d;
const LF = 0x0a;

/**
 * `LF` → `CRLF`. Osamocené `LF` dostane `CR`; existující `CRLF` se nezdvojuje.
 */
function toCrlf() {
  let visiCr = false; // předchozí kus skončil na CR

  const prevod = (chunk) => {
    const out = Buffer.allocUnsafe(chunk.length * 2);
    let n = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (b === LF && !(i === 0 ? visiCr : chunk[i - 1] === CR)) out[n++] = CR;
      out[n++] = b;
    }
    visiCr = chunk.length > 0 && chunk[chunk.length - 1] === CR;
    return out.subarray(0, n);
  };

  return new Transform({
    transform(chunk, _enc, cb) { cb(null, prevod(chunk)); },
  });
}

/**
 * `CRLF` → `LF`. Osamocené `CR` (starý Mac) se nechává být — mazat ho by
 * u binárního souboru, který se do masky připletl, znamenalo poškodit data.
 */
function toLf() {
  let cekajiciCr = false; // kus skončil na CR a ještě nevíme, co přijde

  const prevod = (chunk) => {
    const out = Buffer.allocUnsafe(chunk.length + 1);
    let n = 0;

    let start = 0;
    if (cekajiciCr) {
      cekajiciCr = false;
      // CR z minulého kusu: když teď přijde LF, dvojice se sloučí, jinak
      // se CR musí dopsat zpátky.
      if (chunk.length && chunk[0] === LF) { out[n++] = LF; start = 1; } else out[n++] = CR;
    }

    for (let i = start; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (b === CR) {
        if (i === chunk.length - 1) { cekajiciCr = true; break; }
        if (chunk[i + 1] === LF) continue; // CR zahodíme, LF se zapíše dál
      }
      out[n++] = b;
    }
    return out.subarray(0, n);
  };

  return new Transform({
    transform(chunk, _enc, cb) { cb(null, prevod(chunk)); },
    flush(cb) {
      // Soubor končící osamoceným CR — nesmí se ztratit.
      cb(null, cekajiciCr ? Buffer.from([CR]) : undefined);
    },
  });
}

/**
 * Který převod použít.
 *
 * Při stahování se sjednocuje vždycky na `LF` — to je konvence macOS
 * a soubor stažený s `CRLF` mate editory i `git`. Při nahrávání rozhoduje
 * volba, jaké konce řádků má mít soubor na serveru.
 *
 * @param {'up'|'down'} direction
 * @param {'crlf'|'lf'} serverEol
 * @returns {Function} tovární funkce na Transform
 */
function transformFor(direction, serverEol) {
  if (direction === 'down') return toLf;
  return serverEol === 'crlf' ? toCrlf : toLf;
}

module.exports = { toCrlf, toLf, transformFor };
