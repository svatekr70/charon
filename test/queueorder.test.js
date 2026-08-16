'use strict';

/**
 * Řazení a řízení jednotlivých položek ve frontě.
 *
 * U fronty o stovkách souborů je „tenhle jeden hned" a „tenhle zatím ne"
 * rozdíl mezi použitelným a nepoužitelným. Podstatné je, aby zásah do jedné
 * položky nerozhodil ostatní — a hlavně aby ručně pozastavenou položku
 * nerozeběhlo společné „Pokračovat".
 */

const { TransferQueue } = require('../src/main/queue');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/** Fronta, která sama nic nepřenáší — zajímá nás jen pořadí a stavy. */
function frontaBezPrace() {
  const q = new TransferQueue({ acquireAdapter: async () => ({}), releaseAdapter: () => {} });
  q.pause(); // ať se nikdo nerozeběhne a pořadí drží
  return q;
}

const poradi = (q) => q.items.map((i) => i.name);
const stavy = (q) => Object.fromEntries(q.items.map((i) => [i.name, i.status]));

function main() {
  const q = frontaBezPrace();
  const ids = q.add(['a', 'b', 'c', 'd'].map((n) => ({
    direction: 'up', localPath: `/l/${n}`, remotePath: `/r/${n}`, size: 10,
  })));
  // Pojmenujeme si položky, ať se v testu dá číst pořadí.
  q.items.forEach((it, i) => { it.name = ['a', 'b', 'c', 'd'][i]; });
  const id = Object.fromEntries(q.items.map((it) => [it.name, it.id]));
  q.resume();
  q.pause();
  for (const it of q.items) it.status = 'pending';   // stav po pauze srovnáme

  check('výchozí pořadí je pořadí zařazení', poradi(q), ['a', 'b', 'c', 'd']);

  // ============================================ posuny
  check('posun nahoru vrátí, že se povedl', q.moveItem(id.c, 'up'), true);
  check('a prohodí sousedy', poradi(q), ['a', 'c', 'b', 'd']);
  q.moveItem(id.c, 'down');
  check('posun dolů to vrátí zpátky', poradi(q), ['a', 'b', 'c', 'd']);

  check('„provést hned" jde na začátek', q.moveItem(id.d, 'top') && poradi(q), ['d', 'a', 'b', 'c']);
  check('a nahoře už nemá kam', q.moveItem(id.d, 'up'), false);
  check('dole taky ne', q.moveItem(id.c, 'down'), false);
  check('neznámé id nespadne', q.moveItem('nic', 'top'), false);
  check('nesmyslný směr taky ne', q.moveItem(id.a, 'stranou'), false);

  // ============================================ pořadí bere v potaz jen čekající
  // Hotová položka uprostřed nesmí posuny rozhodit ani zmizet.
  q.items.find((i) => i.name === 'a').status = 'done';
  q.moveItem(id.c, 'top');
  // „Provést hned" znamená před všechny čekající — hotová položka v cestě
  // se nepřeskakuje, ta už je odbytá.
  check('položka jde před všechny čekající', poradi(q), ['c', 'd', 'a', 'b']);
  check('hotová v seznamu zůstává', stavy(q).a, 'done');
  q.items.find((i) => i.name === 'a').status = 'pending';

  // ============================================ pozastavení jedné položky
  q.holdItem(id.b);
  check('položka je pozastavená', stavy(q).b, 'paused');
  check('a je poznat, že ručně', q.items.find((i) => i.name === 'b').held, true);
  check('ostatní to nepoznamenalo', [stavy(q).c, stavy(q).d], ['pending', 'pending']);

  // Tohle je ta podstatná část: společné „Pokračovat" ji nechá být.
  q.resume();
  check('společné pokračování ručně pozastavenou nerozeběhne', stavy(q).b, 'paused');
  check('ale ostatní ano', stavy(q).c, 'pending');

  q.releaseItem(id.b);
  check('vrácení do hry funguje', stavy(q).b, 'pending');
  check('a příznak se smaže', q.items.find((i) => i.name === 'b').held, false);

  // ============================================ co dělat nemá
  q.pause();
  for (const it of q.items) if (it.status === 'paused') it.status = 'pending';
  q.items.find((i) => i.name === 'c').status = 'done';
  q.holdItem(id.c);
  check('hotovou položku pozastavit nejde', stavy(q).c, 'done');
  q.holdItem('neznámé');   // nesmí spadnout
  q.releaseItem('neznámé');
  check('neznámé id nic nerozbije', q.items.length, 4);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main();
