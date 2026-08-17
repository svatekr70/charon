'use strict';

/**
 * Masky při přenosech a synchronizaci.
 *
 * Klíčové chování: na složky se uplatní jen výluky. Kdyby platilo i zahrnutí,
 * maska `*.php` by zakázala vstup do podsložek a rekurzivní přenos by nenašel
 * nic. Druhá věc, kterou testy hlídají, je počítání vynechaných položek —
 * bez něj by tiché vynechání vypadalo, jako by se přeneslo všechno.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { compare, walkLocal, walkRemote } = require('../src/main/sync');
const { expandLocal, expandRemote } = require('../src/main/browse');
const FileMask = require('../src/common/mask');
const { hostKeyPath } = require('./fixtures');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/** Strom typického webu i s tím, co na server nepatří. */
async function buildTree(root) {
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules', 'balik'), { recursive: true });
  await fsp.writeFile(path.join(root, 'index.php'), 'a');
  await fsp.writeFile(path.join(root, 'style.css'), 'b');
  await fsp.writeFile(path.join(root, 'poznamky.txt'), 'c');
  await fsp.writeFile(path.join(root, '.DS_Store'), 'd');
  await fsp.writeFile(path.join(root, 'src', 'app.php'), 'e');
  await fsp.writeFile(path.join(root, 'src', 'app.php.bak'), 'f');
  await fsp.writeFile(path.join(root, '.git', 'HEAD'), 'g');
  await fsp.writeFile(path.join(root, '.git', 'objects', 'x'), 'h');
  await fsp.writeFile(path.join(root, 'node_modules', 'balik', 'index.js'), 'i');
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-mask-'));

  // ------------------------------------------- složky řídí jen výluky
  const m = FileMask.compile('*.php | .git/; node_modules/');
  check('soubor podle zahrnutí', m.matchFile('index.php'), true);
  check('soubor mimo zahrnutí', m.matchFile('style.css'), false);
  check('do běžné složky se smí', m.allowDir('src'), true);
  check('do vyloučené složky ne', m.allowDir('.git'), false);
  check('a do druhé taky ne', m.allowDir('node_modules'), false);
  // Tohle je ta past: složka „src" zahrnutí `*.php` nesplňuje, přesto se do ní musí.
  check('zahrnutí nesmí zakázat vstup do složky', m.allowDir('src'), true);

  const onlyExclude = FileMask.compile('| *.bak; .DS_Store');
  check('samotná výluka pustí ostatní', onlyExclude.matchFile('index.php'), true);
  check('samotná výluka zahodí svoje', onlyExclude.matchFile('app.php.bak'), false);
  check('samotná výluka nechá složky být', onlyExclude.allowDir('cokoliv'), true);

  // ------------------------------------- porovnání adresářů s maskou
  const localRoot = path.join(tmp, 'local');
  const serverRoot = path.join(tmp, 'server');
  await buildTree(localRoot);
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const rels = (res) => res.actions.filter((a) => a.action === 'upload').map((a) => a.rel).sort();

  const all = await compare(adapter, localRoot, '/www', { direction: 'toRemote' });
  check('bez masky se přenáší všechno', rels(all), [
    '.DS_Store', '.git/HEAD', '.git/objects/x', 'index.php',
    'node_modules/balik/index.js', 'poznamky.txt', 'src/app.php', 'src/app.php.bak', 'style.css',
  ]);
  check('bez masky se nic nevynechává', all.skipped, 0);

  const clean = await compare(adapter, localRoot, '/www', {
    direction: 'toRemote', mask: '| .DS_Store; .git/; node_modules/',
  });
  check('výluky vyhodí smetí', rels(clean),
    ['index.php', 'poznamky.txt', 'src/app.php', 'src/app.php.bak', 'style.css']);
  check('a spočítají se', clean.skipped, 3); // .DS_Store + dvě složky

  const onlyPhp = await compare(adapter, localRoot, '/www', {
    direction: 'toRemote', mask: '*.php | .git/; node_modules/',
  });
  check('zahrnutí projde i do podsložek', rels(onlyPhp), ['index.php', 'src/app.php']);

  // Maska musí platit na obě strany. Kdyby ne, soubor vyloučený vlevo by se
  // vpravo tvářil jako přebytek k smazání.
  await fsp.writeFile(path.join(serverRoot, 'www', 'server.bak'), 'x');
  const bothSides = await compare(adapter, localRoot, '/www', {
    direction: 'toRemote', deleteExtra: true, mask: '| *.bak; .git/; node_modules/; .DS_Store',
  });
  check('vyloučený soubor na serveru se nemaže',
    bothSides.actions.filter((a) => a.action === 'deleteRemote').map((a) => a.rel), []);

  // ------------------------------------------------ procházení s maskou
  const maskDirs = FileMask.compile('| .git/; node_modules/');
  const stats = { skipped: 0 };
  const walked = await walkLocal(localRoot, { mask: maskDirs, stats });
  check('procházení do vyloučených složek nevstoupí',
    [...walked.keys()].filter((k) => k.startsWith('.git') || k.startsWith('node_modules')), []);
  check('procházení hlásí vynechané', stats.skipped, 2);

  await fsp.mkdir(path.join(serverRoot, 'www', '.git'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'www', '.git', 'HEAD'), 'x');
  const rstats = { skipped: 0 };
  const rwalked = await walkRemote(adapter, '/www', { mask: maskDirs, stats: rstats });
  check('totéž na serveru', [...rwalked.keys()].filter((k) => k.startsWith('.git')), []);
  check('a taky se hlásí', rstats.skipped, 1);

  // ------------------------------- rozbalení stromu k přenosu s maskou
  const junk = FileMask.compile('| .DS_Store; .git/; node_modules/');

  const upAll = await expandLocal(localRoot, '/cil');
  check('bez masky se rozbalí celý strom',
    upAll.filter((j) => j.direction === 'up').length, 9);

  const upStats = { skipped: 0 };
  const up = await expandLocal(localRoot, '/cil', [], junk, upStats);
  check('výluky ze stromu vypadnou',
    up.filter((j) => j.direction === 'up').map((j) => path.relative(localRoot, j.localPath)).sort(),
    ['index.php', 'poznamky.txt', 'src/app.php', 'src/app.php.bak', 'style.css']);

  // Tohle je ta oprava: vyloučená složka se nesmí přenést ani tehdy, když ji
  // uživatel označí ručně a je tedy kořenem přenosu.
  const rootStats = { skipped: 0 };
  const rootPick = await expandLocal(path.join(localRoot, 'node_modules'), '/cil/node_modules', [], junk, rootStats);
  check('vyloučená složka neprojde ani jako kořen výběru', rootPick.length, 0);
  check('a započítá se jako vynechaná', rootStats.skipped, 1);

  const rootFileStats = { skipped: 0 };
  const rootFile = await expandLocal(path.join(localRoot, '.DS_Store'), '/cil/.DS_Store', [], junk, rootFileStats);
  check('vyloučený soubor neprojde ani jako kořen', rootFile.length, 0);
  check('a taky se započítá', rootFileStats.skipped, 1);

  const allowed = await expandLocal(path.join(localRoot, 'src'), '/cil/src', [], junk, { skipped: 0 });
  check('povolená složka jako kořen projde',
    allowed.map((j) => path.basename(j.localPath)).sort(), ['app.php', 'app.php.bak']);

  // Prázdná složka se musí na serveru založit zvlášť, žádný soubor to neudělá.
  await fsp.mkdir(path.join(localRoot, 'prazdna'), { recursive: true });
  const withEmpty = await expandLocal(path.join(localRoot, 'prazdna'), '/cil/prazdna');
  check('prázdná složka se založí', withEmpty.map((j) => j.direction), ['mkdirRemote']);

  // ------------------------------------------- rozbalení směrem od serveru
  const downStats = { skipped: 0 };
  const down = await expandRemote(adapter, '/www', path.join(tmp, 'stazeno'), [], junk, downStats);
  check('stahování vynechá vyloučené složky',
    down.some((j) => j.remotePath.includes('/.git/')), false);
  check('a soubory projdou', down.length > 0, true);

  const downRoot = { skipped: 0 };
  const downPick = await expandRemote(adapter, '/www/.git', path.join(tmp, 'x'), [], junk, downRoot);
  check('vyloučená složka na serveru neprojde ani jako kořen', downPick.length, 0);
  check('a započítá se', downRoot.skipped, 1);

  // ------------------------------------------------- prázdná maska
  // Porovnáváme proti čerstvému běhu bez masky, ne proti tomu úplně prvnímu —
  // na serveru mezitím přibyly soubory a základ by neseděl.
  const baseline = await compare(adapter, localRoot, '/www', { direction: 'toRemote' });
  const empty = await compare(adapter, localRoot, '/www', { direction: 'toRemote', mask: '   ' });
  check('samé mezery se berou jako bez masky', rels(empty), rels(baseline));
  check('a nic nevynechají', empty.skipped, 0);

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
