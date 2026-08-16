'use strict';

/**
 * Testy tří pojistek proti ztrátě dat a proti podvrženému serveru:
 * ověřování host key, dotaz při přepisu souboru a vzdálený koš.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { TransferQueue } = require('../src/main/queue');
const { RemoteTrash, dayFolder } = require('../src/main/trash');
const hostkeys = require('../src/main/hostkeys');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const truthy = (label, v) => check(label, Boolean(v), true);

const FIXTURES = path.join(__dirname, 'fixtures');
const HOST_KEY = path.join(FIXTURES, 'host_key');

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ftpcli-safety-'));

  // ================================================== 1. otisky a known_hosts

  // Zlatý standard: otisk musí sedět s tím, co spočítá ssh-keygen.
  const expected = execFileSync('ssh-keygen', ['-lf', `${HOST_KEY}.pub`], { encoding: 'utf8' })
    .trim().split(/\s+/)[1];
  const pubLine = fs.readFileSync(`${HOST_KEY}.pub`, 'utf8').trim().split(/\s+/);
  const rawKey = Buffer.from(pubLine[1], 'base64');

  check('otisk souhlasí se ssh-keygen', hostkeys.fingerprint(rawKey), expected);
  check('typ klíče', hostkeys.keyType(rawKey), 'ssh-ed25519');
  check('kanonický host, výchozí port', hostkeys.canonicalHost('a.cz', 22), 'a.cz');
  check('kanonický host, jiný port', hostkeys.canonicalHost('a.cz', 2222), '[a.cz]:2222');

  // known_hosts: běžný, portový, zahashovaný a odvolaný záznam
  const khDir = path.join(tmp, 'ssh');
  await fsp.mkdir(khDir, { recursive: true });
  const kh = path.join(khDir, 'known_hosts');
  const b64 = pubLine[1];

  const salt = Buffer.from('0123456789abcdef0123', 'utf8').toString('base64');
  const crypto = require('crypto');
  const hashOf = (name) => crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');

  await fsp.writeFile(kh, [
    `# komentář`,
    `plain.example.com ssh-ed25519 ${b64}`,
    `[port.example.com]:2222 ssh-ed25519 ${b64}`,
    `|1|${salt}|${hashOf('hashed.example.com')} ssh-ed25519 ${b64}`,
    `@revoked bad.example.com ssh-ed25519 ${b64}`,
    `*.wild.example.com ssh-ed25519 ${b64}`,
  ].join('\n'));

  const look = (h, p) => hostkeys.lookupKnownHosts(h, p, [kh]);
  check('known_hosts — běžný záznam', look('plain.example.com', 22).fingerprints, [expected]);
  check('known_hosts — jiný port', look('port.example.com', 2222).fingerprints, [expected]);
  check('known_hosts — port se musí shodovat', look('port.example.com', 22).fingerprints, []);
  check('known_hosts — zahashovaný záznam', look('hashed.example.com', 22).fingerprints, [expected]);
  check('known_hosts — zástupný znak', look('a.wild.example.com', 22).fingerprints, [expected]);
  check('known_hosts — odvolaný klíč', look('bad.example.com', 22).revoked, [expected]);
  check('known_hosts — neznámý host', look('jiny.example.com', 22).fingerprints, []);

  const cls = (host, stored) => hostkeys.classify(rawKey, { host, port: 22, storedFingerprint: stored }).verdict;
  check('verdikt — uložený otisk sedí', cls('kdekoliv', expected), 'trusted');
  check('verdikt — uložený otisk nesedí', cls('kdekoliv', 'SHA256:jiny'), 'mismatch');
  check('verdikt — neznámý server', cls('nikde.example.com', null), 'unknown');

  // ============================================ 2. odmítnutí klíče při spojení

  const serverRoot = path.join(tmp, 'server');
  await fsp.mkdir(path.join(serverRoot, 'www'), { recursive: true });
  const server = await startTestServer({ root: serverRoot, hostKeyPath: HOST_KEY });
  const cfg = { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' };

  // Bez hooku se nesmí připojit vůbec — to je ta původní díra.
  const naked = new SftpAdapter();
  let nakedErr = null;
  try { await naked.connect(cfg); } catch (e) { nakedErr = e; }
  await naked.disconnect().catch(() => {});
  truthy('bez ověření se spojení neotevře', nakedErr && nakedErr.hostKeyRejected);
  check('spojení zůstalo zavřené', naked.connected, false);

  // Odmítnutí uživatelem
  const rejected = new SftpAdapter();
  let rejErr = null;
  try {
    await rejected.connect(cfg, { verifyHostKey: () => false });
  } catch (e) { rejErr = e; }
  await rejected.disconnect().catch(() => {});
  truthy('odmítnutý klíč hlásí srozumitelnou chybu', rejErr && rejErr.hostKeyRejected);

  // Klíč, který dostaneme ze serveru, musí mít stejný otisk jako fixture
  let seenFingerprint = null;
  const accepted = new SftpAdapter();
  await accepted.connect(cfg, {
    verifyHostKey: ({ keyBuffer }) => {
      seenFingerprint = hostkeys.fingerprint(keyBuffer);
      return true;
    },
  });
  truthy('po potvrzení se spojení otevře', accepted.connected);
  check('otisk ze serveru odpovídá fixture', seenFingerprint, expected);

  // ==================================================== 3. dotaz při přepisu

  const localRoot = path.join(tmp, 'local');
  await fsp.mkdir(localRoot, { recursive: true });
  const src = path.join(localRoot, 'soubor.txt');
  await fsp.writeFile(src, 'novy obsah ze zdroje');

  const remoteFile = '/www/soubor.txt';
  const writeRemote = (text) => fsp.writeFile(path.join(serverRoot, 'www', 'soubor.txt'), text);
  const readRemote = () => fsp.readFile(path.join(serverRoot, 'www', 'soubor.txt'), 'utf8');

  let asked = 0;
  let answer = { action: 'skip' };
  const q = new TransferQueue({
    getAdapter: async () => accepted,
    onConflict: async () => { asked += 1; return answer; },
  });

  // -- přeskočit
  await writeRemote('puvodni');
  answer = { action: 'skip' };
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: remoteFile }).catch(() => {});
  check('přeskočení nechá cíl beze změny', await readRemote(), 'puvodni');
  check('na konflikt se aplikace zeptala', asked, 1);
  check('položka má stav skipped', q.items.at(-1).status, 'skipped');

  // -- přepsat
  answer = { action: 'overwrite' };
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: remoteFile });
  check('přepsání zapíše nový obsah', await readRemote(), 'novy obsah ze zdroje');

  // -- přejmenovat
  await writeRemote('puvodni');
  answer = { action: 'rename' };
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: remoteFile });
  check('původní soubor zůstal', await readRemote(), 'puvodni');
  check('vznikla kopie s pořadovým číslem',
    fs.readFileSync(path.join(serverRoot, 'www', 'soubor (2).txt'), 'utf8'), 'novy obsah ze zdroje');

  // -- jen novější: cíl je novější, takže se nemá přenášet
  await writeRemote('puvodni');
  const future = new Date(Date.now() + 3600_000);
  await fsp.utimes(path.join(serverRoot, 'www', 'soubor.txt'), future, future);
  answer = { action: 'newer' };
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: remoteFile }).catch(() => {});
  check('„jen novější" starší zdroj nepřenese', await readRemote(), 'puvodni');

  // -- jen novější: zdroj je novější
  const past = new Date(Date.now() - 3600_000);
  await fsp.utimes(path.join(serverRoot, 'www', 'soubor.txt'), past, past);
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: remoteFile });
  check('„jen novější" novější zdroj přenese', await readRemote(), 'novy obsah ze zdroje');

  // -- navázání
  const big = Buffer.concat([Buffer.alloc(5000, 65), Buffer.alloc(5000, 66)]);
  const bigLocal = path.join(localRoot, 'big.bin');
  await fsp.writeFile(bigLocal, big);
  await fsp.writeFile(path.join(serverRoot, 'www', 'big.bin'), big.subarray(0, 5000));
  answer = { action: 'resume' };
  await q.addAndWait({ direction: 'up', localPath: bigLocal, remotePath: '/www/big.bin' });
  check('navázání doplní zbytek souboru',
    (await fsp.readFile(path.join(serverRoot, 'www', 'big.bin'))).equals(big), true);

  // -- „použít na všechny" se ptá jen jednou
  await writeRemote('puvodni');
  await fsp.writeFile(path.join(localRoot, 'druhy.txt'), 'druhy');
  await fsp.writeFile(path.join(serverRoot, 'www', 'druhy.txt'), 'puvodni druhy');
  asked = 0;
  answer = { action: 'overwrite', applyToAll: true };
  const ids = q.add([
    { direction: 'up', localPath: src, remotePath: remoteFile },
    { direction: 'up', localPath: path.join(localRoot, 'druhy.txt'), remotePath: '/www/druhy.txt' },
  ]);
  await waitAll(q, ids);
  check('„použít na všechny" se zeptá jen jednou', asked, 1);
  check('druhý soubor se přesto přepsal', await fsp.readFile(path.join(serverRoot, 'www', 'druhy.txt'), 'utf8'), 'druhy');
  check('politika se po vyprázdnění fronty zapomene', q.policy, null);

  // -- předrozhodnuté přenosy (synchronizace, editor) se neptají
  await writeRemote('puvodni');
  asked = 0;
  answer = { action: 'skip' };
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: remoteFile, conflictResolved: true });
  check('conflictResolved se neptá', asked, 0);
  check('conflictResolved přepíše', await readRemote(), 'novy obsah ze zdroje');

  // -- když cíl neexistuje, není se na co ptát
  asked = 0;
  await q.addAndWait({ direction: 'up', localPath: src, remotePath: '/www/uplne-novy.txt' });
  check('nový soubor konflikt nevyvolá', asked, 0);

  // ============================================= 4. přesun (přenos + smazání)

  const movedSources = [];
  const qm = new TransferQueue({
    getAdapter: async () => accepted,
    onMoveSource: async (item) => { movedSources.push(item.localPath || item.remotePath); },
  });

  const movable = path.join(localRoot, 'presun.txt');
  await fsp.writeFile(movable, 'obsah k presunu');
  await qm.addAndWait({ direction: 'up', localPath: movable, remotePath: '/www/presun.txt', moveFrom: 'local' });
  check('přesun — soubor dorazil', fs.readFileSync(path.join(serverRoot, 'www', 'presun.txt'), 'utf8'), 'obsah k presunu');
  check('přesun — zdroj se smazal', movedSources, [movable]);
  check('přesun — položka je označená', qm.items.at(-1).note, 'přesunuto');

  // Nejdůležitější vlastnost: když přenos selže, zdroj musí zůstat.
  movedSources.length = 0;
  await qm.addAndWait({
    direction: 'up', localPath: path.join(localRoot, 'neexistuje.txt'),
    remotePath: '/www/nikdy.txt', moveFrom: 'local',
  }).catch(() => {});
  check('přesun — po chybě zůstává zdroj', movedSources, []);
  check('přesun — položka je v chybě', qm.items.at(-1).status, 'error');

  // A když se nepodaří smazat zdroj, přenos zůstává úspěšný — soubor je
  // přenesený, jen se to uživateli řekne.
  const qm2 = new TransferQueue({
    getAdapter: async () => accepted,
    onMoveSource: async () => { throw new Error('nemám práva'); },
  });
  await qm2.addAndWait({ direction: 'up', localPath: movable, remotePath: '/www/presun2.txt', moveFrom: 'local' });
  check('neúspěšné smazání nezruší přenos', qm2.items.at(-1).status, 'done');
  truthy('a je vidět proč', /nemám práva/.test(qm2.items.at(-1).note || ''));

  // Běžný přenos bez příznaku zdroj nikdy nemaže.
  movedSources.length = 0;
  await qm.addAndWait({ direction: 'up', localPath: movable, remotePath: '/www/kopie.txt' });
  check('bez příznaku se nemaže nic', movedSources, []);
  truthy('a soubor zůstal', fs.existsSync(movable));

  // ======================================================== 5. vzdálený koš

  const trash = new RemoteTrash(accepted, '/kos');
  check('výchozí cesta koše', RemoteTrash.defaultPath('/home/deploy'), '/home/deploy/.charon-trash');

  const now = new Date(2026, 7, 16, 12, 0, 0);
  const day = dayFolder(now);
  await fsp.writeFile(path.join(serverRoot, 'www', 'smazat.txt'), 'obsah');

  const moved = await trash.moveToTrash('/www/smazat.txt', now);
  check('cesta v koši zrcadlí původní', moved, `/kos/${day}/www/smazat.txt`);
  check('soubor zmizel z původního místa', fs.existsSync(path.join(serverRoot, 'www', 'smazat.txt')), false);
  check('obsah v koši je nedotčený',
    fs.readFileSync(path.join(serverRoot, 'kos', day, 'www', 'smazat.txt'), 'utf8'), 'obsah');

  // stejné jméno podruhé — nesmí přepsat to první
  await fsp.writeFile(path.join(serverRoot, 'www', 'smazat.txt'), 'druhy obsah');
  const moved2 = await trash.moveToTrash('/www/smazat.txt', now);
  check('kolize dostane pořadové číslo', moved2, `/kos/${day}/www/smazat-2.txt`);
  check('první verze v koši zůstala',
    fs.readFileSync(path.join(serverRoot, 'kos', day, 'www', 'smazat.txt'), 'utf8'), 'obsah');

  // celý adresář
  await fsp.mkdir(path.join(serverRoot, 'www', 'stara'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'www', 'stara', 'a.txt'), 'a');
  await trash.moveToTrash('/www/stara', now);
  check('do koše jde i adresář s obsahem',
    fs.readFileSync(path.join(serverRoot, 'kos', day, 'www', 'stara', 'a.txt'), 'utf8'), 'a');

  let selfErr = null;
  try { await trash.moveToTrash(`/kos/${day}/www/smazat.txt`, now); } catch (e) { selfErr = e; }
  truthy('položku z koše nelze mazat znovu do koše', selfErr);

  // úklid podle stáří
  await fsp.mkdir(path.join(serverRoot, 'kos', '2026-01-01'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'kos', '2026-01-01', 'stare.txt'), 'x');
  const removed = await trash.cleanup(30, now);
  check('úklid smaže starý den', removed, ['2026-01-01']);
  check('dnešní den zůstal', fs.existsSync(path.join(serverRoot, 'kos', day)), true);

  const days = await trash.listDays();
  check('výpis koše po dnech', days.map((d) => d.day), [day]);
  await trash.empty();
  check('vysypání koše', (await trash.listDays()).length, 0);

  await accepted.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

function waitAll(queue, ids) {
  return new Promise((resolve) => {
    const onUpd = () => {
      const done = ids.every((id) => {
        const it = queue.items.find((x) => x.id === id);
        return it && !['pending', 'active', 'paused'].includes(it.status);
      });
      if (!done) return;
      queue.off('update', onUpd);
      // Necháme doběhnout _loop, aby stihl zahodit politiku.
      setTimeout(resolve, 50);
    };
    queue.on('update', onUpd);
    onUpd();
  });
}

main().catch((err) => {
  console.error('Test selhal výjimkou:', err);
  process.exit(1);
});
