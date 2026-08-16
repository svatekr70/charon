'use strict';

/**
 * Hlídání složky s automatickým nahráváním.
 *
 * U automatiky je stejně důležité, na co reaguje, jako na co nereaguje.
 * Testy proto hlídají obojí — hlavně to, že se bez výslovného zapnutí nikdy
 * nic nesmaže a že se rozepsané soubory nenahrávají zpátky dokola.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue, TEMP_SUFFIX } = require('../src/main/queue');
const { FolderWatcher } = require('../src/main/watcher');

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

/** Počká, až podmínka platí — hlídání je ze své podstaby asynchronní. */
async function until(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(80);
  }
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-watch-'));
  const serverRoot = path.join(tmp, 'server');
  const localDir = path.join(tmp, 'projekt');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  await fsp.mkdir(path.join(localDir, 'src'), { recursive: true });
  await fsp.mkdir(path.join(localDir, '.git'), { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const srv = (...p) => path.join(serverRoot, 'www', ...p);
  const exists = (...p) => fs.existsSync(srv(...p));
  const queue = new TransferQueue({ getAdapter: async () => adapter });

  const removed = [];
  const watcher = new FolderWatcher({
    queue,
    getAdapter: async () => adapter,
    removeRemote: async (p) => { removed.push(p); await adapter.removeFile(p).catch(() => {}); },
  });

  check('na začátku nic neběží', watcher.running, false);

  // ------------------------------------------ úvodní srovnání
  await fsp.writeFile(path.join(localDir, 'index.php'), 'v1');
  await fsp.writeFile(path.join(localDir, 'src', 'app.php'), 'app v1');
  await fsp.writeFile(path.join(localDir, '.git', 'HEAD'), 'ref');
  await fsp.writeFile(path.join(localDir, 'poznamky.log'), 'smeti');

  await watcher.start({
    localDir,
    remoteDir: '/www',
    mask: '| .git/; *.log',
    initialSync: true,
  });
  check('hlídání běží', watcher.running, true);

  truthy('úvodní srovnání nahrálo, co bylo', await until(() => exists('index.php') && exists('src', 'app.php')));
  check('vyloučená složka se nenahrála', exists('.git'), false);
  check('vyloučený soubor taky ne', exists('poznamky.log'), false);
  check('obsah sedí', await fsp.readFile(srv('index.php'), 'utf8'), 'v1');

  // ------------------------------------------ reakce na změnu
  await fsp.writeFile(path.join(localDir, 'index.php'), 'v2 po uložení');
  truthy('změna se nahraje sama',
    await until(async () => (await fsp.readFile(srv('index.php'), 'utf8').catch(() => '')) === 'v2 po uložení'));

  // ------------------------------------------ nový soubor a složka
  await fsp.mkdir(path.join(localDir, 'nova'), { recursive: true });
  await fsp.writeFile(path.join(localDir, 'nova', 'styl.css'), 'body{}');
  truthy('nový soubor v nové složce se nahraje', await until(() => exists('nova', 'styl.css')));

  // ------------------------------------------ maska platí i za běhu
  await fsp.writeFile(path.join(localDir, 'ladeni.log'), 'nema jit nahoru');
  await fsp.writeFile(path.join(localDir, 'kotva.txt'), 'ma jit nahoru');
  truthy('nevyloučený soubor projde', await until(() => exists('kotva.txt')));
  check('vyloučený neprojde ani za běhu', exists('ladeni.log'), false);

  await fsp.writeFile(path.join(localDir, '.git', 'COMMIT_EDITMSG'), 'zprava');
  await sleep(900);
  check('do vyloučené složky se nesahá', exists('.git'), false);

  // -------------------------- rozepsané soubory se nenahrávají zpátky
  // Stahování si do hlídané složky odkládá .filepart. Kdyby na něj hlídání
  // reagovalo, vznikl by kolotoč: stáhni, nahraj, stáhni…
  await fsp.writeFile(path.join(localDir, `stahovany.bin${TEMP_SUFFIX}`), 'rozepsano');
  await sleep(900);
  check('rozepsaný soubor se nenahrává', exists(`stahovany.bin${TEMP_SUFFIX}`), false);

  // ------------------------------------------ bez svolení se nemaže
  check('cíl mazání zatím existuje', exists('kotva.txt'), true);
  await fsp.unlink(path.join(localDir, 'kotva.txt'));
  await sleep(900);
  check('smazání lokálně server nezmění', exists('kotva.txt'), true);
  check('a nic se nemazalo', removed.length, 0);

  const stats = watcher.status();
  truthy('statistika počítá nahrané', stats.uploaded >= 4, `${stats.uploaded}`);
  check('a žádné chyby', stats.errors, 0);

  await watcher.stop();
  check('po zastavení neběží', watcher.running, false);

  await fsp.writeFile(path.join(localDir, 'po-zastaveni.txt'), 'nic');
  await sleep(900);
  check('po zastavení se už nereaguje', exists('po-zastaveni.txt'), false);

  // ------------------------------------------ mazání se zapnutou volbou
  await watcher.start({ localDir, remoteDir: '/www', mask: '| .git/; *.log', deleteRemote: true });
  await fsp.writeFile(path.join(localDir, 'kratkodoby.txt'), 'chvilka');
  truthy('soubor se nahraje', await until(() => exists('kratkodoby.txt')));

  await fsp.unlink(path.join(localDir, 'kratkodoby.txt'));
  truthy('se zapnutou volbou se smaže i na serveru', await until(() => !exists('kratkodoby.txt')));
  check('a šlo to přes zadanou cestu', removed.includes('/www/kratkodoby.txt'), true);

  // Vyloučené soubory se nemažou ani se zapnutou volbou.
  await fsp.writeFile(srv('cizi.log'), 'na serveru odjinud');
  await fsp.writeFile(path.join(localDir, 'cizi.log'), 'lokalni');
  await sleep(400);
  await fsp.unlink(path.join(localDir, 'cizi.log'));
  await sleep(900);
  check('vyloučený soubor se nesmaže', exists('cizi.log'), true);

  await watcher.stop();

  // ------------------------------------------ dvakrát spustit nejde
  await watcher.start({ localDir, remoteDir: '/www' });
  let twice = null;
  try { await watcher.start({ localDir, remoteDir: '/www' }); } catch (e) { twice = e; }
  truthy('druhé spuštění se odmítne', twice && /už běží/.test(twice.message));
  await watcher.stop();

  let missing = null;
  try { await watcher.start({ localDir: path.join(tmp, 'neexistuje'), remoteDir: '/www' }); } catch (e) { missing = e; }
  truthy('neexistující složka se ohlásí', missing && /neexistuje/.test(missing.message));
  check('a hlídání nezůstane spuštěné', watcher.running, false);

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
