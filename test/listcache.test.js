'use strict';

/**
 * Vyrovnávací paměť výpisů.
 *
 * Rychlost je tu ta snadnější půlka. Podstatné je, kdy se paměť musí zahodit:
 * zastaralý výpis vede k tomu, že člověk maže soubor, který už neexistuje, nebo
 * nevidí ten, který právě nahrál. Proto se testuje hlavně zahazování.
 */

const { ListCache } = require('../src/main/listcache');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VYPIS = [{ name: 'index.php', type: 'f' }];

async function main() {
  const c = new ListCache({ ttlMs: 400, max: 3 });

  check('co tam není, se nevrátí', c.get('/www'), null);
  c.set('/www', VYPIS);
  check('uložený výpis se vrátí', c.get('/www'), VYPIS);
  check('a jiná složka pořád nic', c.get('/jinde'), null);

  // ============================================ platnost
  await sleep(500);
  check('po vypršení se výpis zahodí', c.get('/www'), null);
  check('a nezůstane ležet ani v paměti', c.size, 0);

  // ============================================ zahození po zápisu
  c.set('/a', VYPIS);
  c.set('/b', VYPIS);
  check('dvě složky se pamatují', c.size, 2);
  c.clear();
  check('zápis na server vyhodí všechno', [c.get('/a'), c.get('/b'), c.size], [null, null, 0]);

  // ============================================ omezení velikosti
  const d = new ListCache({ ttlMs: 10000, max: 3 });
  for (const p of ['/1', '/2', '/3', '/4']) d.set(p, VYPIS);
  check('drží se jen tolik složek, kolik smí', d.size, 3);
  check('a zahodí se ta nejdéle nepoužitá', d.get('/1'), null);
  check('novější zůstávají', [d.get('/2'), d.get('/3'), d.get('/4')].every(Boolean), true);

  // Použití složku omladí, takže na řadě je jiná.
  const e = new ListCache({ ttlMs: 10000, max: 3 });
  e.set('/1', VYPIS); e.set('/2', VYPIS); e.set('/3', VYPIS);
  e.get('/1');            // /1 je teď čerstvě použitá
  e.set('/4', VYPIS);     // vyhodit se má /2, ne /1
  check('použitá složka se nezahodí první', Boolean(e.get('/1')), true);
  check('na řadu přijde ta opravdu nejstarší', e.get('/2'), null);

  // ============================================ vypnutá paměť
  const f = new ListCache({ ttlMs: 10000 });
  f.set('/x', VYPIS);
  f.setEnabled(false);
  check('vypnutím se paměť vysype', f.size, 0);
  f.set('/x', VYPIS);
  check('a už si nic neukládá', [f.get('/x'), f.size], [null, 0]);
  f.setEnabled(true);
  f.set('/x', VYPIS);
  check('po zapnutí zase funguje', f.get('/x'), VYPIS);

  // ============================================ počítadla, ať jde měřit užitek
  const g = new ListCache({ ttlMs: 10000 });
  g.set('/x', VYPIS);
  g.get('/x'); g.get('/x'); g.get('/y');
  check('trefy a minutí se počítají', [g.hits, g.misses], [2, 1]);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
