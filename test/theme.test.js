'use strict';

/**
 * Motiv aplikace.
 *
 * Světlý a tmavý vzhled drží pohromadě jediná věc: že se barvy píšou výhradně
 * v paletě. Jedna barva zapsaná natvrdo někde v pravidlech se v tom druhém
 * motivu projeví jako nečitelné místo — a všimne si toho až uživatel. Proto to
 * hlídá test, ne dobrá vůle.
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
const truthy = (label, v, note = '') => {
  const ok = Boolean(v);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${note ? `  (${note})` : ''}`);
};

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

// Paleta = od začátku souboru po první pravidlo.
const konecPalety = css.indexOf('* { box-sizing: border-box; }');
const paleta = css.slice(0, konecPalety);
const pravidla = css.slice(konecPalety);

// ============================================ barvy jsou jen v paletě
const barvyVPravidlech = pravidla.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || [];
check('mimo paletu není žádná barva', barvyVPravidlech, []);

// Ikony jsou masky — barva uvnitř SVG je nepodstatná, ale barva, kterou se
// obarvují, musí i tady pocházet z palety.
const ikony = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icons.css'), 'utf8');
const barvyVIkonach = (ikony.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || []);
check('ani ve stylu ikon', barvyVIkonach, []);
truthy('ikony se barví proměnnou', /background: var\(--icon-color/.test(ikony));

const tokeny = [...paleta.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
truthy('paleta má tokeny', tokeny.length > 20, `${tokeny.length}`);

// ============================================ každý token má obě polohy
// Výjimky: --on-accent je bílá v obou motivech, --row-h a --cols nejsou barvy.
const bezMotivu = ['--on-accent', '--row-h', '--cols'];
const jenJednaBarva = tokeny.filter((t) => {
  if (bezMotivu.includes(t)) return false;
  const radek = paleta.match(new RegExp(`${t}:([^;]+);`));
  return radek && !radek[1].includes('light-dark(');
});
check('každá barva má světlou i tmavou podobu', jenJednaBarva, []);

// ============================================ přepínání motivu
truthy('základ nechává rozhodnout systém', /:root\s*{[^}]*color-scheme:\s*light dark/.test(paleta));
truthy('vlastní volba systém přebije — světlá',
  /:root\[data-theme="light"\]\s*{\s*color-scheme:\s*light/.test(paleta));
truthy('vlastní volba systém přebije — tmavá',
  /:root\[data-theme="dark"\]\s*{\s*color-scheme:\s*dark/.test(paleta));

// ============================================ propojení s nastavením
truthy('nastavení nabízí všechny tři možnosti',
  ['system', 'light', 'dark'].every((v) => html.includes(`<option value="${v}"`)));
truthy('okno motiv zapisuje na <html>', /root\.dataset\.theme = theme/.test(app));
truthy('a „podle systému" ho zase odebírá', /delete root\.dataset\.theme/.test(app));
truthy('systémové dialogy se řídí stejnou volbou', /nativeTheme\.themeSource/.test(main));
truthy('pozadí okna taky', /setBackgroundColor\(windowBackground\(\)\)/.test(main));

// ============================================ čitelnost na barevném podkladu
truthy('text na plném výběru zesvětlá',
  /\.list:focus-within \.row\.sel[^{]*{\s*color: var\(--on-accent\)/.test(pravidla.replace(/,\s*\n/g, ', ')));
truthy('hlavní tlačítko má vlastní barvu textu',
  /button\.primary\s*{[^}]*color: var\(--on-accent\)/.test(pravidla));

console.log(`\n${pass} prošlo, ${fail} selhalo`);
process.exit(fail ? 1 : 0);
