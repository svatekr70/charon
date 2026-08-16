'use strict';

/**
 * Souběžné přenosy a omezení rychlosti.
 *
 * Rychlost se měří doopravdy — proti hodinkám, ne proti počítadlu, které si
 * omezovač vede sám. Jinak by test potvrdil jen to, že si program myslí,
 * že zpomalil.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const { AdapterPool } = require('../src/main/pool');
const { RateLimiter, ThrottleStream, makeThrottle } = require('../src/main/throttle');

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

function waitAll(queue, ids) {
  return new Promise((resolve) => {
    const done = () => ids.every((id) => {
      const it = queue.items.find((x) => x.id === id);
      return it && !['pending', 'active', 'paused'].includes(it.status);
    });
    const onUpd = () => { if (done()) { queue.off('update', onUpd); resolve(); } };
    queue.on('update', onUpd);
    onUpd();
  });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-par-'));
  const serverRoot = path.join(tmp, 'server');
  const localRoot = path.join(tmp, 'local');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  await fsp.mkdir(localRoot, { recursive: true });

  // ============================================== 1. omezovač bez sítě
  // Falešné hodiny, aby test neběžel reálné vteřiny.
  let clock = 0;
  const lim = new RateLimiter(1000, () => clock);
  await lim.take(1000);
  check('plná zásoba se vyčerpá hned', clock, 0);

  const started = Promise.resolve().then(() => lim.take(500));
  let settled = false;
  started.then(() => { settled = true; });
  await sleep(20);
  check('přes limit se čeká', settled, false);
  clock += 600; // za 600 ms přiteče 600 tokenů
  await sleep(250);
  await started;
  check('po doplnění se pokračuje', settled, true);

  const off = new RateLimiter(0);
  check('nula znamená bez omezení', off.unlimited, true);
  await off.take(10 ** 9);
  check('a neomezený nečeká', true, true);

  lim.setRate(0);
  check('vypnutí limitu za běhu', lim.unlimited, true);

  check('bez omezovačů se throttle nevyrábí', makeThrottle([new RateLimiter(0)]), null);
  truthy('s omezovačem ano', makeThrottle([new RateLimiter(1000)]) instanceof ThrottleStream);

  // ------------------------------------ skutečně naměřené zpomalení
  const payload = crypto.randomBytes(300 * 1024); // 300 kB
  const throttled = new ThrottleStream([new RateLimiter(150 * 1024)]); // 150 kB/s
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const chunks = [];
    throttled.on('data', (c) => chunks.push(c));
    throttled.on('end', () => {
      check('omezený stream nic neztratí', Buffer.concat(chunks).equals(payload), true);
      resolve();
    });
    throttled.on('error', reject);
    throttled.end(payload);
  });
  const elapsed = Date.now() - t0;
  // 300 kB při 150 kB/s trvá kolem dvou sekund; první sekundu pokryje zásoba.
  truthy('300 kB při 150 kB/s trvá aspoň sekundu', elapsed >= 900, `naměřeno ${elapsed} ms`);
  truthy('a ne nesmyslně dlouho', elapsed < 6000, `naměřeno ${elapsed} ms`);

  // ================================================ 2. zásoba spojení
  let opened = 0;
  const fakePool = new AdapterPool({
    open: async () => { opened += 1; return { id: opened, connected: true, disconnect: async () => {} }; },
    max: 3,
  });
  const a1 = await fakePool.acquire();
  const a2 = await fakePool.acquire();
  check('otevřou se dvě spojení', opened, 2);
  check('obě jsou zabraná', fakePool.busy, 2);
  fakePool.release(a1);
  const a3 = await fakePool.acquire();
  check('vrácené spojení se recykluje', opened, 2);
  check('a je to totéž', a3.id, a1.id);
  fakePool.release(a2);
  fakePool.release(a3);

  // Čtvrtý žadatel při stropu 2 musí počkat, ne otevřít další spojení.
  fakePool.setMax(2);
  const b1 = await fakePool.acquire();
  const b2 = await fakePool.acquire();
  let b3done = false;
  const b3 = fakePool.acquire().then((a) => { b3done = true; return a; });
  await sleep(30);
  check('nad strop se čeká', b3done, false);
  fakePool.release(b1);
  await b3;
  check('po uvolnění se pokračuje', b3done, true);
  await fakePool.closeAll();

  // Když server další spojení nepustí, zásoba se sama zmenší.
  let shrunkTo = null;
  const strict = new AdapterPool({
    open: async () => {
      if (strict.all.length >= 1) throw new Error('too many connections');
      return { connected: true, disconnect: async () => {} };
    },
    max: 4,
    onShrink: (n) => { shrunkTo = n; },
  });
  const only = await strict.acquire();
  let secondDone = false;
  const second = strict.acquire().then((a) => { secondDone = true; return a; });
  await sleep(30);
  check('druhé spojení se nevnutí', secondDone, false);
  check('zásoba se zmenšila', shrunkTo, 1);
  strict.release(only);
  await second;
  check('a přenos přesto pokračuje', secondDone, true);
  await strict.closeAll();

  // Když neprojde ani první spojení, chyba se musí ozvat.
  const dead = new AdapterPool({ open: async () => { throw new Error('nedostupné'); }, max: 2 });
  let deadErr = null;
  try { await dead.acquire(); } catch (e) { deadErr = e; }
  truthy('selhání prvního spojení se ohlásí', deadErr && /nedostupné/.test(deadErr.message));

  // ======================================= 3. souběžnost proti serveru
  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const cfg = { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' };

  const realPool = new AdapterPool({
    open: async () => {
      const a = new SftpAdapter();
      await a.connect(cfg, { verifyHostKey: () => true });
      return a;
    },
    max: 3,
  });

  // 12 souborů po 200 kB
  const files = [];
  for (let i = 0; i < 12; i += 1) {
    const p = path.join(localRoot, `f${i}.bin`);
    await fsp.writeFile(p, crypto.randomBytes(200 * 1024));
    files.push(p);
  }

  let peak = 0;
  const q = new TransferQueue({
    concurrency: 3,
    acquireAdapter: () => realPool.acquire(),
    releaseAdapter: (a) => realPool.release(a),
  });
  q.on('update', (s) => { peak = Math.max(peak, s.active); });

  const ids = q.add(files.map((p, i) => ({
    direction: 'up', localPath: p, remotePath: `/www/p${i}.bin`, conflictResolved: true,
  })));
  await waitAll(q, ids);

  check('všechny položky doběhly', q.items.filter((i) => i.status === 'done').length, 12);
  truthy('běželo víc přenosů naráz', peak > 1, `nejvíc ${peak}`);
  truthy('a ne víc, než je dovoleno', peak <= 3, `nejvíc ${peak}`);
  truthy('otevřelo se víc spojení', realPool.size > 1, `${realPool.size} spojení`);

  for (let i = 0; i < 12; i += 1) {
    const src = await fsp.readFile(files[i]);
    const dst = await fsp.readFile(path.join(serverRoot, 'www', `p${i}.bin`));
    if (!src.equals(dst)) { check(`soubor p${i} dorazil celý`, false, true); break; }
  }
  check('všech 12 souborů dorazilo neporušených', true, true);

  // Pauza musí zastavit všechny běžící, ne jen jeden.
  const q2 = new TransferQueue({
    concurrency: 3,
    acquireAdapter: () => realPool.acquire(),
    releaseAdapter: (a) => realPool.release(a),
  });
  const big = path.join(localRoot, 'big.bin');
  await fsp.writeFile(big, crypto.randomBytes(20 * 1024 * 1024));
  const ids2 = q2.add([0, 1, 2].map((i) => ({
    direction: 'up', localPath: big, remotePath: `/www/big${i}.bin`, conflictResolved: true,
  })));
  await new Promise((resolve) => {
    const onUpd = (s) => { if (s.active >= 2) { q2.off('update', onUpd); resolve(); } };
    q2.on('update', onUpd);
  });
  q2.pause();
  await sleep(400);
  check('pauza zastaví všechny běžící', q2.items.filter((i) => i.status === 'active').length, 0);
  truthy('a vrátí je do fronty', q2.items.some((i) => i.status === 'paused'));
  q2.resume();
  await waitAll(q2, ids2);
  check('po pokračování všechno doběhne', q2.items.filter((i) => i.status === 'done').length, 3);

  // ============================== 4. limit rychlosti v reálném přenosu
  const q3 = new TransferQueue({
    concurrency: 2,
    acquireAdapter: () => realPool.acquire(),
    releaseAdapter: (a) => realPool.release(a),
  });
  q3.setSpeedLimit(400 * 1024); // 400 kB/s
  check('limit se propíše do souhrnu', q3.snapshot().speedLimit, 400 * 1024);

  const limited = [];
  for (let i = 0; i < 4; i += 1) {
    const p = path.join(localRoot, `lim${i}.bin`);
    await fsp.writeFile(p, crypto.randomBytes(300 * 1024)); // celkem 1,2 MB
    limited.push(p);
  }
  const start = Date.now();
  const ids3 = q3.add(limited.map((p, i) => ({
    direction: 'up', localPath: p, remotePath: `/www/lim${i}.bin`, conflictResolved: true,
  })));
  await waitAll(q3, ids3);
  const took = Date.now() - start;
  // 1,2 MB při 400 kB/s ≈ 3 s; sekundu pokryje počáteční zásoba, takže ≥ 1,5 s.
  truthy('limit přenos prokazatelně zpomalí', took >= 1500, `1,2 MB za ${took} ms`);
  check('a data zůstanou celá',
    (await fsp.readFile(path.join(serverRoot, 'www', 'lim0.bin'))).equals(await fsp.readFile(limited[0])), true);

  // Bez limitu musí být stejná dávka výrazně rychlejší.
  q3.setSpeedLimit(0);
  const start2 = Date.now();
  const ids4 = q3.add(limited.map((p, i) => ({
    direction: 'up', localPath: p, remotePath: `/www/free${i}.bin`, conflictResolved: true,
  })));
  await waitAll(q3, ids4);
  const took2 = Date.now() - start2;
  truthy('bez limitu je to znatelně rychlejší', took2 < took / 2, `${took2} ms proti ${took} ms`);

  // =============== 5. proč to vlastně chceme: latence, ne šířka pásma
  // Na loopbacku je latence nulová, takže by souběžnost nic neukázala.
  // Testovací server proto umí odpovídat se zpožděním jako vzdálený stroj.
  const slow = await startTestServer({
    root: serverRoot,
    hostKeyPath: path.join(__dirname, 'fixtures', 'host_key'),
    latencyMs: 20,
  });
  const slowCfg = { host: '127.0.0.1', port: slow.port, username: 'test', password: 'test' };

  const small = [];
  for (let i = 0; i < 20; i += 1) {
    const p = path.join(localRoot, `s${i}.txt`);
    await fsp.writeFile(p, crypto.randomBytes(2048));
    small.push(p);
  }

  const timeWith = async (concurrency, tag) => {
    const p = new AdapterPool({
      open: async () => {
        const a = new SftpAdapter();
        await a.connect(slowCfg, { verifyHostKey: () => true });
        return a;
      },
      max: concurrency,
    });
    const qq = new TransferQueue({
      concurrency,
      acquireAdapter: () => p.acquire(),
      releaseAdapter: (a) => p.release(a),
    });
    const jobIds = qq.add(small.map((f, i) => ({
      direction: 'up', localPath: f, remotePath: `/www/${tag}${i}.txt`, conflictResolved: true,
    })));
    const t = Date.now();
    await waitAll(qq, jobIds);
    const ms = Date.now() - t;
    const failed = qq.items.filter((i) => i.status !== 'done').length;
    await p.closeAll();
    return { ms, failed };
  };

  const serial = await timeWith(1, 'ser');
  const parallel = await timeWith(4, 'par');
  check('sériově vše dorazí', serial.failed, 0);
  check('souběžně taky', parallel.failed, 0);
  truthy('při latenci 20 ms je souběžnost aspoň dvakrát rychlejší',
    serial.ms > parallel.ms * 2,
    `sériově ${serial.ms} ms, souběžně ${parallel.ms} ms — ${(serial.ms / parallel.ms).toFixed(1)}×`);

  await slow.close();
  await realPool.closeAll();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});
