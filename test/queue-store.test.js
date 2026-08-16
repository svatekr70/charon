'use strict';

/** Nedokončené přenosy, které mají přežít zavření aplikace. */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { QueueStore } = require('../src/main/queue-store');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const item = (status, extra = {}) => ({
  direction: 'up', localPath: `/a/${status}.txt`, remotePath: `/www/${status}.txt`,
  size: 100, transferred: 40, status, speedLimit: 0, conflictResolved: false, moveFrom: null,
  ...extra,
});

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-qs-'));
  const store = new QueueStore(dir);
  await store.load();

  check('na začátku nic nečeká', store.pending('web'), []);

  // Hotové a zrušené položky nemají proč přežít; ostatní ano.
  store.remember('web', [
    item('pending'), item('active'), item('paused'), item('error'),
    item('done'), item('canceled'), item('skipped'),
  ], { name: 'Web' });

  check('ukládá se jen nedokončené',
    store.pending('web').map((i) => i.localPath).sort(),
    ['/a/active.txt', '/a/error.txt', '/a/paused.txt', '/a/pending.txt']);
  check('a nese postup, aby šlo navázat', store.pending('web')[0].transferred, 40);

  // Uložené se musí přečíst i po restartu.
  await store.save();
  const znovu = new QueueStore(dir);
  await znovu.load();
  check('po znovunačtení zůstává', znovu.pending('web').length, 4);
  check('jiná relace se neplete', znovu.pending('jiny'), []);
  check('a bez klíče taky ne', znovu.pending(null), []);

  // Prázdná fronta znamená, že už není co obnovovat.
  store.remember('web', [item('done')]);
  check('bez nedokončených se záznam smaže', store.pending('web'), []);

  store.remember('a', [item('pending')]);
  store.remember('b', [item('paused')]);
  check('relace se drží zvlášť — a', store.pending('a').length, 1);
  check('relace se drží zvlášť — b', store.pending('b').length, 1);
  store.forget('a');
  check('zapomenutí se týká jen jedné', store.pending('a').length, 0);
  check('druhá zůstává', store.pending('b').length, 1);

  // Příznaky, na kterých po obnovení záleží.
  store.remember('c', [item('pending', { conflictResolved: true, moveFrom: 'local', speedLimit: 2048 })]);
  const restored = store.pending('c')[0];
  check('přenáší se conflictResolved', restored.conflictResolved, true);
  check('i moveFrom', restored.moveFrom, 'local');
  check('i limit rychlosti', restored.speedLimit, 2048);

  // ============ zápis se nesmí odkládat donekonečna
  // Během přenosu chodí hlášení několikrát za vteřinu. Kdyby se odklad pokaždé
  // posunul, k zápisu by nedošlo nikdy — a fronta by po pádu byla prázdná
  // přesně v případě, kvůli kterému to celé existuje.
  const behem = new QueueStore(dir, { delayMs: 200, maxWaitMs: 400 });
  await behem.load();
  const start = Date.now();
  while (Date.now() - start < 1200) {
    behem.remember('beh', [item('active', { transferred: Date.now() - start })]);
    await sleep(40); // častěji, než je odklad — přesně jako skutečný přenos
  }

  const mezitim = new QueueStore(dir);
  await mezitim.load();
  check('uprostřed přenosu je fronta na disku', mezitim.pending('beh').length, 1);
  truthy('a je čerstvá', mezitim.pending('beh')[0].transferred > 0,
    `hotovo=${(mezitim.pending('beh')[0] || {}).transferred}`);

  await store.save();
  await fsp.rm(dir, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
