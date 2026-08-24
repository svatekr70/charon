'use strict';

/**
 * End-to-end test FTP větve proti dočasnému FTP serveru (ftp-srv).
 * Ověřuje výpis, přenosy oběma směry, navázání přes REST/APPE a to, že
 * chybějící podpora MFMT na serveru nezpůsobí selhání přenosu.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const { FtpSrv } = require('ftp-srv');
const { FtpAdapter, parseListDate } = require('../src/main/adapters/ftp');
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

/** Vrátí volný TCP port — ftp-srv potřebuje port znát dopředu kvůli PASV. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ftpcli-ftp-'));
  const serverRoot = path.join(tmp, 'server');
  const localRoot = path.join(tmp, 'local');
  await fsp.mkdir(path.join(serverRoot, 'www', 'assets'), { recursive: true });
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'www', 'index.html'), '<h1>Ahoj</h1>');

  const port = await freePort();
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    anonymous: false,
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === 'test' && password === 'test') resolve({ root: serverRoot });
    else reject(new Error('Špatné přihlašovací údaje'));
  });
  await server.listen();
  console.log(`Testovací FTP server na portu ${port}, kořen ${serverRoot}\n`);

  const adapter = new FtpAdapter();
  await adapter.connect({ host: '127.0.0.1', port, username: 'test', password: 'test', ftps: 'none' });
  truthy('připojení k FTP', adapter.connected);

  // --------------------------------------------------------------- výpis
  const entries = await adapter.list('/www');
  check('výpis adresáře', entries.map((e) => `${e.type}:${e.name}`).sort(), ['d:assets', 'f:index.html']);
  check('velikost souboru', entries.find((e) => e.name === 'index.html').size, 13);
  const idx = entries.find((e) => e.name === 'index.html');
  truthy('výpis obsahuje čas změny', idx.mtime > 0);
  check('čas z textového výpisu je označen jako nepřesný', idx.mtimePrecise, false);

  // MDTM čas upřesní na sekundu a v UTC — tohle si vyžádá synchronizace.
  await adapter.refineMtimes('/www', entries);
  const refined = entries.find((e) => e.name === 'index.html');
  truthy('MDTM upřesnil čas', refined.mtimePrecise === true);
  const realMtime = (await fsp.stat(path.join(serverRoot, 'www', 'index.html'))).mtimeMs;
  truthy('upřesněný čas odpovídá skutečnosti (±2 s)', Math.abs(refined.mtime - realMtime) < 2000);

  // -------------------------------------------------------------- přenosy
  const payload = crypto.randomBytes(1536 * 1024); // 1,5 MB
  const bigLocal = path.join(localRoot, 'big.bin');
  await fsp.writeFile(bigLocal, payload);

  const queue = new TransferQueue({ getAdapter: async () => adapter });
  // Navázání přes REST/APPE se testuje na cílovém souboru; dočasný název
  // má vlastní test.
  queue.setTempName(false);

  await queue.addAndWait({ direction: 'up', localPath: bigLocal, remotePath: '/www/big.bin' });
  const uploaded = await fsp.readFile(path.join(serverRoot, 'www', 'big.bin'));
  check('upload — obsah shodný', uploaded.equals(payload), true);

  // Server neumí MFMT; přenos to nesmí shodit, jen se nepřenese čas změny.
  check('upload prošel i bez podpory MFMT', queue.items.at(-1).status, 'done');

  const dlPath = path.join(localRoot, 'stazeny.bin');
  await queue.addAndWait({ direction: 'down', remotePath: '/www/big.bin', localPath: dlPath });
  check('download — obsah shodný', (await fsp.readFile(dlPath)).equals(payload), true);

  // ------------------------------------------------ navázání (REST / APPE)
  const resumeDown = path.join(localRoot, 'resume-down.bin');
  const half = Math.floor(payload.length / 2);
  await fsp.writeFile(resumeDown, payload.subarray(0, half));
  queue.pause();
  const [didDown] = queue.add([{ direction: 'down', remotePath: '/www/big.bin', localPath: resumeDown }]);
  queue.items.find((i) => i.id === didDown).transferred = half;
  queue.resume();
  await waitFor(queue, didDown);
  check('navázání stahování — obsah shodný', (await fsp.readFile(resumeDown)).equals(payload), true);

  await fsp.writeFile(path.join(serverRoot, 'www', 'resume-up.bin'), payload.subarray(0, half));
  queue.pause();
  const [didUp] = queue.add([{ direction: 'up', localPath: bigLocal, remotePath: '/www/resume-up.bin' }]);
  queue.items.find((i) => i.id === didUp).transferred = half;
  queue.resume();
  await waitFor(queue, didUp);
  check('navázání nahrávání — obsah shodný',
    (await fsp.readFile(path.join(serverRoot, 'www', 'resume-up.bin'))).equals(payload), true);

  // ------------------------------------------------------ mkdir/rename/rm
  await adapter.mkdir('/www/nova/hloubeji');
  truthy('vytvoření vnořené složky', fs.existsSync(path.join(serverRoot, 'www', 'nova', 'hloubeji')));
  await adapter.rename('/www/index.html', '/www/index2.html');
  truthy('přejmenování', fs.existsSync(path.join(serverRoot, 'www', 'index2.html')));
  await adapter.removeFile('/www/index2.html');
  check('smazání souboru', fs.existsSync(path.join(serverRoot, 'www', 'index2.html')), false);

  // ------------------------------------------------------ nový prázdný soubor
  await adapter.createFile('/www/novy.txt');
  check('soubor vznikl', fs.existsSync(path.join(serverRoot, 'www', 'novy.txt')), true);
  check('a je prázdný', (await fsp.stat(path.join(serverRoot, 'www', 'novy.txt'))).size, 0);
  check('ve výpisu je jako soubor',
    (await adapter.list('/www')).find((e) => e.name === 'novy.txt').type, 'f');

  // FTP `STOR` přepisuje bez ptaní, proto se existence hlídá předem.
  await fsp.writeFile(path.join(serverRoot, 'www', 'obsazeno.txt'), 'důležitý obsah');
  let obsazeno = null;
  try { await adapter.createFile('/www/obsazeno.txt'); } catch (e) { obsazeno = e; }
  truthy('na obsazený název se soubor nezaloží', obsazeno && /už je/.test(obsazeno.message));
  check('a původní obsah zůstal',
    await fsp.readFile(path.join(serverRoot, 'www', 'obsazeno.txt'), 'utf8'), 'důležitý obsah');

  // ------------------------------------------------------------ porovnání
  const syncLocal = path.join(tmp, 'sync-local');
  await fsp.mkdir(path.join(syncLocal, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(syncLocal, 'a.txt'), 'aaa');
  await fsp.writeFile(path.join(syncLocal, 'sub', 'b.txt'), 'bbb');
  await fsp.mkdir(path.join(serverRoot, 'sync'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'sync', 'jen-server.txt'), 'xyz');

  const cmp = await compare(adapter, syncLocal, '/sync', { direction: 'toRemote' });
  check('sync → server', cmp.actions.map((a) => `${a.action}:${a.rel}`).sort(),
    ['mkdirRemote:sub', 'upload:a.txt', 'upload:sub/b.txt']);
  check('tolerance času pro FTP je minutová', cmp.toleranceMs, 61000);

  // Provedeme, co porovnání navrhlo, a ověříme, že podruhé už nic nezbyde.
  for (const a of cmp.actions.filter((x) => x.action === 'mkdirRemote')) await adapter.mkdir(a.remotePath);
  for (const a of cmp.actions.filter((x) => x.action === 'upload')) {
    await queue.addAndWait({ direction: 'up', localPath: a.localPath, remotePath: a.remotePath });
  }
  const again = await compare(adapter, syncLocal, '/sync', { direction: 'toRemote', criteria: 'size' });
  check('opakované porovnání podle velikosti je prázdné', again.actions.length, 0);

  // --------------------------------------------------- parsování dat výpisu
  const y = new Date().getFullYear();
  check('datum s rokem', parseListDate('Aug 16 2025'), new Date(2025, 7, 16).getTime());
  check('datum bez roku', parseListDate('Mar 3 14:06'), new Date(y, 2, 3, 14, 6).getTime());
  check('tvar MS-DOS', parseListDate('08-16-25  02:06PM'), new Date(2025, 7, 16, 14, 6).getTime());
  check('tvar MS-DOS dopoledne', parseListDate('01-02-99  12:30AM'), new Date(1999, 0, 2, 0, 30).getTime());
  check('nesmysl', parseListDate('---'), null);
  check('prázdno', parseListDate(''), null);
  // Prosincové datum bez roku načtené v lednu patří do loňska, ne do budoucna.
  truthy('datum bez roku nikdy nevyjde do budoucna', parseListDate('Dec 31 23:59') <= Date.now() + 86400000);

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

function waitFor(queue, id) {
  return new Promise((resolve, reject) => {
    const onUpd = () => {
      const it = queue.items.find((i) => i.id === id);
      if (!it || ['pending', 'active', 'paused'].includes(it.status)) return;
      queue.off('update', onUpd);
      if (it.status === 'done') resolve(it);
      else reject(new Error(it.error || `stav ${it.status}`));
    };
    queue.on('update', onUpd);
    onUpd();
  });
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});
