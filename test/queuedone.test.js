'use strict';

/**
 * Co se stane, až fronta dojede.
 *
 * Odpojení i uspání jsou nevratné zásahy, takže se hlídá hlavně to, kdy se
 * hlásit **nemá**: po prázdném kliknutí, po pauze a po chybě. Najít ráno
 * uspaný počítač a nevědět, jestli se přenos povedl, je horší než klik navíc.
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

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
    const items = queue.snapshot().items;
    if (items.length && items.every((i) => ['done', 'error', 'skipped', 'canceled', 'paused'].includes(i.status))) return;
    await sleep(50);
  }
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-qd-'));
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

  const udalosti = [];
  const queue = new TransferQueue({ getAdapter: async () => adapter });
  queue.setTempName(false);
  queue.on('drained', (s) => udalosti.push(s));

  // ============================ prázdná fronta se neohlásí
  queue._kick();
  await sleep(200);
  check('bez práce se nic nehlásí', udalosti.length, 0);

  // ============================ po přenosu ano
  queue.add([{ direction: 'up', localPath: zdroj, remotePath: '/www/a.txt', size: 5, conflictResolved: true }]);
  await dojede(queue);
  await sleep(200);
  check('po dokončení přijde hlášení', udalosti.length, 1);
  check('a nese počet hotových', udalosti[0].done, 1);
  check('bez chyb', udalosti[0].failed, 0);
  check('a přenesené bajty', udalosti[0].bytes > 0, true);

  // ============================ podruhé se totéž neohlásí
  queue._kick();
  await sleep(200);
  check('doběhnutá fronta se neohlásí znovu', udalosti.length, 1);

  // ============================ chyba se pozná
  queue.add([{ direction: 'up', localPath: path.join(tmp, 'neexistuje.txt'), remotePath: '/www/b.txt', size: 1, conflictResolved: true }]);
  await dojede(queue);
  await sleep(200);
  check('po chybě se hlásí taky', udalosti.length, 2);
  check('a chyba je v souhrnu vidět', udalosti[1].failed, 1);
  check('hotových nepřibylo', udalosti[1].done, 1);

  // ============================ pauza není dokončení
  const q2 = new TransferQueue({ getAdapter: async () => adapter });
  const u2 = [];
  q2.on('drained', (s) => u2.push(s));
  q2.pause();
  q2.add([{ direction: 'up', localPath: zdroj, remotePath: '/www/c.txt', size: 5, conflictResolved: true }]);
  await sleep(300);
  check('pozastavená fronta se nehlásí', u2.length, 0);

  await queue.cancelAll();
  await q2.cancelAll();
  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
