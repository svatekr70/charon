'use strict';

/**
 * Textový režim při skutečném přenosu.
 *
 * Převod konců řádků se testuje jinde; tady jde o to, že se použije jen tam,
 * kde má, a že se u něj nenavazuje. Navázání by po převodu dopisovalo od
 * pozice, která ve zdroji znamená něco jiného — soubor by tím vznikl poškozený
 * a poznalo by se to až v prohlížeči.
 */

const fs = require('fs');
const fsp = fs.promises;
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
const truthy = (label, v, note = '') => {
  const ok = Boolean(v);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${note ? `  (${note})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Konce řádků zviditelníme, ať je v hlášce vidět, co přesně nesedí.
const vidiseEol = (b) => b.toString('utf8').replace(/\r\n/g, '␍␊').replace(/(?<!␍)\n/g, '␊');

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-txt-'));
  const serverRoot = path.join(tmp, 'server');
  const www = path.join(serverRoot, 'www');
  await fsp.mkdir(www, { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const dojede = async (q) => {
    const konec = Date.now() + 10000;
    while (Date.now() < konec) {
      const items = q.snapshot().items;
      if (items.length && items.every((i) => ['done', 'error', 'skipped'].includes(i.status))) return items;
      await sleep(60);
    }
    throw new Error('přenos nedojel');
  };

  // Lokální zdroje: textový s LF a binární, který se do masky nesmí dostat.
  await fsp.writeFile(path.join(tmp, 'skript.sh'), '#!/bin/sh\necho ahoj\n');
  await fsp.writeFile(path.join(tmp, 'data.bin'), Buffer.from([0x00, 0x0a, 0xff, 0x0a, 0x80]));

  // ================================================ nahrání s CRLF na serveru
  const q1 = new TransferQueue({ getAdapter: async () => adapter });
  q1.setTempName(false);
  q1.setTextMode('*.sh; *.txt', 'crlf');
  q1.add([
    { direction: 'up', localPath: path.join(tmp, 'skript.sh'), remotePath: '/www/skript.sh', size: 19, conflictResolved: true },
    { direction: 'up', localPath: path.join(tmp, 'data.bin'), remotePath: '/www/data.bin', size: 5, conflictResolved: true },
  ]);
  const it1 = await dojede(q1);
  check('textový soubor dostal CRLF',
    vidiseEol(await fsp.readFile(path.join(www, 'skript.sh'))), '#!/bin/sh␍␊echo ahoj␍␊');
  check('binární soubor zůstal nedotčený',
    [...(await fsp.readFile(path.join(www, 'data.bin')))], [0x00, 0x0a, 0xff, 0x0a, 0x80]);
  truthy('u textového je poznámka', /textový režim/.test(it1[0].note || ''), it1[0].note);
  check('u binárního není', it1[1].note, null);

  // ================================================ stažení sjednotí na LF
  await fsp.writeFile(path.join(www, 'stranka.txt'), 'první\r\ndruhý\r\n');
  const q2 = new TransferQueue({ getAdapter: async () => adapter });
  q2.setTempName(false);
  q2.setTextMode('*.txt', 'crlf');
  q2.add([{ direction: 'down', remotePath: '/www/stranka.txt', localPath: path.join(tmp, 'stranka.txt'), size: 14, conflictResolved: true }]);
  await dojede(q2);
  check('stažený soubor má LF',
    vidiseEol(await fsp.readFile(path.join(tmp, 'stranka.txt'))), 'první␊druhý␊');

  // ================================================ bez masky se nepřevádí
  const q3 = new TransferQueue({ getAdapter: async () => adapter });
  q3.setTempName(false);
  q3.setTextMode('', 'crlf');
  q3.add([{ direction: 'up', localPath: path.join(tmp, 'skript.sh'), remotePath: '/www/beze-zmeny.sh', size: 19, conflictResolved: true }]);
  await dojede(q3);
  check('vypnutý režim nechá soubor být',
    vidiseEol(await fsp.readFile(path.join(www, 'beze-zmeny.sh'))), '#!/bin/sh␊echo ahoj␊');

  // ================================================ v textovém režimu se nenavazuje
  // Na serveru necháme kus souboru; bez textového režimu by se dopsal zbytek,
  // s ním se musí přenést celý znovu — jinak by vznikl slepenec.
  await fsp.writeFile(path.join(www, 'navazani.txt'), '#!/bin/sh\n');
  const q4 = new TransferQueue({ getAdapter: async () => adapter });
  q4.setTempName(false);
  q4.setTextMode('*.txt', 'crlf');
  q4.add([{ direction: 'up', localPath: path.join(tmp, 'skript.sh'), remotePath: '/www/navazani.txt', size: 19, conflictResolved: true }]);
  const it4 = await dojede(q4);
  check('soubor je celý a převedený',
    vidiseEol(await fsp.readFile(path.join(www, 'navazani.txt'))), '#!/bin/sh␍␊echo ahoj␍␊');
  // Zdroj má 20 bajtů, na serveru je jich po převodu 22. Průběh se schválně
  // počítá podle zdroje — jinak by ukazatel u textového souboru přetekl.
  check('a přenos začal od nuly', it4[0].transferred, 20);
  check('na serveru je soubor delší o dva bajty',
    (await fsp.stat(path.join(www, 'navazani.txt'))).size, 22);

  // ================================================ velikost se po převodu liší
  // Důsledek, na který se snadno zapomene: soubor v textovém režimu má na
  // druhé straně jinou velikost, takže porovnávání „jen nové a změněné" se
  // u něj nesmí řídit velikostí. Tady jen doložíme, že se opravdu liší.
  const mistni = (await fsp.stat(path.join(tmp, 'skript.sh'))).size;
  const vzdaleny = (await fsp.stat(path.join(www, 'skript.sh'))).size;
  check('zdroj a cíl se v textovém režimu liší velikostí', vzdaleny - mistni, 2);

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
