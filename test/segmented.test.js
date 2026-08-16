'use strict';

/**
 * Segmentovaný přenos: víc spojení na jeden soubor.
 *
 * Skládat soubor z kusů je nejrychlejší způsob, jak ho tiše poškodit — díra
 * uprostřed se pozná až při použití. Proto se všechno kontroluje kontrolním
 * součtem proti zdroji, a hlídá se hlavně to, co se má stát, když jeden úsek
 * selže nebo když spojení navíc nejsou.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { AdapterPool } = require('../src/main/pool');
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

const otisk = async (p) => {
  const h = crypto.createHash('sha256');
  h.update(await fsp.readFile(p));
  return h.digest('hex').slice(0, 16);
};

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-seg-'));
  const serverRoot = path.join(tmp, 'server');
  const www = path.join(serverRoot, 'www');
  await fsp.mkdir(www, { recursive: true });

  // Soubor s nenulovým obsahem, ať se pozná i posunutý úsek: každý bajt
  // závisí na své pozici.
  const VELIKOST = 3 * 1024 * 1024 + 12345;
  const data = Buffer.alloc(VELIKOST);
  for (let i = 0; i < VELIKOST; i += 1) data[i] = (i * 31 + (i >> 8)) & 0xff;
  await fsp.writeFile(path.join(www, 'velky.bin'), data);
  const otiskZdroje = await otisk(path.join(www, 'velky.bin'));

  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const otevri = async () => {
    const a = new SftpAdapter();
    await a.connect(
      { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
      { verifyHostKey: () => true },
    );
    return a;
  };

  // ================================================ rozsahové čtení samo o sobě
  const a0 = await otevri();
  const cil = path.join(tmp, 'usek.bin');
  const fh = await fsp.open(cil, 'w+');
  await fh.truncate(VELIKOST);
  await a0.downloadRange('/www/velky.bin', fh.fd, 1000, 1999, {});
  await fh.close();
  const usek = await fsp.readFile(cil);
  check('úsek dorazí na správnou pozici', usek.subarray(1000, 2000).equals(data.subarray(1000, 2000)), true);
  check('a mimo něj se nic nezapsalo', usek[999], 0);
  await a0.disconnect();

  // ================================================ celý přenos
  const pool = new AdapterPool({ open: otevri, max: 4 });
  const queue = new TransferQueue({
    acquireAdapter: () => pool.acquire(),
    releaseAdapter: (a) => pool.release(a),
    tryAcquireAdapter: () => pool.tryAcquire(),
  });
  queue.setSegments(1024 * 1024, 4);

  const dojede = async (q, ms = 30000) => {
    const konec = Date.now() + ms;
    while (Date.now() < konec) {
      const items = q.snapshot().items;
      const posledni = items[items.length - 1];
      if (posledni && ['done', 'error', 'skipped', 'canceled'].includes(posledni.status)) return posledni;
      await sleep(60);
    }
    throw new Error('přenos nedojel');
  };

  queue.add([{
    direction: 'down', remotePath: '/www/velky.bin', localPath: path.join(tmp, 'stazeny.bin'),
    size: VELIKOST, conflictResolved: true,
  }]);
  const it = await dojede(queue);
  check('přenos je hotový', it.status, 'done');
  check('velikost sedí', (await fsp.stat(path.join(tmp, 'stazeny.bin'))).size, VELIKOST);
  check('a obsah je bajt po bajtu stejný', await otisk(path.join(tmp, 'stazeny.bin')), otiskZdroje);
  truthy('je vidět, že se stahovalo víc spojeními', /spojení naráz/.test(it.note || ''), it.note);
  check('přeneslo se přesně tolik, kolik měřilo', it.transferred, VELIKOST);

  // ================================================ malý soubor se nerozděluje
  await fsp.writeFile(path.join(www, 'maly.bin'), Buffer.alloc(1024, 7));
  queue.add([{
    direction: 'down', remotePath: '/www/maly.bin', localPath: path.join(tmp, 'maly.bin'),
    size: 1024, conflictResolved: true,
  }]);
  const maly = await dojede(queue);
  check('malý soubor projde jedním proudem', maly.note, null);
  check('a taky sedí', (await fsp.stat(path.join(tmp, 'maly.bin'))).size, 1024);

  // ================================================ bez volných spojení
  // Zásoba o jednom spojení: segmentovat není z čeho, ale přenos musí projít.
  const uzkyPool = new AdapterPool({ open: otevri, max: 1 });
  const q2 = new TransferQueue({
    acquireAdapter: () => uzkyPool.acquire(),
    releaseAdapter: (a) => uzkyPool.release(a),
    tryAcquireAdapter: () => uzkyPool.tryAcquire(),
  });
  q2.setSegments(1024 * 1024, 4);
  q2.add([{
    direction: 'down', remotePath: '/www/velky.bin', localPath: path.join(tmp, 'uzky.bin'),
    size: VELIKOST, conflictResolved: true,
  }]);
  const uzky = await dojede(q2);
  check('bez volných spojení se stáhne jedním proudem', uzky.status, 'done');
  check('a soubor je pořád v pořádku', await otisk(path.join(tmp, 'uzky.bin')), otiskZdroje);

  // ================================================ vypnuté segmentování
  const q3 = new TransferQueue({
    acquireAdapter: () => pool.acquire(),
    releaseAdapter: (a) => pool.release(a),
    tryAcquireAdapter: () => pool.tryAcquire(),
  });
  q3.setSegments(0, 4);
  q3.add([{
    direction: 'down', remotePath: '/www/velky.bin', localPath: path.join(tmp, 'vypnuto.bin'),
    size: VELIKOST, conflictResolved: true,
  }]);
  const vyp = await dojede(q3);
  check('s vypnutým nastavením se nerozděluje', vyp.note, null);
  check('a soubor sedí', await otisk(path.join(tmp, 'vypnuto.bin')), otiskZdroje);

  // ================================================ selhání jednoho úseku
  // Kdyby se chyba spolkla, zůstal by soubor správné velikosti s dírou uvnitř.
  const q4 = new TransferQueue({
    acquireAdapter: () => pool.acquire(),
    releaseAdapter: (a) => pool.release(a),
    tryAcquireAdapter: async () => {
      const a = await pool.tryAcquire();
      if (!a) return null;
      // Jedno ze spojení navíc bude vracet chybu.
      const rozbite = Object.create(a);
      rozbite.downloadRange = async () => { throw new Error('spojení spadlo uprostřed'); };
      return rozbite;
    },
  });
  q4.setSegments(1024 * 1024, 4);
  // Dočasný název schválně vypnutý: segmentovaný přenos si ho musí vynutit sám,
  // jinak by po selhaném úseku zůstal na cíli soubor s dírou uvnitř.
  q4.setTempName(false);
  q4.add([{
    direction: 'down', remotePath: '/www/velky.bin', localPath: path.join(tmp, 'rozbity.bin'),
    size: VELIKOST, conflictResolved: true,
  }]);
  const rozbity = await dojede(q4);
  check('selhání úseku shodí celý přenos', rozbity.status, 'error');
  truthy('a řekne se proč', /spadlo|přenesl/.test(rozbity.error || ''), rozbity.error);
  check('cílový soubor nezůstane vydávaný za hotový',
    fs.existsSync(path.join(tmp, 'rozbity.bin')), false);
  check('a rozepsaný kus se pozná podle přípony',
    fs.existsSync(path.join(tmp, 'rozbity.bin.filepart')), true);

  await pool.closeAll();
  await uzkyPool.closeAll();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
