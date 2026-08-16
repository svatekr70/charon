'use strict';

/**
 * Odhad zbývajícího času a celková rychlost.
 *
 * Odhad, který skáče nebo lže, je horší než žádný — člověk podle něj plánuje,
 * jestli si mezitím odskočí. Proto se měří průtok celé fronty v posuvném okně
 * a testuje se proti skutečnému přenosu se známou rychlostí, ne proti
 * spočítaným číslům.
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');

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

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-eta-'));
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  // 3 MB při stropu 300 kB/s vyjde zhruba na deset vteřin.
  const velikost = 3 * 1024 * 1024;
  const zdroj = path.join(tmp, 'velky.bin');
  await fsp.writeFile(zdroj, Buffer.alloc(velikost, 7));

  const queue = new TransferQueue({ getAdapter: async () => adapter });
  queue.setTempName(false);
  queue.setSpeedLimit(300 * 1024);

  // ============================ prázdná fronta nic neodhaduje
  check('bez práce není co odhadovat', queue.snapshot().eta, null);
  check('a rychlost je nulová', queue.snapshot().speedAvg, 0);

  queue.add([{ direction: 'up', localPath: zdroj, remotePath: '/www/velky.bin', size: velikost }]);
  check('velikost je známá hned po zařazení', queue.snapshot().totalBytes, velikost);
  check('a nic nechybí', queue.snapshot().unknownSizes, 0);

  // ============================ v průběhu přenosu
  await sleep(3000);
  const behem = queue.snapshot();
  truthy('během přenosu se odhad objeví', behem.eta !== null, `eta=${behem.eta}`);
  truthy('a rychlost odpovídá stropu (±40 %)',
    behem.speedAvg > 300 * 1024 * 0.6 && behem.speedAvg < 300 * 1024 * 1.4,
    `${Math.round(behem.speedAvg / 1024)} kB/s`);

  // Zbývá ~2 MB při 300 kB/s, tedy kolem sedmi vteřin.
  const zbyva = (behem.totalBytes - behem.doneBytes) / (300 * 1024);
  truthy('odhad souhlasí s výpočtem (±50 %)',
    behem.eta > zbyva * 0.5 && behem.eta < zbyva * 1.5,
    `odhad ${behem.eta} s, spočteno ${Math.round(zbyva)} s`);

  // ============================ pauza odhad nezmrazí na nesmyslu
  queue.pause();
  await sleep(300);
  const napauze = queue.snapshot();
  check('na pauze se nic neodhaduje', napauze.eta, null);
  check('a rychlost je nulová', napauze.speedAvg, 0);
  queue.resume();

  // ============================ dokončení
  const konec = Date.now();
  while (Date.now() - konec < 30000) {
    if (queue.snapshot().items.every((i) => ['done', 'error', 'skipped', 'canceled'].includes(i.status))) break;
    await sleep(200);
  }
  const hotovo = queue.snapshot();
  check('přenos doběhl', hotovo.items[0].status, 'done');
  check('po dojetí není co odhadovat', hotovo.eta, null);
  check('a přeneslo se, co mělo', hotovo.items[0].transferred, velikost);
  check('velikost na serveru sedí', (await fsp.stat(path.join(serverRoot, 'www', 'velky.bin'))).size, velikost);

  // ============================ položka bez známé velikosti
  const q2 = new TransferQueue({ getAdapter: async () => adapter });
  q2.pause(); // ať se nerozeběhne a stihneme se podívat
  q2.add([{ direction: 'down', remotePath: '/www/velky.bin', localPath: path.join(tmp, 'a.bin'), size: null }]);
  const snap2 = q2.snapshot();
  check('neznámá velikost se přizná', snap2.unknownSizes, 1);
  check('a odhad se radši neukazuje', snap2.eta, null);

  // ============================ posuvné okno zapomíná
  const q3 = new TransferQueue({ getAdapter: async () => adapter });
  q3._sample(1024 * 1024);
  await sleep(600);
  q3._sample(1024 * 1024);
  truthy('z čerstvých vzorků rychlost vyjde', q3._windowSpeed() > 0, `${q3._windowSpeed()} B/s`);
  // Když se dvě vteřiny nic nepřeneslo, přenos stojí a okno to musí přiznat.
  await sleep(2200);
  check('když se nic neděje, rychlost padá na nulu', q3._windowSpeed(), 0);

  await queue.cancelAll();
  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
