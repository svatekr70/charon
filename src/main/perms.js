'use strict';

/**
 * Práva nahraných souborů a složek.
 *
 * Na sdíleném hostingu záleží na tom, s jakými právy soubor na serveru
 * skončí — nahraný soubor s právy 600 web prostě neukáže. Výchozí chování
 * necháváme na serveru, protože do cizí konfigurace se nemá sahat bez vyzvání;
 * kdo to potřebuje, zapne si pevná práva nebo zachování těch lokálních.
 *
 * Když se práva nastavit nepodaří (FTP server neumí SITE CHMOD), přenos kvůli
 * tomu neselže — soubor je nahraný a to je to podstatné. Jen se to řekne.
 */

/**
 * Práva se nastavují na třech místech a dědí se odshora dolů: nastavení
 * aplikace platí všude, relace ho pro svůj server přebije a jednorázový přenos
 * přebije obojí. Co nižší úroveň nevyplní, bere se z té vyšší — a to po
 * jednotlivých polích, takže relace může předepsat práva složek a práva
 * souborů nechat na nastavení aplikace.
 *
 * @param {...object} vrstvy od nejkonkrétnější po nejobecnější
 * @returns {{uploadPerms: string, uploadFileMode: string, uploadDirMode: string}}
 */
function resolve(...vrstvy) {
  // „inherit" je prázdná volba v dialozích — znamená „nech to na vyšší úrovni".
  const vyplneno = (h) => h !== undefined && h !== null && h !== 'inherit' && String(h).trim() !== '';
  const prvni = (klic) => {
    for (const v of vrstvy) {
      if (v && vyplneno(v[klic])) return String(v[klic]).trim();
    }
    return '';
  };
  return {
    uploadPerms: prvni('uploadPerms') || 'keep',
    uploadFileMode: prvni('uploadFileMode'),
    uploadDirMode: prvni('uploadDirMode'),
  };
}

/** Osmičkový zápis práv na číslo; `null` když pole zůstalo prázdné nebo je nesmysl. */
function parseMode(text) {
  const v = String(text === undefined || text === null ? '' : text).trim();
  if (!v) return null;
  if (!/^[0-7]{3,4}$/.test(v)) return null;
  return parseInt(v, 8);
}

/**
 * Práva pro složku odvozená od práv souboru — `chmod +X`.
 *
 * Spouštění u složky znamená „smí se do ní vstoupit". Kdyby dostala 644 jako
 * soubory v ní, nedostane se k nim nikdo, a to bývá výsledek hromadného
 * `chmod -R 644` na celý web. Přidává se tam, kde je čtení: 644 → 755,
 * 640 → 750, 664 → 775.
 *
 * @param {number|null} mode práva souboru
 * @returns {number|null}
 */
function addExec(mode) {
  if (mode === null || mode === undefined) return null;
  return mode | ((mode & 0o444) >> 2);
}

/**
 * Jaká práva dát nahranému souboru.
 *
 * @param {object} settings nastavení aplikace
 * @param {number|null} localMode práva zdrojového souboru
 * @returns {number|null} `null` znamená „nechat na serveru"
 */
function fileMode(settings, localMode) {
  const s = settings || {};
  if (s.uploadPerms === 'fixed') return parseMode(s.uploadFileMode);
  // Zachovat se dají jen práva, která opravdu známe.
  if (s.uploadPerms === 'preserve') {
    return Number.isInteger(localMode) ? localMode & 0o7777 : null;
  }
  return null;
}

/** Jaká práva dát složce založené při nahrávání. */
function dirMode(settings) {
  const s = settings || {};
  // U složky nemá „zachovat" co zachovávat — vzniká na serveru, ne přenosem.
  // Pevná práva ale dávají smysl v obou režimech.
  if (s.uploadPerms === 'fixed' || s.uploadPerms === 'preserve') return parseMode(s.uploadDirMode);
  return null;
}

/**
 * Nastaví práva, pokud si to uživatel přeje. Chybu spolkne a vrátí ji
 * volajícímu k vypsání — přenos na ní padat nemá.
 *
 * @returns {Promise<null|string>} `null` když se nic nedělo nebo to vyšlo,
 *   jinak text chyby.
 */
async function apply(adapter, remotePath, mode) {
  if (mode === null || mode === undefined) return null;
  try {
    await adapter.chmod(remotePath, mode);
    return null;
  } catch (err) {
    return err && err.message ? err.message : 'práva se nepodařilo nastavit';
  }
}

module.exports = {
  parseMode, resolve, addExec, fileMode, dirMode, apply,
};
