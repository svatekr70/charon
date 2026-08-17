'use strict';

/**
 * Přenos přes dočasný název.
 *
 * Podstatné není, že se soubor nakonec jmenuje správně — to by šlo poznat
 * i bez dočasného jména. Podstatné je, že cílový soubor zůstane až do konce
 * přenosu nedotčený, takže na živém webu nikdo netrefí půlku.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue, TEMP_SUFFIX } = require('../src/main/queue');
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

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-temp-'));
  const serverRoot = path.join(tmp, 'server');
  const localRoot = path.join(tmp, 'local');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  await fsp.mkdir(localRoot, { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const srvPath = (...p) => path.join(serverRoot, 'www', ...p);
  const q = new TransferQueue({ getAdapter: async () => adapter });
  // Přenos schválně zpomalíme. Přes loopback by 1,5 MB proletělo dřív, než
  // fronta stihne jedno hlášení průběhu, a okamžik „uprostřed přenosu" —
  // který je v tomhle testu to hlavní — by nešlo zachytit.
  q.setSpeedLimit(512 * 1024);

  check('přípona odpovídá WinSCP', TEMP_SUFFIX, '.filepart');

  // ================================================ 1. nahrávání
  const small = path.join(localRoot, 'index.php');
  await fsp.writeFile(small, '<?php nova verze;');
  await fsp.writeFile(srvPath('index.php'), '<?php stara verze;');

  await q.addAndWait({ direction: 'up', localPath: small, remotePath: '/www/index.php', conflictResolved: true });
  check('po dokončení má soubor správný obsah', await fsp.readFile(srvPath('index.php'), 'utf8'), '<?php nova verze;');
  check('a dočasný soubor po sobě neuklizený nezůstal', fs.existsSync(srvPath(`index.php${TEMP_SUFFIX}`)), false);

  // -------- to hlavní: cíl je během přenosu pořád ten starý --------
  const big = path.join(localRoot, 'velky.bin');
  const payload = crypto.randomBytes(1536 * 1024); // 1,5 MB ≈ 3 s při limitu výše
  await fsp.writeFile(big, payload);
  await fsp.writeFile(srvPath('velky.bin'), 'PUVODNI OBSAH');

  const [bigId] = q.add([{
    direction: 'up', localPath: big, remotePath: '/www/velky.bin', conflictResolved: true,
  }]);

  // Počkáme, až přenos prokazatelně běží, a mrkneme na stav souborů.
  await new Promise((resolve) => {
    const onUpd = (s) => {
      const it = s.items.find((i) => i.id === bigId);
      if (it && it.status === 'active' && it.transferred > 200 * 1024) { q.off('update', onUpd); resolve(); }
    };
    q.on('update', onUpd);
  });

  const duringFinal = await fsp.readFile(srvPath('velky.bin'), 'utf8').catch(() => null);
  const duringTemp = await fsp.stat(srvPath(`velky.bin${TEMP_SUFFIX}`)).catch(() => null);
  check('během přenosu je cílový soubor pořád ten původní', duringFinal, 'PUVODNI OBSAH');
  truthy('a data tečou do dočasného souboru', duringTemp && duringTemp.size > 0,
    duringTemp ? `${duringTemp.size} B` : 'dočasný soubor nenalezen');

  await waitFor(q, bigId);
  check('po dokončení je na místě nový obsah',
    (await fsp.readFile(srvPath('velky.bin'))).equals(payload), true);
  check('dočasný soubor zmizel', fs.existsSync(srvPath(`velky.bin${TEMP_SUFFIX}`)), false);
  check('položka je hotová', q.items.find((i) => i.id === bigId).status, 'done');

  // ================================================ 2. stahování
  const dl = path.join(localRoot, 'stazeny.bin');
  await fsp.writeFile(dl, 'STARA LOKALNI VERZE');
  const [dlId] = q.add([{
    direction: 'down', remotePath: '/www/velky.bin', localPath: dl, conflictResolved: true,
  }]);
  await new Promise((resolve) => {
    const onUpd = (s) => {
      const it = s.items.find((i) => i.id === dlId);
      if (it && it.status === 'active' && it.transferred > 200 * 1024) { q.off('update', onUpd); resolve(); }
    };
    q.on('update', onUpd);
  });
  check('i lokálně zůstává původní soubor nedotčený',
    await fsp.readFile(dl, 'utf8').catch(() => null), 'STARA LOKALNI VERZE');
  truthy('a píše se vedle', fs.existsSync(`${dl}${TEMP_SUFFIX}`));

  await waitFor(q, dlId);
  check('po dokončení je stažený soubor celý', (await fsp.readFile(dl)).equals(payload), true);
  check('a dočasný zmizel', fs.existsSync(`${dl}${TEMP_SUFFIX}`), false);

  // ============================ 3. pauza nechá rozepsaný soubor k navázání
  const resumeSrc = path.join(localRoot, 'navazani.bin');
  await fsp.writeFile(resumeSrc, payload);
  const [rId] = q.add([{
    direction: 'up', localPath: resumeSrc, remotePath: '/www/navazani.bin', conflictResolved: true,
  }]);
  await new Promise((resolve) => {
    const onUpd = (s) => {
      const it = s.items.find((i) => i.id === rId);
      if (it && it.status === 'active' && it.transferred > 200 * 1024) { q.off('update', onUpd); resolve(); }
    };
    q.on('update', onUpd);
  });
  q.pause();
  await sleep(400);

  const partial = await fsp.stat(srvPath(`navazani.bin${TEMP_SUFFIX}`)).catch(() => null);
  truthy('po pauze rozepsaný soubor zůstává', partial && partial.size > 0,
    partial ? `${partial.size} B` : 'nenalezen');
  check('cíl pořád neexistuje', fs.existsSync(srvPath('navazani.bin')), false);

  q.resume();
  await waitFor(q, rId);
  check('po pokračování je soubor celý',
    (await fsp.readFile(srvPath('navazani.bin'))).equals(payload), true);
  check('a dočasný je pryč', fs.existsSync(srvPath(`navazani.bin${TEMP_SUFFIX}`)), false);

  // =================== 4. zrušení po sobě rozepsaný soubor uklidí
  const cancelSrc = path.join(localRoot, 'zruseny.bin');
  await fsp.writeFile(cancelSrc, payload);
  const [cId] = q.add([{
    direction: 'up', localPath: cancelSrc, remotePath: '/www/zruseny.bin', conflictResolved: true,
  }]);
  await new Promise((resolve) => {
    const onUpd = (s) => {
      const it = s.items.find((i) => i.id === cId);
      if (it && it.status === 'active' && it.transferred > 200 * 1024) { q.off('update', onUpd); resolve(); }
    };
    q.on('update', onUpd);
  });
  q.cancel(cId);
  await sleep(600);
  check('po zrušení nezůstane dočasný soubor', fs.existsSync(srvPath(`zruseny.bin${TEMP_SUFFIX}`)), false);
  check('ani cílový', fs.existsSync(srvPath('zruseny.bin')), false);

  // ============ 4b. dialog nabídne navázání na rozepsaný soubor
  // Rozepsaný soubor z dřívějška: cíl existuje jako starší celá verze,
  // vedle něj leží půlka nové. Dialog musí navázání nabídnout a použít
  // velikost té půlky, ne hotového souboru pod cílovým jménem.
  const half = payload.subarray(0, 700 * 1024);
  await fsp.writeFile(srvPath('navaz2.bin'), 'STARA CELA VERZE');
  await fsp.writeFile(srvPath(`navaz2.bin${TEMP_SUFFIX}`), half);

  const src2 = path.join(localRoot, 'navaz2.bin');
  await fsp.writeFile(src2, payload);

  let offered = null;
  const qAsk = new TransferQueue({
    getAdapter: async () => adapter,
    onConflict: async (info) => { offered = info; return { action: 'resume' }; },
  });
  await qAsk.addAndWait({ direction: 'up', localPath: src2, remotePath: '/www/navaz2.bin' });

  truthy('dialog navázání nabídl', offered && offered.canResume === true);
  check('a hlásil velikost cílového souboru', offered.target.size, 16);
  check('po navázání je soubor celý',
    (await fsp.readFile(srvPath('navaz2.bin'))).equals(payload), true);
  check('rozepsaný soubor je uklizený', fs.existsSync(srvPath(`navaz2.bin${TEMP_SUFFIX}`)), false);

  // Když rozepsaný soubor není, navázání se nabízet nemá — data by chyběla.
  await fsp.writeFile(srvPath('bezpul.bin'), 'STARA CELA VERZE');
  let offered2 = null;
  const qAsk2 = new TransferQueue({
    getAdapter: async () => adapter,
    onConflict: async (info) => { offered2 = info; return { action: 'overwrite' }; },
  });
  await qAsk2.addAndWait({ direction: 'up', localPath: src2, remotePath: '/www/bezpul.bin' });
  check('bez rozepsaného souboru se navázání nenabízí', offered2.canResume, false);
  check('a přepis proběhne celý',
    (await fsp.readFile(srvPath('bezpul.bin'))).equals(payload), true);

  // ============ 4c. „přejmenovat" musí měnit i cestu k zápisu
  // Kdyby se dočasný název skládal ještě před dotazem, zapsalo by se pod
  // původním jménem — tedy přesně do souboru, který měl zůstat nedotčený.
  await fsp.writeFile(srvPath('kolize.txt'), 'PUVODNI');
  await fsp.writeFile(path.join(localRoot, 'kolize.txt'), 'NOVY');
  const qRen = new TransferQueue({
    getAdapter: async () => adapter,
    onConflict: async () => ({ action: 'rename' }),
  });
  await qRen.addAndWait({
    direction: 'up', localPath: path.join(localRoot, 'kolize.txt'), remotePath: '/www/kolize.txt',
  });
  check('původní soubor zůstal nedotčený', await fsp.readFile(srvPath('kolize.txt'), 'utf8'), 'PUVODNI');
  check('nový vznikl vedle', await fsp.readFile(srvPath('kolize (2).txt'), 'utf8'), 'NOVY');
  check('a nezůstal po něm dočasný soubor',
    fs.existsSync(srvPath(`kolize (2).txt${TEMP_SUFFIX}`)) || fs.existsSync(srvPath(`kolize.txt${TEMP_SUFFIX}`)), false);

  // ================================== 5. vypnutá volba se chová po staru
  q.setSpeedLimit(0);
  const plain = new TransferQueue({ getAdapter: async () => adapter });
  plain.setTempName(false);
  const direct = path.join(localRoot, 'primo.txt');
  await fsp.writeFile(direct, 'primo na misto');
  await plain.addAndWait({ direction: 'up', localPath: direct, remotePath: '/www/primo.txt', conflictResolved: true });
  check('bez dočasného názvu se zapíše rovnou', await fsp.readFile(srvPath('primo.txt'), 'utf8'), 'primo na misto');
  check('a žádný dočasný nevznikne', fs.existsSync(srvPath(`primo.txt${TEMP_SUFFIX}`)), false);

  // ============================= 6. spodní hranice velikosti
  const byThreshold = new TransferQueue({ getAdapter: async () => adapter });
  byThreshold.setTempName(true, 1024 * 1024); // až od 1 MB
  check('malý soubor hranici nesplní', byThreshold._tempFor(500), null);
  check('velký ano', byThreshold._tempFor(5 * 1024 * 1024), TEMP_SUFFIX);
  check('bez hranice platí pro všechno', new TransferQueue({ getAdapter: async () => adapter })._tempFor(1), TEMP_SUFFIX);

  // ====================== 7. nahrazení cíle, i když už existuje
  await fsp.writeFile(srvPath('existuje.txt'), 'stary');
  await fsp.writeFile(path.join(localRoot, 'existuje.txt'), 'novy');
  await q.addAndWait({
    direction: 'up',
    localPath: path.join(localRoot, 'existuje.txt'),
    remotePath: '/www/existuje.txt',
    conflictResolved: true,
  });
  check('přejmenování přepíše existující cíl', await fsp.readFile(srvPath('existuje.txt'), 'utf8'), 'novy');

  // Přímé ověření, že replace() opravdu umí nahradit obsazené jméno.
  await fsp.writeFile(srvPath('a.txt'), 'zdroj');
  await fsp.writeFile(srvPath('b.txt'), 'cil');
  await adapter.replace('/www/a.txt', '/www/b.txt');
  check('replace nahradí obsah', await fsp.readFile(srvPath('b.txt'), 'utf8'), 'zdroj');
  check('a zdroj po něm nezůstane', fs.existsSync(srvPath('a.txt')), false);

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
