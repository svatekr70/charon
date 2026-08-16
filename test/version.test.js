'use strict';

/**
 * Porovnávání verzí pro kontrolu aktualizací.
 *
 * Textové porovnání tu nestačí a chyba se pozná pozdě: buď se nabízí
 * aktualizace na starší verzi, nebo se novější nikdy neohlásí. Obojí je horší
 * než kontrolu nemít.
 */

const V = require('../src/common/version');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

const smer = (a, b) => Math.sign(V.compare(a, b));

function main() {
  // ================================================ pořadí čísel
  check('vyšší záplata je novější', smer('1.0.1', '1.0.0'), 1);
  check('vyšší menší číslo taky', smer('1.1.0', '1.0.9'), 1);
  check('vyšší hlavní číslo taky', smer('2.0.0', '1.99.99'), 1);
  check('shoda je shoda', smer('1.2.3', '1.2.3'), 0);

  // Tohle je ten případ, kvůli kterému se to nedá porovnávat jako text.
  check('desítka je víc než devítka', smer('1.10.0', '1.9.0'), 1);
  check('a abecedně by to vyšlo obráceně', '1.10.0' > '1.9.0', false);

  // ================================================ zápis verze
  check('písmeno v se ignoruje', smer('v1.2.3', '1.2.3'), 0);
  check('chybějící části jsou nuly', smer('1.2', '1.2.0'), 0);
  check('samotné hlavní číslo taky', smer('2', '2.0.0'), 0);
  check('mezery nevadí', smer('  1.2.3  ', '1.2.3'), 0);

  // ================================================ předvydané verze
  check('beta je starší než hotová verze', smer('1.2.0-beta.1', '1.2.0'), -1);
  check('a hotová novější než beta', smer('1.2.0', '1.2.0-beta.1'), 1);
  // Číselné části se porovnávají jako čísla, ne jako text — jinak by beta.10
  // vyšla starší než beta.2.
  check('beta.10 je novější než beta.2', smer('1.2.0-beta.2', '1.2.0-beta.10'), -1);
  check('alfa je před betou', smer('1.2.0-alpha.1', '1.2.0-beta.1'), -1);
  check('kratší označení je starší', smer('1.2.0-beta', '1.2.0-beta.1'), -1);
  check('číslo je před textem', smer('1.2.0-1', '1.2.0-alpha'), -1);
  check('beta vyšší verze je pořád novější', smer('1.3.0-beta.1', '1.2.0'), 1);

  // ================================================ nesmysly
  check('nesrozumitelná verze je nejstarší', smer('nevím', '1.0.0'), -1);
  check('a proti sobě jsou si rovné', smer('nevím', 'taky nevím'), 0);
  check('prázdno taky', smer('', '1.0.0'), -1);
  check('undefined nespadne', smer(undefined, '1.0.0'), -1);

  // ================================================ jak to používá aplikace
  check('nabídne se novější', V.isNewer('1.0.0', '1.1.0'), true);
  check('stejná se nenabízí', V.isNewer('1.0.0', '1.0.0'), false);
  check('starší se nenabízí', V.isNewer('2.0.0', '1.0.0'), false);
  check('a beta se uživateli finální verze nevnucuje', V.isNewer('1.2.0', '1.2.0-beta.3'), false);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main();
