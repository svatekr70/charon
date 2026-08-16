'use strict';

/**
 * Práva nahraných souborů.
 *
 * Na sdíleném hostingu je to rozdíl mezi fungujícím webem a chybou 403.
 * Testuje se proti skutečnému serveru, protože jediné, co se počítá, jsou
 * práva souboru na druhé straně — ne to, že jsme zavolali chmod.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const perms = require('../src/main/perms');

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

/** Práva souboru osmičkově, jako je ukazuje panel. */
const mode = async (p) => ((await fsp.stat(p)).mode & 0o777).toString(8);

async function main() {
  // ================================================ rozbor zápisu práv
  check('prázdné pole znamená nesahat', perms.parseMode(''), null);
  check('mezery taky', perms.parseMode('   '), null);
  check('644 je 420 desítkově', perms.parseMode('644'), 0o644);
  check('čtyřmístný zápis projde', perms.parseMode('0755'), 0o755);
  check('nesmysl se nebere', perms.parseMode('9xx'), null);
  check('ani osmička, ta v osmičkové soustavě není', perms.parseMode('688'), null);
  check('undefined nespadne', perms.parseMode(undefined), null);

  // ================================================ která práva se použijí
  check('výchozí nastavení nechává práva být', perms.fileMode({}, 0o600), null);
  check('pevná práva se použijí', perms.fileMode({ uploadPerms: 'fixed', uploadFileMode: '644' }, 0o600), 0o644);
  check('zachování bere práva ze zdroje', perms.fileMode({ uploadPerms: 'preserve' }, 0o751), 0o751);
  check('zachování bez známých práv nic nedělá', perms.fileMode({ uploadPerms: 'preserve' }, null), null);
  check('u složek nemá co zachovávat, platí pevná',
    perms.dirMode({ uploadPerms: 'preserve', uploadDirMode: '755' }), 0o755);
  check('a bez zapnutí se složek netýká nic', perms.dirMode({ uploadDirMode: '755' }), null);
  check('setuid bit projde, když ho někdo chce', perms.fileMode({ uploadPerms: 'preserve' }, 0o4755), 0o4755);

  // ================================================ proti skutečnému serveru
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-perm-'));
  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const zdroj = path.join(tmp, 'stranka.php');
  await fsp.writeFile(zdroj, '<?php echo 1;');
  await fsp.chmod(zdroj, 0o600);   // typický soubor z editoru: jen pro majitele

  const nahraj = async (queue, jmeno) => {
    queue.add([{ direction: 'up', localPath: zdroj, remotePath: `/www/${jmeno}`, size: 13, conflictResolved: true }]);
    const konec = Date.now();
    while (Date.now() - konec < 15000) {
      const items = queue.snapshot().items;
      if (items.length && items.every((i) => ['done', 'error', 'skipped', 'canceled'].includes(i.status))) return items[items.length - 1];
      await sleep(80);
    }
    throw new Error('přenos nedoběhl');
  };

  // --- výchozí: práva necháváme na serveru
  const q1 = new TransferQueue({ getAdapter: async () => adapter });
  await nahraj(q1, 'vychozi.php');
  const vychozi = await mode(path.join(serverRoot, 'www', 'vychozi.php'));
  // Zdroj má 600. Kdyby se práva bez vyzvání přenášela, mělo by je i tady —
  // tohle je jediný způsob, jak poznat, že jsme na ně opravdu nesáhli.
  truthy('bez nastavení se práva nepřenášejí', vychozi !== '600', `server dal ${vychozi}`);

  // --- pevná práva
  const q2 = new TransferQueue({ getAdapter: async () => adapter });
  q2.setPermissions({ uploadPerms: 'fixed', uploadFileMode: '644', uploadDirMode: '755' });
  const it2 = await nahraj(q2, 'pevna.php');
  check('pevná práva se na serveru projeví', await mode(path.join(serverRoot, 'www', 'pevna.php')), '644');
  check('a přenos je hotový bez poznámky', [it2.status, it2.note], ['done', null]);

  // --- zachování lokálních práv
  const q3 = new TransferQueue({ getAdapter: async () => adapter });
  q3.setPermissions({ uploadPerms: 'preserve' });
  await nahraj(q3, 'zachovana.php');
  check('zachovaná práva sedí se zdrojem', await mode(path.join(serverRoot, 'www', 'zachovana.php')), '600');

  // --- práva se nastavují na konečné cestě, ne na .filepart
  const q4 = new TransferQueue({ getAdapter: async () => adapter });
  q4.setPermissions({ uploadPerms: 'fixed', uploadFileMode: '640' });
  q4.setTempName(true, 0);
  await nahraj(q4, 'docasny.php');
  check('i při přenosu přes dočasný název', await mode(path.join(serverRoot, 'www', 'docasny.php')), '640');
  check('a dočasný soubor po sobě nezůstal',
    fs.existsSync(path.join(serverRoot, 'www', 'docasny.php.filepart')), false);

  // --- server, který chmod neumí: přenos musí projít
  const hluchy = {
    ...adapter,
    upload: (...a) => adapter.upload(...a),
    stat: (...a) => adapter.stat(...a),
    mkdir: (...a) => adapter.mkdir(...a),
    utimes: (...a) => adapter.utimes(...a),
    replace: (...a) => adapter.replace(...a),
    exists: (...a) => adapter.exists(...a),
    chmod: async () => { throw new Error('SITE CHMOD not understood'); },
  };
  const q5 = new TransferQueue({ getAdapter: async () => hluchy });
  q5.setPermissions({ uploadPerms: 'fixed', uploadFileMode: '644' });
  q5.setTempName(false);
  const it5 = await nahraj(q5, 'bezchmod.php');
  check('když server chmod neumí, přenos přesto vyjde', it5.status, 'done');
  truthy('ale řekne se to u položky', /práva se nenastavila/.test(it5.note || ''), it5.note || '(bez poznámky)');
  check('a soubor na serveru je', fs.existsSync(path.join(serverRoot, 'www', 'bezchmod.php')), true);

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
