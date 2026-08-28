'use strict';

/**
 * Pohled na frontu: pořadí na obrazovce a průběžné čištění.
 *
 * Obojí řeší tutéž potíž — u dávky o tisících souborech není v seznamu vidět
 * to podstatné. Řazení dá běžící přenosy nahoru, čištění zahodí hotové.
 * Hlídá se přitom, že se tím nic nerozbije: pořadí fronty musí zůstat, jak
 * bylo, a odklizené položky se pořád musí počítat do souhrnu — jinak by po
 * velké dávce přišlo hlášení „hotovo 0 položek".
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const QueueView = require('../src/common/queueview');
const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const { hostKeyPath } = require('./fixtures');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dojede(queue, ms = 10000) {
  const konec = Date.now() + ms;
  while (Date.now() < konec) {
    const bezi = queue.items.some((i) => ['pending', 'active'].includes(i.status));
    if (!bezi && !queue.workers) return;
    await sleep(30);
  }
}

// ================================================== 1. pořadí na obrazovce

function poradi() {
  // Položky pojmenované tak, aby z výsledku bylo pořadí čitelné.
  const items = [
    { n: 'done1', status: 'done' },
    { n: 'ceka1', status: 'pending' },
    { n: 'bezi1', status: 'active' },
    { n: 'chyba', status: 'error' },
    { n: 'ceka2', status: 'pending' },
    { n: 'bezi2', status: 'active' },
    { n: 'pauza', status: 'paused' },
    { n: 'zrus', status: 'canceled' },
    { n: 'done2', status: 'done' },
  ];
  check('běžící nahoře, hotové dole',
    QueueView.order(items).map((i) => i.n),
    ['bezi1', 'bezi2', 'chyba', 'pauza', 'ceka1', 'ceka2', 'zrus', 'done1', 'done2']);

  // Uvnitř skupiny se nic nepřehazuje — jinak by „posunout nahoru" u čekající
  // položky nebylo na obrazovce poznat.
  const cekajici = QueueView.order(items).filter((i) => i.status === 'pending');
  check('čekající drží pořadí fronty', cekajici.map((i) => i.n), ['ceka1', 'ceka2']);

  // Ořez až po setřídění: běžící přenos musí být vidět i s tisícem hotových.
  const hodne = [
    ...Array.from({ length: 500 }, (_, i) => ({ n: `h${i}`, status: 'done' })),
    { n: 'bezi', status: 'active' },
    { n: 'ceka', status: 'pending' },
  ];
  const vidno = QueueView.order(hodne, 3).map((i) => i.n);
  check('ořez nechá to živé nahoře', vidno, ['bezi', 'ceka', 'h0']);
  check('bez limitu se vrátí všechno', QueueView.order(hodne).length, 502);
  check('prázdná fronta nevadí', QueueView.order(undefined), []);
  check('neznámý stav skončí mezi čekajícími',
    QueueView.order([{ n: 'divny', status: 'kdoví' }, { n: 'bezi', status: 'active' }]).map((i) => i.n),
    ['bezi', 'divny']);
}

// ================================================ 2. průběžné čištění

async function cisteni() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-qv-'));
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });

  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const zdroj = path.join(tmp, 'soubor.txt');
  await fsp.writeFile(zdroj, 'obsah');
  const job = (jmeno) => ({
    direction: 'up', localPath: zdroj, remotePath: `/www/${jmeno}`, size: 5, conflictResolved: true,
  });

  // ---------------------------------------- vypnuté čištění nic nemění
  const q0 = new TransferQueue({ getAdapter: async () => adapter });
  q0.setTempName(false);
  q0.add([job('a.txt'), job('b.txt')]);
  await dojede(q0);
  check('bez čištění hotové položky zůstávají', q0.items.length, 2);
  check('a souhrn je počítá', q0.summary().done, 2);

  // ---------------------------------------- zapnuté čištění
  const q = new TransferQueue({ getAdapter: async () => adapter });
  q.setTempName(false);
  q.setAutoClear(true);
  const drained = [];
  q.on('drained', (s) => drained.push(s));

  q.add([
    job('c.txt'),
    job('d.txt'),
    // Neexistující zdroj: chyba se odklidit nesmí, na tu se má člověk podívat.
    { direction: 'up', localPath: path.join(tmp, 'nic.txt'), remotePath: '/www/e.txt', size: 1, conflictResolved: true },
  ]);
  await dojede(q);
  await sleep(200);

  check('hotové ze seznamu zmizely', q.items.map((i) => i.status), ['error']);
  check('ale započítaly se', q.cleared, 2);
  check('souhrn hlásí, kolik se opravdu přeneslo', drained.length && drained[0].done, 2);
  check('a chybu taky', drained.length && drained[0].failed, 1);
  check('snímek nese počet odklizených', q.snapshot().cleared, 2);
  check('a příznak pro okno', q.snapshot().autoClear, true);
  check('počítadlo dokončených roste přes čištění', q.snapshot().doneTotal, 2);

  // ---------------------------------------- čekání na jeden přenos
  // Editor si na přenos počká přes addAndWait — a to i tehdy, když mu ho
  // čištění pod rukama vyhodí ze seznamu.
  const cekani = q.addAndWait(job('f.txt'));
  const vysledek = await Promise.race([cekani, sleep(6000).then(() => 'nedočkal se')]);
  check('addAndWait doběhne i s čištěním', vysledek === 'nedočkal se' ? 'nedočkal se' : vysledek.status, 'done');
  check('a položka v seznamu nezůstala', q.items.map((i) => i.status), ['error']);

  // ---------------------------------------- ruční vyčištění počítadlo nuluje
  q.clearFinished();
  check('vyčištění nuluje počítadlo odklizených', q.cleared, 0);
  check('a souhrn začíná znovu', q.summary().done, 0);
  check('chybná položka zůstává i po vyčištění', q.items.map((i) => i.status), ['error']);

  await q.cancelAll();
  await q0.cancelAll();
  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });
}

async function main() {
  poradi();
  await cisteni();
  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
