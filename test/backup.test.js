'use strict';

/**
 * Záloha souboru před přepsáním.
 *
 * Koš na serveru řeší mazání, tohle přepis — a ten se na rozdíl od mazání děje
 * bez ptaní pokaždé, když se nahrává novější verze. Testuje se proti
 * skutečnému serveru, protože jediné, co se počítá, je jestli původní obsah
 * někde zůstal.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
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

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-bak-'));
  const serverRoot = path.join(tmp, 'server');
  const www = path.join(serverRoot, 'www');
  await fsp.mkdir(www, { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const zdroj = path.join(tmp, 'index.php');
  await fsp.writeFile(zdroj, 'nová verze');

  const nahraj = async (queue, jmeno = 'index.php') => {
    queue.add([{
      direction: 'up', localPath: zdroj, remotePath: `/www/${jmeno}`, size: 11, conflictResolved: true,
    }]);
    const konec = Date.now() + 10000;
    while (Date.now() < konec) {
      const items = queue.snapshot().items;
      if (items.length && items.every((i) => ['done', 'error', 'skipped'].includes(i.status))) {
        return items[items.length - 1];
      }
      await sleep(60);
    }
    throw new Error('přenos nedojel');
  };

  // Zálohu si sestavíme stejně jako Session — bez celé aplikace.
  const zaloha = async (a, remotePath, mode) => {
    if (!await a.exists(remotePath)) return null;
    if (mode === 'trash') {
      const kam = `/www/.kos/${path.posix.basename(remotePath)}`;
      await a.mkdir('/www/.kos', true).catch(() => {});
      await a.rename(remotePath, kam);
      return kam;
    }
    const kam = `${remotePath}.bak-test`;
    await a.rename(remotePath, kam);
    return kam;
  };

  // ============================ bez zálohy se prostě přepíše
  await fsp.writeFile(path.join(www, 'index.php'), 'stará verze');
  const q1 = new TransferQueue({ getAdapter: async () => adapter });
  q1.setTempName(false);
  await nahraj(q1);
  check('bez zálohy se přepíše', await fsp.readFile(path.join(www, 'index.php'), 'utf8'), 'nová verze');
  check('a nic vedle nevznikne', (await fsp.readdir(www)).length, 1);

  // ============================ se zálohou zůstane původní verze
  await fsp.writeFile(path.join(www, 'index.php'), 'stará verze');
  const q2 = new TransferQueue({ getAdapter: async () => adapter });
  q2.setTempName(false);
  q2.setBackup('suffix', zaloha);
  const it2 = await nahraj(q2);
  check('nová verze je na místě', await fsp.readFile(path.join(www, 'index.php'), 'utf8'), 'nová verze');
  check('a stará zůstala vedle', await fsp.readFile(path.join(www, 'index.php.bak-test'), 'utf8'), 'stará verze');
  truthy('u položky je poznámka, kam se uložila', /původní verze uložena/.test(it2.note || ''), it2.note);

  // ============================ nový soubor zálohovat nemá co
  const q3 = new TransferQueue({ getAdapter: async () => adapter });
  q3.setTempName(false);
  q3.setBackup('suffix', zaloha);
  const it3 = await nahraj(q3, 'novy.php');
  check('u nového souboru se nezálohuje', fs.existsSync(path.join(www, 'novy.php.bak-test')), false);
  check('a nic se nehlásí', it3.note, null);

  // ============================ záloha funguje i s dočasným názvem
  await fsp.writeFile(path.join(www, 'docasny.php'), 'stará verze');
  const q4 = new TransferQueue({ getAdapter: async () => adapter });
  q4.setTempName(true, 0);
  q4.setBackup('suffix', zaloha);
  await nahraj(q4, 'docasny.php');
  check('i s dočasným názvem je nová verze na místě',
    await fsp.readFile(path.join(www, 'docasny.php'), 'utf8'), 'nová verze');
  check('a stará vedle', await fsp.readFile(path.join(www, 'docasny.php.bak-test'), 'utf8'), 'stará verze');
  check('rozepsaný soubor po sobě nezůstal',
    (await fsp.readdir(www)).filter((f) => f.endsWith('.filepart')).length, 0);

  // ============================ selhání zálohy přenos nezastaví
  await fsp.writeFile(path.join(www, 'potiz.php'), 'stará verze');
  const q5 = new TransferQueue({ getAdapter: async () => adapter });
  q5.setTempName(false);
  q5.setBackup('suffix', async () => { throw new Error('server odmítl'); });
  const it5 = await nahraj(q5, 'potiz.php');
  check('přenos proběhne i tak', it5.status, 'done');
  truthy('ale řekne se, že záloha nevyšla', /zálohu původní verze/.test(it5.note || ''), it5.note);

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
