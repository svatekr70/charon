'use strict';

/**
 * Rozpoznání typu souboru.
 *
 * Ikona je drobnost, ale špatná ikona mate — `index.php` musí vypadat jako
 * zdrojový kód, ne jako neznámý balík bajtů. Testuje se hlavně to, co se
 * v panelech objevuje denně, a případy, kde přípona lže.
 */

const fs = require('fs');
const path = require('path');

const K = require('../src/common/filekind');

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

const kind = (name, type) => K.of(name, type).kind;

// ================================================ složky a odkazy
check('složka', K.of('www', 'd'), { kind: 'folder', mime: 'inode/directory', label: 'Složka', ext: '' });
check('odkaz', kind('current', 'l'), 'link');
check('u složky nerozhoduje přípona', kind('zaloha.zip', 'd'), 'folder');

// ================================================ web, tedy denní chleba
check('PHP je zdrojový kód', kind('index.php'), 'code');
check('a má správné MIME', K.of('index.php').mime, 'application/x-httpd-php');
check('HTML je značkování', kind('stranka.html'), 'markup');
check('šablona Latte taky', kind('layout.latte'), 'markup');
check('šablona Twig taky', kind('base.twig'), 'markup');
check('CSS jsou styly', kind('styl.css'), 'style');
check('SCSS taky', kind('_promenne.scss'), 'style');
check('JavaScript je kód', kind('app.js'), 'code');

// Sloupec Typ v panelech ukazuje přesně tuhle příponu, a řadí se podle ní.
const ext = (n, t) => K.of(n, t).ext;
check('přípona bez tečky a malými písmeny', ext('Index.PHP'), 'php');
check('bere se ta poslední', ext('web.tar.gz'), 'gz');
check('soubor začínající tečkou příponu nemá', ext('.htaccess'), '');
check('ani soubor končící tečkou', ext('divny.'), '');
check('ani soubor bez tečky', ext('Makefile'), '');
check('složka příponu nemá', ext('web.old', 'd'), '');
check('TypeScript taky', kind('main.ts'), 'code');

// ================================================ přípona lže
check('SVG je pro člověka obrázek, ne značkování', kind('logo.svg'), 'image');
check('.key je Keynote, ne klíč', kind('navrh.key'), 'slides');
check('klíč je .pem', kind('server.pem'), 'key');
check('CSV je tabulka, ne text', kind('vykaz.csv'), 'sheet');
check('shellový skript je spustitelný', kind('deploy.sh'), 'exe');
check('SQL patří k datům', kind('dump.sql'), 'data');

// ================================================ soubory bez přípony
check('.htaccess je nastavení', kind('.htaccess'), 'config');
check('.env taky', kind('.env'), 'config');
check('a jeho odvozeniny', [kind('.env.local'), kind('.env.example')], ['config', 'config']);
check('.htpasswd je spíš klíč', kind('.htpasswd'), 'key');
check('Dockerfile je nastavení', kind('Dockerfile'), 'config');
check('Makefile je kód', kind('makefile'), 'code');
check('README bez přípony je text', kind('README'), 'text');
check('README.md taky', kind('README.md'), 'text');
check('neznámé bez přípony je prostě soubor', kind('zaloha'), 'binary');

// ================================================ velikost písmen a víc teček
check('velká písmena nevadí', kind('FOTO.JPG'), 'image');
check('rozhoduje poslední přípona', kind('archiv.tar.gz'), 'archive');
check('název s tečkami', kind('jquery.min.js'), 'code');
check('soubor končící tečkou', kind('divny.'), 'binary');
check('prázdný název nespadne', kind(''), 'binary');
check('chybějící název taky ne', kind(undefined), 'binary');

// ================================================ zbytek škatulek
const ocekavane = {
  image: ['a.png', 'a.webp', 'a.avif', 'a.psd'],
  video: ['a.mp4', 'a.mov', 'a.mkv'],
  audio: ['a.mp3', 'a.flac', 'a.wav'],
  archive: ['a.zip', 'a.7z', 'a.tar', 'a.rar'],
  disk: ['a.dmg', 'a.iso'],
  font: ['a.woff2', 'a.ttf', 'a.otf', 'a.eot'],
  pdf: ['a.pdf'],
  doc: ['a.docx', 'a.odt', 'a.rtf', 'a.pages'],
  sheet: ['a.xlsx', 'a.ods', 'a.numbers'],
  slides: ['a.pptx', 'a.odp'],
  data: ['a.json', 'a.yaml', 'a.xml', 'a.sqlite'],
  text: ['a.txt', 'a.md', 'a.log'],
  exe: ['a.exe', 'a.app', 'a.bat'],
  key: ['a.crt', 'a.p12', 'a.pub', 'a.asc'],
};
for (const [want, names] of Object.entries(ocekavane)) {
  const spatne = names.filter((n) => kind(n) !== want);
  check(`škatulka ${want}`, spatne, []);
}

// ================================================ každá škatulka má popisek i ikonu
const icons = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'icons.css'), 'utf8');
const skatulky = Object.keys(K.LABELS);
const bezPopisku = skatulky.filter((k) => !K.LABELS[k]);
check('každá škatulka má popisek', bezPopisku, []);

// Bez pravidla ve stylu by položka dostala výchozí ikonu souboru a nikdo by
// si toho nevšiml — proto se to hlídá tady, ne okem.
const bezIkony = skatulky.filter((k) => k !== 'folder' && k !== 'link'
  && !icons.includes(`.row[data-kind="${k}"] .name::before`));
check('každá škatulka má ikonu', bezIkony, []);
truthy('složka a odkaz mají ikonu taky',
  icons.includes('[data-kind="folder"]') && icons.includes('[data-kind="link"]'));

const pouzite = [...icons.matchAll(/--icon: var\((--i-[a-z]+)\)/g)].map((m) => m[1]);
const definovane = [...icons.matchAll(/^\s*(--i-[a-z]+):/gm)].map((m) => m[1]);
check('všechny použité ikony jsou nakreslené', pouzite.filter((i) => !definovane.includes(i)), []);
check('a žádná nakreslená nezůstala ležet', definovane.filter((i) => !pouzite.includes(i)), []);

console.log(`\n${pass} prošlo, ${fail} selhalo`);
process.exit(fail ? 1 : 0);
