'use strict';

/**
 * Stavba dialogů.
 *
 * Tlačítko `<button value="cancel">` uvnitř `<form method="dialog">` zavře
 * dialog samo od sebe — ale jen když v tom formuláři **opravdu je**. Když se
 * formulář kvůli přebytečné značce zavře dřív, tlačítko zůstane mimo něj,
 * vypadá úplně stejně a nedělá vůbec nic. Přesně to se stalo při rozdělení
 * nastavení na karty a poznal to až uživatel.
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

/** Rozdělí soubor na jednotlivé dialogy i s jejich id. */
function dialogy() {
  const out = [];
  const re = /<dialog id="([^"]+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index;
    const konec = html.indexOf('</dialog>', start);
    out.push({ id: m[1], telo: html.slice(start, konec) });
  }
  return out;
}

function main() {
  const vsechny = dialogy();
  check('dialogy se našly', vsechny.length > 10, true);

  // ============ tlačítka musí být uvnitř formuláře
  const mimoFormular = vsechny.filter((d) => {
    if (!d.telo.includes('<form method="dialog"')) return false;
    const menu = d.telo.lastIndexOf('<menu');
    const konecFormulare = d.telo.lastIndexOf('</form>');
    return menu === -1 ? false : menu > konecFormulare;
  }).map((d) => d.id);
  check('lišta tlačítek je uvnitř formuláře', mimoFormular, []);

  // ============ značky se párují
  const nesedi = [];
  for (const d of vsechny) {
    for (const tag of ['form', 'section', 'div', 'label', 'menu', 'nav', 'select']) {
      const o = (d.telo.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
      const c = (d.telo.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      if (o !== c) nesedi.push(`${d.id}: ${tag} ${o}/${c}`);
    }
  }
  check('značky se v dialozích párují', nesedi, []);

  // ============ každý dialog jde zavřít
  // Dialogy, které vracejí rozhodnutí (přepis souboru, cizí změna v editoru),
  // zavírá skript podle `data-action` — kterékoliv z jejich tlačítek dialog
  // zavře a zároveň řekne, co uživatel zvolil. Zrušit tam někdy schválně není:
  // u cizí změny je bezpečná volba „nenahrávat", ne zavřít bez rozhodnutí.
  const bezZavreni = vsechny
    .filter((d) => !/value="cancel"|data-action="|id="[^"]*-(close|cancel)"/.test(d.telo))
    .map((d) => d.id);
  check('každý dialog má čím se zavřít', bezZavreni, []);

  // ============ karty nastavení
  const nastaveni = vsechny.find((d) => d.id === 'dlg-settings');
  const karty = [...nastaveni.telo.matchAll(/class="set-tab[^"]*" data-tab="([^"]+)"/g)].map((m) => m[1]);
  const panely = [...nastaveni.telo.matchAll(/class="set-panel" data-tab="([^"]+)"/g)].map((m) => m[1]);
  check('ke každé kartě je oddíl', karty, panely);
  check('a jeden oddíl je vidět od začátku',
    (nastaveni.telo.match(/class="set-panel" data-tab="[^"]+"(?! hidden)/g) || []).length, 1);

  // Pole ve skrytých oddílech musí zůstat ve formuláři, jinak by se
  // neuložila — a bylo by to poznat až podle toho, že se nastavení ztrácí.
  const poli = (nastaveni.telo.match(/<(input|select)\s/g) || []).length;
  check('všechna pole nastavení jsou pohromadě', poli > 25, true);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main();
