'use strict';

/** Masky souborů — používá je výběr maskou, filtr v panelu i hledání. */

const FileMask = require('../src/common/mask');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const m = (mask, name, isDir = false) => FileMask.match(mask, name, isDir);

// ------------------------------------------------------------- zástupné znaky
check('hvězdička na příponu', m('*.php', 'index.php'), true);
check('hvězdička nesedí', m('*.php', 'index.html'), false);
check('hvězdička uprostřed', m('index.*', 'index.php'), true);
check('hvězdička bere i prázdno', m('a*b', 'ab'), true);
check('otazník je právě jeden znak', m('foto?.jpg', 'foto1.jpg'), true);
check('otazník nebere dva znaky', m('foto?.jpg', 'foto12.jpg'), false);
check('výčet znaků', m('index_[abc].html', 'index_b.html'), true);
check('výčet nesedí', m('index_[abc].html', 'index_d.html'), false);
check('rozsah znaků', m('[a-z]*.txt', 'soubor.txt'), true);
check('samotná hvězdička bere vše', m('*', 'cokoliv.zip'), true);

// Bez zástupných znaků se porovnává celý název, ne jen jeho část.
check('holý název je přesná shoda', m('readme', 'readme'), true);
check('holý název není podřetězec', m('readme', 'readme.md'), false);

// ------------------------------------------------------------ velikost písmen
check('nezáleží na velikosti písmen', m('*.PHP', 'index.php'), true);
check('a naopak taky', m('*.php', 'INDEX.PHP'), true);

// ------------------------------------------------------------------ tečka
check('tečkový soubor projde hvězdičkou', m('*', '.htaccess'), true);
check('maska na tečkové soubory', m('.env*', '.env.local'), true);

// -------------------------------------------------------------- víc masek
check('středník odděluje', m('*.jpg; *.png', 'obrazek.png'), true);
check('čárka taky', m('*.jpg, *.png', 'obrazek.jpg'), true);
check('žádná z masek nesedí', m('*.jpg; *.png', 'dokument.pdf'), false);
check('mezery kolem masek nevadí', m('  *.jpg ;  *.png  ', 'a.jpg'), true);

// ---------------------------------------------------------------- výluky
check('výluka odebere z výběru', m('*.js | *.min.js', 'app.min.js'), false);
check('co výluka nezachytí, projde', m('*.js | *.min.js', 'app.js'), true);
check('výluka přebíjí zahrnutí', m('* | secret.txt', 'secret.txt'), false);
check('samotná výluka bere zbytek', m('| *.tmp', 'data.csv'), true);
check('samotná výluka svoje odmítne', m('| *.tmp', 'data.tmp'), false);
check('víc výluk najednou', m('* | .git/; node_modules/', 'node_modules', true), false);

// ------------------------------------------------------------ masky složek
check('lomítko značí jen složky', m('build/', 'build', true), true);
check('stejné jméno souboru neprojde', m('build/', 'build', false), false);
check('složka projde i běžnou maskou', m('bu*', 'build', true), true);

// ------------------------------------------------------------- prázdný zápis
check('prázdná maska bere vše', m('', 'cokoliv'), true);
check('prázdná maska je označena', FileMask.compile('').empty, true);
check('neprázdná maska není', FileMask.compile('*.txt').empty, false);

// ----------------------------------------- zástupný znak jako obyčejný znak
check('[*] je hvězdička sama', m('soubor[*].txt', 'soubor*.txt'), true);
check('[*] nebere cokoliv', m('soubor[*].txt', 'souborABC.txt'), false);

// ----------------------------- znaky s významem v regulárních výrazech
check('tečka se nebere jako libovolný znak', m('a.txt', 'axtxt'), false);
check('závorky v názvu', m('soubor (2).txt', 'soubor (2).txt'), true);
check('plus v názvu', m('c++*', 'c++ zdroj.cpp'), true);
check('dolar v názvu', m('*$$$*', 'temp$$$.bak'), true);

// ------------------------------------------------------------ opakované užití
const compiled = FileMask.compile('*.log; *.bak | archiv.*');
check('zkompilovaná maska — log', compiled.match('server.log'), true);
check('zkompilovaná maska — bak', compiled.match('data.bak'), true);
check('zkompilovaná maska — výluka', compiled.match('archiv.log'), false);
check('zkompilovaná maska — jiné', compiled.match('index.php'), false);

console.log(`\n${pass} prošlo, ${fail} selhalo`);
process.exit(fail ? 1 : 0);
