'use strict';

/**
 * Detekce cizí změny při ukládání z editoru.
 *
 * Automatické nahrání po uložení je pohodlné právě proto, že se neptá.
 * Tím spolehlivěji by ale mlčky zahodilo práci někoho jiného, kdyby do
 * souboru mezitím sáhl. Testy hlídají, že se v takovém případě zeptá —
 * a že v běžném případě neotravuje.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const { EditWatcher } = require('../src/main/editor-watch');

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
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-ec-'));
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const remote = path.join(serverRoot, 'www', 'index.php');
  await fsp.writeFile(remote, 'puvodni obsah');

  const queue = new TransferQueue({ getAdapter: async () => adapter });
  const asked = [];
  let answer = { action: 'skip' };

  const watcher = new EditWatcher({
    queue,
    connectionKey: () => 'test',
    getAdapter: async () => adapter,
    askOverwrite: async (info) => { asked.push(info); return answer; },
  });
  // open() by spustil skutečný editor, takže sledovanou položku připravíme
  // rovnou — zajímá nás jen to, co se děje kolem uložení.
  const localCopy = path.join(tmp, 'index.php');
  await fsp.writeFile(localCopy, 'puvodni obsah');
  const known = await watcher._remoteState('/www/index.php');
  truthy('stav souboru na serveru se přečte', known && known.size === 13, JSON.stringify(known));

  const entry = {
    remotePath: '/www/index.php',
    localPath: localCopy,
    uploads: 0,
    lastUpload: null,
    status: 'watching',
    busy: false,
    known,
  };
  watcher.watched.set(entry.remotePath, entry);

  // ============================== 1. nikdo nesáhl → nahraje se bez ptaní
  await fsp.writeFile(localCopy, 'moje zmena');
  await watcher._upload(entry);
  check('beze změny na serveru se neptá', asked.length, 0);
  check('a soubor se nahraje', await fsp.readFile(remote, 'utf8'), 'moje zmena');
  check('počítadlo nahrání', entry.uploads, 1);

  // ================== 2. někdo jiný soubor změnil → zeptá se a nepřepíše
  await sleep(1100); // ať se čas prokazatelně liší
  await fsp.writeFile(remote, 'cizi zmena od kolegy');
  await fsp.writeFile(localCopy, 'moje dalsi zmena');

  answer = { action: 'skip' };
  await watcher._upload(entry);
  check('cizí změna vyvolá dotaz', asked.length, 1);
  check('odmítnutí nechá server být', await fsp.readFile(remote, 'utf8'), 'cizi zmena od kolegy');
  check('a nahrání se nezapočítá', entry.uploads, 1);
  truthy('dotaz nese oba stavy',
    asked[0].known && asked[0].current && asked[0].known.size !== asked[0].current.size);

  // ======================= 3. vědomé potvrzení přepíše
  answer = { action: 'overwrite' };
  await watcher._upload(entry);
  check('po potvrzení se přepíše', await fsp.readFile(remote, 'utf8'), 'moje dalsi zmena');
  check('a zeptalo se právě jednou navíc', asked.length, 2);

  // ============ 4. po vlastním nahrání se stav srovná a znovu se neptá
  await fsp.writeFile(localCopy, 'treti zmena');
  await watcher._upload(entry);
  check('po vlastním nahrání se už neptá', asked.length, 2);
  check('a soubor je aktuální', await fsp.readFile(remote, 'utf8'), 'treti zmena');

  // ===================== 5. bez možnosti zjistit stav se neblokuje
  // Server, který nezná čas ani velikost, nesmí ukládání znemožnit.
  const blind = new EditWatcher({ queue, connectionKey: () => 'x' });
  check('bez spojení se změna nepozná', blind._changed(null, { size: 1 }), false);
  check('ani když chybí ta druhá strana', blind._changed({ size: 1 }, null), false);
  check('rozdíl ve velikosti je změna', blind._changed({ size: 1 }, { size: 2 }), true);
  check('rozdíl v čase taky', blind._changed({ size: 1, mtime: 1000 }, { size: 1, mtime: 5000 }), true);
  check('vteřinová odchylka ne', blind._changed({ size: 1, mtime: 1000 }, { size: 1, mtime: 1500 }), false);
  check('bez času se řídí velikostí', blind._changed({ size: 1 }, { size: 1 }), false);

  await watcher.stopAll();
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
