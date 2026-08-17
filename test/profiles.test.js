'use strict';

/**
 * Profily přenosu: volby platné jen pro jednu dávku.
 *
 * Podstatné je, že profil **nemění nastavení aplikace** — jinak by se
 * jednorázová odchylka („na tenhle server nahraj s právy 755") tiše stala
 * trvalou a projevila by se příště úplně jinde.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const FileMask = require('../src/common/mask');
const { hostKeyPath } = require('./fixtures');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prava = async (p) => ((await fsp.stat(p)).mode & 0o777).toString(8);
const konceRadku = async (p) => ((await fsp.readFile(p, 'utf8')).includes('\r\n') ? 'CRLF' : 'LF');

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-prof-'));
  const serverRoot = path.join(tmp, 'server');
  const www = path.join(serverRoot, 'www');
  await fsp.mkdir(www, { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: hostKeyPath() });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const zdroj = path.join(tmp, 'skript.sh');
  await fsp.writeFile(zdroj, '#!/bin/sh\necho ahoj\n');
  await fsp.chmod(zdroj, 0o600);

  const queue = new TransferQueue({ getAdapter: async () => adapter });
  queue.setTempName(false);
  // Nastavení aplikace: práva nechat na serveru, textový režim vypnutý.
  queue.setPermissions({ uploadPerms: 'keep' });
  queue.setTextMode('', 'lf');

  const nahraj = async (jmeno, extra = {}) => {
    queue.add([{
      direction: 'up', localPath: zdroj, remotePath: `/www/${jmeno}`, size: 20,
      conflictResolved: true, ...extra,
    }]);
    const konec = Date.now() + 10000;
    while (Date.now() < konec) {
      const items = queue.snapshot().items;
      const posledni = items[items.length - 1];
      if (posledni && ['done', 'error', 'skipped'].includes(posledni.status)) return posledni;
      await sleep(60);
    }
    throw new Error('přenos nedojel');
  };

  // ================================================ bez profilu platí nastavení
  await nahraj('bez-profilu.sh');
  check('bez profilu se práva neřeší', await prava(path.join(www, 'bez-profilu.sh')) === '600', false);
  check('a konce řádků zůstávají', await konceRadku(path.join(www, 'bez-profilu.sh')), 'LF');

  // ================================================ profil s právy a textovým režimem
  const profil = {
    perms: { uploadPerms: 'fixed', uploadFileMode: '755', uploadDirMode: '755' },
    text: { mask: FileMask.compile('*.sh'), eol: 'crlf' },
  };
  const it = await nahraj('s-profilem.sh', profil);
  check('profil nastavil práva', await prava(path.join(www, 's-profilem.sh')), '755');
  check('a převedl konce řádků', await konceRadku(path.join(www, 's-profilem.sh')), 'CRLF');
  check('přenos je hotový', it.status, 'done');

  // ================================================ profil je jednorázový
  await nahraj('potom.sh');
  check('další přenos už profil nedědí — práva',
    await prava(path.join(www, 'potom.sh')) === '755', false);
  check('ani konce řádků', await konceRadku(path.join(www, 'potom.sh')), 'LF');
  check('a nastavení fronty zůstalo nedotčené', queue.perms.uploadPerms, 'keep');
  check('textová maska taky', queue.textMask, null);

  // ================================================ profil s maskou, která nesedí
  const jinyProfil = {
    text: { mask: FileMask.compile('*.txt'), eol: 'crlf' },
  };
  await nahraj('nesedi.sh', jinyProfil);
  check('soubor mimo masku profilu se nepřevádí',
    await konceRadku(path.join(www, 'nesedi.sh')), 'LF');

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
