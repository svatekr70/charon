'use strict';

/**
 * Hromadné přejmenování.
 *
 * Přejmenování je nevratné a hromadné dvojnásob — proto se počítá dopředu
 * a ukazuje v náhledu. Testuje se hlavně to, co plán musí **zakázat**: dva
 * soubory pod stejným názvem znamenají, že jeden zmizí.
 */

const R = require('../src/common/rename');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/** Zkrácený zápis výsledku: "z → na" nebo "z ✗ důvod". */
const zapis = (rows) => rows.map((r) => (r.error ? `${r.from} ✗ ${r.error}` : `${r.from} → ${r.to}`));

function main() {
  // ================================================ prosté nahrazení
  check('nahrazení textu', zapis(R.plan(['foto-01.jpg', 'foto-02.jpg'], { find: 'foto', replace: 'obrazek' })),
    ['foto-01.jpg → obrazek-01.jpg', 'foto-02.jpg → obrazek-02.jpg']);
  check('nerozlišuje velikost písmen', zapis(R.plan(['Foto.jpg'], { find: 'foto', replace: 'x' })), ['Foto.jpg → x.jpg']);
  check('s rozlišováním se netrefí', R.plan(['Foto.jpg'], { find: 'foto', replace: 'x', caseSensitive: true })[0].changed, false);
  check('nahrazuje všechny výskyty', zapis(R.plan(['a-a-a.txt'], { find: 'a', replace: 'b' })), ['a-a-a.txt → b-b-b.txt']);

  // ================================================ části názvu
  check('jen jméno, přípona zůstává',
    zapis(R.plan(['zaloha.txt'], { find: 'txt', replace: 'md', target: 'name' })), ['zaloha.txt → zaloha.txt']);
  check('jen přípona',
    zapis(R.plan(['zaloha.txt'], { find: 'txt', replace: 'md', target: 'ext' })), ['zaloha.txt → zaloha.md']);
  check('celý název',
    zapis(R.plan(['txt.txt'], { find: 'txt', replace: 'md', target: 'full' })), ['txt.txt → md.md']);
  check('soubor bez přípony', R.split('README'), { base: 'README', ext: '' });
  check('soubor začínající tečkou příponu nemá', R.split('.htaccess'), { base: '.htaccess', ext: '' });

  // ================================================ počítadlo
  check('počítadlo od jedné',
    zapis(R.plan(['a.jpg', 'b.jpg', 'c.jpg'], { find: '', replace: '-{n}', target: 'name' })),
    ['a.jpg → a-1.jpg', 'b.jpg → b-2.jpg', 'c.jpg → c-3.jpg']);
  check('počítadlo s nulami a krokem',
    zapis(R.plan(['a.jpg', 'b.jpg'], {
      find: '', replace: '_{n}', target: 'name', start: 10, step: 5, pad: 3,
    })),
    ['a.jpg → a_010.jpg', 'b.jpg → b_015.jpg']);
  check('počítadlo uvnitř náhrady',
    zapis(R.plan(['x.txt', 'y.txt'], { find: '', replace: '', target: 'name' })), ['x.txt → x.txt', 'y.txt → y.txt']);

  // ================================================ regulární výraz
  check('regulární výraz se skupinou',
    zapis(R.plan(['IMG_1234.jpg'], { find: '^IMG_(\\d+)$', replace: 'foto-$1', regex: true, target: 'name' })),
    ['IMG_1234.jpg → foto-1234.jpg']);
  check('bez zapnutého regexu je tečka jen tečka',
    zapis(R.plan(['abc.txt'], { find: 'a.c', replace: 'x', target: 'name' })), ['abc.txt → abc.txt']);
  const rozbity = R.plan(['a.txt'], { find: '[', replace: 'x', regex: true });
  check('rozbitý výraz se ohlásí a nic se nepřejmenuje',
    [rozbity[0].changed, /chybný výraz/.test(rozbity[0].error)], [false, true]);

  // ================================================ co se nesmí stát
  check('dva soubory se stejným výsledkem',
    zapis(R.plan(['a.txt', 'b.txt'], { find: '', replace: '', target: 'name' })).length, 2);
  const kolize = R.plan(['a.txt', 'b.txt'], { find: '[ab]', replace: 'x', regex: true, target: 'name' });
  check('kolizi plán zachytí', zapis(kolize),
    ['a.txt ✗ dva soubory by měly stejný název', 'b.txt ✗ dva soubory by měly stejný název']);
  check('a nedá se provést', R.applicable(kolize), []);

  const obsazeno = R.plan(['a.txt'], { find: 'a', replace: 'b', target: 'name', existing: ['a.txt', 'b.txt'] });
  check('existující soubor ve složce se ohlásí', zapis(obsazeno), ['a.txt ✗ takový soubor už ve složce je']);

  // Posun názvů: 1→2 a zároveň 2→3. Výsledek si neodporuje, ale provést se to
  // musí opatrně, jinak první krok přepíše soubor, který se teprve má přejmenovat.
  const posun = R.plan(['1.txt', '2.txt'], { find: '', replace: '', target: 'name' });
  posun[0].to = '2.txt'; posun[0].changed = true;
  posun[1].to = '3.txt'; posun[1].changed = true;
  const kroky = R.steps(posun);
  check('kolidující soubor se nejdřív odklidí stranou',
    kroky.map((k) => `${k.from}→${k.to}${k.temp ? ' (dočasně)' : ''}`),
    ['1.txt→1.txt.charon-rename-0 (dočasně)', '2.txt→3.txt', '1.txt.charon-rename-0→2.txt']);
  check('a v žádném kroku se nepřepisuje obsazený název',
    kroky.some((k, i) => kroky.slice(i + 1).some((j) => j.from === k.to && !k.temp)), false);

  const bezKolize = R.plan(['a.txt', 'b.txt'], { find: 'a', replace: 'c', target: 'name' });
  check('bez kolize se nic neodklízí', R.steps(bezKolize).map((k) => `${k.from}→${k.to}`), ['a.txt→c.txt']);

  check('lomítko v názvu se nepustí',
    zapis(R.plan(['a.txt'], { find: 'a', replace: 'x/y', target: 'name' })), ['a.txt ✗ název nesmí obsahovat lomítko']);
  check('prázdný název taky ne',
    zapis(R.plan(['a'], { find: 'a', replace: '', target: 'full' })), ['a ✗ prázdný název']);

  // ================================================ co se má provést
  const smes = R.plan(['a.txt', 'b.txt', 'c.txt'], { find: 'a', replace: 'z', target: 'name' });
  check('provede se jen to, co se mění a je v pořádku',
    R.applicable(smes).map((r) => `${r.from}→${r.to}`), ['a.txt→z.txt']);
  check('beze změny se nic neprovádí', R.applicable(R.plan(['a.txt'], { find: 'q', replace: 'w' })), []);
  check('prázdný seznam nespadne', R.plan([], { find: 'a', replace: 'b' }), []);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main();
