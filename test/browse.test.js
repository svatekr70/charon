'use strict';

/** Dopočítání velikosti složek a hledání souborů na serveru. */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { localDirSize, remoteDirSize, Finder } = require('../src/main/browse');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const truthy = (label, v) => check(label, Boolean(v), true);

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-browse-'));
  const root = path.join(tmp, 'server');

  // strom: /www/{index.php, .htaccess, assets/{a.css, b.css}, logs/{app.log, old/x.log}}
  await fsp.mkdir(path.join(root, 'www', 'assets'), { recursive: true });
  await fsp.mkdir(path.join(root, 'www', 'logs', 'old'), { recursive: true });
  await fsp.writeFile(path.join(root, 'www', 'index.php'), 'x'.repeat(100));
  await fsp.writeFile(path.join(root, 'www', '.htaccess'), 'y'.repeat(50));
  await fsp.writeFile(path.join(root, 'www', 'assets', 'a.css'), 'a'.repeat(200));
  await fsp.writeFile(path.join(root, 'www', 'assets', 'b.css'), 'b'.repeat(300));
  await fsp.writeFile(path.join(root, 'www', 'logs', 'app.log'), 'l'.repeat(1000));
  await fsp.writeFile(path.join(root, 'www', 'logs', 'old', 'x.log'), 'o'.repeat(400));

  // ------------------------------------------------ velikost lokální složky
  const local = await localDirSize(path.join(root, 'www'));
  check('lokálně — součet bajtů', local.bytes, 100 + 50 + 200 + 300 + 1000 + 400);
  check('lokálně — počet souborů', local.files, 6);
  check('lokálně — počet složek', local.dirs, 3);
  check('lokálně — jen podsložka', (await localDirSize(path.join(root, 'www', 'assets'))).bytes, 500);
  check('lokálně — neexistující cesta nespadne', (await localDirSize(path.join(tmp, 'nic'))).bytes, 0);

  // Symbolický odkaz na nadřazenou složku by bez ošetření znamenal smyčku.
  await fsp.symlink(path.join(root, 'www'), path.join(root, 'www', 'smycka'));
  const withLink = await localDirSize(path.join(root, 'www'));
  check('lokálně — odkaz nezpůsobí smyčku ani nezmění součet', withLink.bytes, local.bytes);
  await fsp.unlink(path.join(root, 'www', 'smycka'));

  // -------------------------------------------------- velikost na serveru
  const server = await startTestServer({ root, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const remote = await remoteDirSize(adapter, '/www');
  check('na serveru — součet bajtů', remote.bytes, local.bytes);
  check('na serveru — počet souborů', remote.files, 6);
  check('na serveru — počet složek', remote.dirs, 3);
  check('na serveru — prázdná složka', (await remoteDirSize(adapter, '/www/logs/old')).bytes, 400);
  check('na serveru — neexistující cesta nespadne', (await remoteDirSize(adapter, '/nikde')).bytes, 0);

  // ------------------------------------------------------------- hledání
  const findAll = async (mask, opts = {}) => {
    const f = new Finder();
    const res = await f.run(adapter, '/www', mask, opts);
    return { ...res, names: res.hits.map((h) => h.path).sort() };
  };

  check('hledání podle přípony', (await findAll('*.log')).names,
    ['/www/logs/app.log', '/www/logs/old/x.log']);
  check('hledání jde do hloubky', (await findAll('x.log')).names, ['/www/logs/old/x.log']);
  check('víc masek najednou', (await findAll('*.css; *.php')).names,
    ['/www/assets/a.css', '/www/assets/b.css', '/www/index.php']);
  check('výluka v masce', (await findAll('*.log | x.*')).names, ['/www/logs/app.log']);
  check('najde i tečkové soubory', (await findAll('.htaccess')).names, ['/www/.htaccess']);
  check('bez shody vrátí prázdno', (await findAll('*.zip')).names, []);

  // Složky se ve výsledcích neobjevují, dokud si o ně uživatel neřekne.
  check('složky se standardně nehledají', (await findAll('assets')).names, []);
  check('se zapnutou volbou se najdou', (await findAll('assets', { includeDirs: true })).names, ['/www/assets']);

  const detail = await findAll('app.log');
  check('nález nese velikost', detail.hits[0].size, 1000);
  check('nález nese nadřazenou složku', detail.hits[0].dir, '/www/logs');
  check('nález nese název', detail.hits[0].name, 'app.log');
  truthy('nález nese čas změny', detail.hits[0].mtime > 0);
  truthy('hlásí se počet prohledaných položek', detail.scanned >= 6);

  // -------------------------------------------------- průběžné hlášení
  const progress = [];
  const f2 = new Finder();
  await f2.run(adapter, '/www', '*', { onProgress: (m) => progress.push(m) });
  truthy('průběh se hlásí ještě před koncem', progress.some((m) => m.hit));
  check('hlášené nálezy odpovídají výsledku',
    progress.filter((m) => m.hit).length, (await findAll('*')).total);

  // -------------------------------------------------------------- zastavení
  const f3 = new Finder();
  const started = f3.run(adapter, '/www', '*', {
    onProgress: () => f3.cancel(), // zastavíme hned po prvním nálezu
  });
  const stopped = await started;
  check('zastavené hledání se označí', stopped.canceled, true);
  truthy('zastavení přijde dřív než celý výpis', stopped.total < 6);

  // ------------------------------------------------------------ omezení počtu
  const f4 = new Finder({ limit: 2 });
  const limited = await f4.run(adapter, '/www', '*');
  check('limit se dodrží', limited.total, 2);
  check('a je označený jako oříznutý', limited.truncated, true);

  // Dvě hledání zároveň by si přepisovala stav, proto se druhé odmítne.
  const f5 = new Finder();
  const first = f5.run(adapter, '/www', '*');
  let parallelErr = null;
  try { await f5.run(adapter, '/www', '*'); } catch (e) { parallelErr = e; }
  await first;
  truthy('souběžné hledání se odmítne', parallelErr);

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
