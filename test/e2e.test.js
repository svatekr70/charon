'use strict';

/**
 * End-to-end test proti lokálnímu SFTP serveru: adaptér, fronta přenosů
 * (včetně navázání na přerušený přenos) a porovnání adresářů.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const { compare } = require('../src/main/sync');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const truthy = (label, v) => check(label, Boolean(v), true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ftpcli-e2e-'));
  const serverRoot = path.join(tmp, 'server');
  const localRoot = path.join(tmp, 'local');
  await fsp.mkdir(serverRoot, { recursive: true });
  await fsp.mkdir(localRoot, { recursive: true });

  const server = await startTestServer({
    root: serverRoot,
    hostKeyPath: path.join(__dirname, 'fixtures', 'host_key'),
  });
  console.log(`Testovací SFTP server na portu ${server.port}, kořen ${serverRoot}\n`);

  const cfg = { host: '127.0.0.1', port: server.port, username: 'test', password: 'test', protocol: 'sftp' };
  const adapter = new SftpAdapter();
  await adapter.connect(cfg, { verifyHostKey: () => true }); // v testu klíč známe
  truthy('připojení k SFTP', adapter.connected);

  // ---------------------------------------------------------- výpis, mkdir
  await adapter.mkdir('/www/assets', true);
  await fsp.writeFile(path.join(serverRoot, 'www', 'index.php'), '<?php echo "ahoj";');
  let entries = await adapter.list('/www');
  check('výpis adresáře', entries.map((e) => `${e.type}:${e.name}`).sort(), ['d:assets', 'f:index.php']);
  check('velikost souboru', entries.find((e) => e.name === 'index.php').size, 18);

  // ---------------------------------------------------------------- upload
  const bigLocal = path.join(localRoot, 'big.bin');
  const payload = crypto.randomBytes(3 * 1024 * 1024); // 3 MB
  await fsp.writeFile(bigLocal, payload);

  // Průběh sledujeme přímo na adaptéru — fronta hlásí stav do UI omezeně
  // (max 8× za sekundu), takže u rychlého přenosu by se do ní nemusel vejít.
  const progressTicks = [];
  const realUpload = adapter.upload.bind(adapter);
  adapter.upload = (l, r, opts) => realUpload(l, r, {
    ...opts,
    onProgress: (b) => { progressTicks.push(b); if (opts.onProgress) opts.onProgress(b); },
  });

  const queue = new TransferQueue({ getAdapter: async () => adapter });
  // Tenhle soubor testuje navázání do cílového souboru. S přenosem přes
  // dočasný název by se psalo jinam a testy níž by procházely, aniž by
  // navázání vůbec proběhlo. Varianta s dočasným názvem má vlastní test.
  queue.setTempName(false);
  await queue.addAndWait({ direction: 'up', localPath: bigLocal, remotePath: '/www/big.bin' });
  adapter.upload = realUpload;
  const uploaded = await fsp.readFile(path.join(serverRoot, 'www', 'big.bin'));
  check('upload — velikost', uploaded.length, payload.length);
  check('upload — obsah shodný', uploaded.equals(payload), true);
  truthy('upload — hlásil průběh', progressTicks.length > 1);
  check('upload — poslední hlášený průběh = velikost', progressTicks.at(-1), payload.length);

  // -------------------------------------------------------------- download
  const dlPath = path.join(localRoot, 'stazeny.bin');
  await queue.addAndWait({ direction: 'down', remotePath: '/www/big.bin', localPath: dlPath });
  check('download — obsah shodný', (await fsp.readFile(dlPath)).equals(payload), true);

  // ------------------------------------------- navázání přerušeného přenosu
  // Simulujeme přerušení: lokálně necháme jen první polovinu a položce
  // nastavíme transferred > 0, což frontě řekne "tohle navazuj, nepřepisuj".
  const resumePath = path.join(localRoot, 'resume.bin');
  const half = Math.floor(payload.length / 2);
  await fsp.writeFile(resumePath, payload.subarray(0, half));

  queue.pause(); // fronta stojí, položka se nerozeběhne dřív, než ji nastavíme
  const ids = queue.add([{ direction: 'down', remotePath: '/www/big.bin', localPath: resumePath }]);
  queue.items.find((i) => i.id === ids[0]).transferred = half;
  queue.resume();
  await new Promise((resolve) => {
    const onUpd = () => {
      const it = queue.items.find((i) => i.id === ids[0]);
      if (['done', 'error', 'canceled'].includes(it.status)) { queue.off('update', onUpd); resolve(); }
    };
    queue.on('update', onUpd);
    onUpd();
  });
  const resumed = await fsp.readFile(resumePath);
  check('navázání — výsledná velikost', resumed.length, payload.length);
  check('navázání — obsah shodný', resumed.equals(payload), true);

  // Regrese: navázané nahrávání kdysi asi ve třetině případů zapsalo od nuly
  // a uříznulo tím už přenesenou část souboru. Šlo o závod, takže jeden
  // průchod ho nechytí — opakujeme.
  const seed = payload.subarray(0, half);
  let resumeOk = 0;
  for (let i = 0; i < 20; i += 1) {
    await fsp.writeFile(path.join(serverRoot, 'www', `resume-${i}.bin`), seed);
    // Pauza před přidáním: jinak se položka rozeběhne dřív, než jí nastavíme
    // transferred, a fronta by místo navázání soubor přepsala od začátku.
    queue.pause();
    const [rid] = queue.add([{
      direction: 'up', localPath: bigLocal, remotePath: `/www/resume-${i}.bin`, conflictResolved: true,
    }]);
    queue.items.find((x) => x.id === rid).transferred = half;
    queue.resume();
    await waitFor(queue, rid);
    const got = await fsp.readFile(path.join(serverRoot, 'www', `resume-${i}.bin`));
    if (got.equals(payload)) resumeOk += 1;
  }
  check('navázané nahrávání je spolehlivé (20×)', resumeOk, 20);

  // ----------------------------------------------- pauza uprostřed přenosu
  // Dost velký soubor na to, aby přenos přes loopback trval déle než reakce
  // testu — u 3 MB by doběhl dřív, než stihneme zmáčknout pauzu.
  const hugeLocal = path.join(localRoot, 'huge.bin');
  const hugePayload = crypto.randomBytes(48 * 1024 * 1024);
  await fsp.writeFile(hugeLocal, hugePayload);
  await queue.addAndWait({ direction: 'up', localPath: hugeLocal, remotePath: '/www/huge.bin' });

  const pausePath = path.join(localRoot, 'pause.bin');
  const q2 = new TransferQueue({ getAdapter: async () => adapter });
  q2.setTempName(false);
  const [pid] = q2.add([{ direction: 'down', remotePath: '/www/huge.bin', localPath: pausePath }]);

  // Pauzu spustíme, jakmile přenos prokazatelně běží.
  await new Promise((resolve) => {
    const onUpd = (s) => {
      const it = s.items.find((i) => i.id === pid);
      if (it && it.status === 'active' && it.transferred > 0) { q2.off('update', onUpd); resolve(); }
    };
    q2.on('update', onUpd);
  });
  q2.pause();
  await sleep(300);
  const paused = q2.items.find((i) => i.id === pid);
  check('pauza — stav položky', paused.status, 'paused');
  truthy('pauza — něco už se stáhlo', paused.transferred > 0);
  q2.resume();
  await new Promise((resolve) => {
    const onUpd = () => {
      const it = q2.items.find((i) => i.id === pid);
      if (['done', 'error'].includes(it.status)) { q2.off('update', onUpd); resolve(); }
    };
    q2.on('update', onUpd);
    onUpd();
  });
  check('pauza — po pokračování stav', q2.items.find((i) => i.id === pid).status, 'done');
  check('pauza — obsah shodný', (await fsp.readFile(pausePath)).equals(hugePayload), true);

  // ------------------------------------------------------------- rename/rm
  await adapter.rename('/www/index.php', '/www/index2.php');
  truthy('přejmenování', fs.existsSync(path.join(serverRoot, 'www', 'index2.php')));
  await adapter.removeFile('/www/index2.php');
  check('smazání souboru', fs.existsSync(path.join(serverRoot, 'www', 'index2.php')), false);

  await adapter.chmod('/www/big.bin', 0o640);
  check('chmod', (await adapter.stat('/www/big.bin')).mode & 0o777, 0o640);

  // ----------------------------------------------------------- porovnání
  const syncLocal = path.join(tmp, 'sync-local');
  await fsp.mkdir(path.join(syncLocal, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(syncLocal, 'a.txt'), 'aaa');
  await fsp.writeFile(path.join(syncLocal, 'sub', 'b.txt'), 'bbb');
  await fsp.writeFile(path.join(syncLocal, 'shodny.txt'), 'stejne');

  await adapter.mkdir('/sync', true);
  await fsp.writeFile(path.join(serverRoot, 'sync', 'shodny.txt'), 'stejne');
  await fsp.writeFile(path.join(serverRoot, 'sync', 'jen-na-serveru.txt'), 'xyz');
  // Ať mají "shodny.txt" stejný čas, jinak by porovnání podle času hlásilo rozdíl.
  const t = new Date();
  await fsp.utimes(path.join(syncLocal, 'shodny.txt'), t, t);
  await fsp.utimes(path.join(serverRoot, 'sync', 'shodny.txt'), t, t);

  const up = await compare(adapter, syncLocal, '/sync', { direction: 'toRemote', criteria: 'timeSize' });
  const upActions = up.actions.map((a) => `${a.action}:${a.rel}`).sort();
  check('sync → server', upActions, ['mkdirRemote:sub', 'upload:a.txt', 'upload:sub/b.txt']);

  const upDel = await compare(adapter, syncLocal, '/sync', { direction: 'toRemote', deleteExtra: true });
  truthy('sync → server s mazáním najde přebytek',
    upDel.actions.some((a) => a.action === 'deleteRemote' && a.rel === 'jen-na-serveru.txt'));

  const down = await compare(adapter, syncLocal, '/sync', { direction: 'toLocal' });
  check('sync ← server', down.actions.map((a) => `${a.action}:${a.rel}`).sort(), ['download:jen-na-serveru.txt']);

  const both = await compare(adapter, syncLocal, '/sync', { direction: 'both' });
  check('sync obousměrně', both.actions.map((a) => `${a.action}:${a.rel}`).sort(),
    ['download:jen-na-serveru.txt', 'mkdirRemote:sub', 'upload:a.txt', 'upload:sub/b.txt']);

  // ------------------------------------------------------ aplikace synchronizace
  const q3 = new TransferQueue({ getAdapter: async () => adapter });
  q3.setTempName(false);
  for (const a of up.actions.filter((x) => x.action === 'mkdirRemote')) await adapter.mkdir(a.remotePath, true);
  for (const a of up.actions.filter((x) => x.action === 'upload')) {
    await q3.addAndWait({ direction: 'up', localPath: a.localPath, remotePath: a.remotePath });
  }
  check('po synchronizaci a.txt', fs.readFileSync(path.join(serverRoot, 'sync', 'a.txt'), 'utf8'), 'aaa');
  check('po synchronizaci sub/b.txt', fs.readFileSync(path.join(serverRoot, 'sync', 'sub', 'b.txt'), 'utf8'), 'bbb');

  const after = await compare(adapter, syncLocal, '/sync', { direction: 'toRemote', criteria: 'size' });
  check('po synchronizaci už není co nahrát', after.actions.length, 0);

  // Zachování času je to, co dělá synchronizaci použitelnou opakovaně —
  // bez něj by druhé porovnání nahlásilo všechny soubory znovu jako změněné.
  const localMtime = (await fsp.stat(path.join(syncLocal, 'a.txt'))).mtimeMs;
  const remoteMtime = (await adapter.stat('/sync/a.txt')).mtime;
  truthy('čas změny přenesen na server (±1 s)', Math.abs(localMtime - remoteMtime) < 1000);

  const afterTime = await compare(adapter, syncLocal, '/sync', { direction: 'toRemote', criteria: 'timeSize' });
  check('opakované porovnání podle času je prázdné', afterTime.actions.length, 0);

  // A totéž pro opačný směr.
  const dlDir = path.join(tmp, 'mtime-down');
  await fsp.mkdir(dlDir, { recursive: true });
  const q4 = new TransferQueue({ getAdapter: async () => adapter });
  q4.setTempName(false);
  await q4.addAndWait({ direction: 'down', remotePath: '/sync/a.txt', localPath: path.join(dlDir, 'a.txt') });
  const backMtime = (await fsp.stat(path.join(dlDir, 'a.txt'))).mtimeMs;
  truthy('čas změny přenesen při stahování (±1 s)', Math.abs(backMtime - remoteMtime) < 1000);

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});

/** Počká, až položka fronty doběhne (ať už úspěchem nebo ne). */
function waitFor(queue, id) {
  return new Promise((resolve) => {
    const onUpd = () => {
      const it = queue.items.find((i) => i.id === id);
      if (!it || ['pending', 'active', 'paused'].includes(it.status)) return;
      queue.off('update', onUpd);
      resolve(it);
    };
    queue.on('update', onUpd);
    onUpd();
  });
}
