'use strict';

/**
 * Čtení ~/.ssh/config.
 *
 * Pravidla OpenSSH nejsou samozřejmá: platí **první** nalezená hodnota, ne
 * poslední, a `Host *` je proto výchozí nastavení, ne přepis. Kdyby se to
 * otočilo, importované relace by mlčky mířily jinam nebo pod jiným uživatelem
 * — a to je přesně ten druh chyby, který se pozná až po přihlášení na cizí
 * server.
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const ssh = require('../src/main/ssh-config');

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

const CONFIG = `
# komentář na začátku
Host web
    HostName example.test
    User rudolf
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host db
  hostname=db.example.test
  ProxyJump admin@brana.example.test:2022

Host stary
    HostName legacy.example.test
    User    root

Host *.interni
    User sluzba

Match user kdokoliv
    User tenhle-blok-neumime

Host *
    User zaloha
    Port 22
`;

async function main() {
  const blocks = ssh.parse(CONFIG);
  const sessions = ssh.toSessions(blocks, { defaultUser: 'nikdo' });
  const podle = (n) => sessions.find((s) => s.name === n);

  // ============================================ základní převod
  check('vzory se neimportují jako servery', sessions.map((s) => s.name), ['web', 'db', 'stary']);
  check('HostName, uživatel i port', [podle('web').host, podle('web').username, podle('web').port],
    ['example.test', 'rudolf', 2222]);
  check('klíč se rozbalí z vlnovky',
    podle('web').privateKeyPath.startsWith(os.homedir()) && podle('web').privateKeyPath.endsWith('id_ed25519'), true);
  check('protokol je SFTP', podle('web').protocol, 'sftp');

  // ============================================ pravidla OpenSSH
  check('„Host *" doplňuje jen to, co chybí', podle('db').username, 'zaloha');
  check('a nepřebíjí, co je uvedeno dřív', podle('stary').username, 'root');
  check('výchozí port se doplní', podle('db').port, 22);
  check('velikost písmen v klíčových slovech nevadí', podle('db').host, 'db.example.test');
  check('bez HostName se použije alias', ssh.toSessions(ssh.parse('Host samotny\n  User x'))[0].host, 'samotny');
  check('bloky Match se přeskočí', podle('web').username, 'rudolf');

  // ============================================ brána
  check('ProxyJump se přenese na bránu',
    [podle('db').tunnelHost, podle('db').tunnelPort, podle('db').tunnelUsername],
    ['brana.example.test', 2022, 'admin']);
  check('bez ProxyJump zůstane brána prázdná', podle('web').tunnelHost, '');
  check('jump bez uživatele a portu', ssh.parseJump('brana.test'), { username: '', host: 'brana.test', port: 22 });
  check('jump s uživatelem', ssh.parseJump('u@brana.test:2200'), { username: 'u', host: 'brana.test', port: 2200 });
  check('„none" znamená bez brány', ssh.parseJump('none'), null);
  check('z řetězu bran bereme první', ssh.parseJump('a@prvni:22,b@druha:22').host, 'prvni');

  // ============================================ poznámky pro dialog
  truthy('u klíče se to napíše', /klíč id_ed25519/.test(podle('web').note), podle('web').note);
  truthy('u brány taky', /přes bránu brana/.test(podle('db').note), podle('db').note);

  // ============================================ vzory
  check('hvězdička v aliasu', ssh.matches('*.interni', 'stroj.interni'), true);
  check('otazník je jeden znak', ssh.matches('web?', 'web1'), true);
  check('a jen jeden', ssh.matches('web?', 'web12'), false);
  check('tečka se nebere jako zástupný znak', ssh.matches('a.b', 'axb'), false);

  const negace = ssh.parse('Host * !tajny\n  User verejny\nHost tajny\n  HostName t.test');
  check('vykřičník alias vyloučí', ssh.toSessions(negace, { defaultUser: 'x' }).find((s) => s.name === 'tajny').username, 'x');

  // ============================================ nastavení před prvním Host
  const globalni = ssh.parse('User predem\nHost a\n  HostName a.test');
  check('nastavení nad prvním blokem platí globálně',
    ssh.toSessions(globalni, { defaultUser: 'x' })[0].username, 'predem');

  // ============================================ Include ze souborů
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-ssh-'));
  await fsp.mkdir(path.join(dir, 'conf.d'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'config'), 'Include conf.d/*.conf\nHost hlavni\n  HostName h.test\n');
  await fsp.writeFile(path.join(dir, 'conf.d', 'a.conf'), 'Host zvenku\n  HostName z.test\n  User pepa\n');
  await fsp.writeFile(path.join(dir, 'conf.d', 'ignorovat.txt'), 'Host neni\n  HostName x.test\n');

  const nactene = ssh.read(path.join(dir, 'config'), { defaultUser: 'x' });
  check('Include přinese další relace', nactene.sessions.map((s) => s.name).sort(), ['hlavni', 'zvenku']);
  check('a soubor mimo vzor se nebere', nactene.sessions.some((s) => s.name === 'neni'), false);
  check('údaje z připojeného souboru sedí',
    nactene.sessions.find((s) => s.name === 'zvenku').username, 'pepa');

  // Kruhový Include nesmí zacyklit.
  await fsp.writeFile(path.join(dir, 'kruh'), 'Include kruh\nHost x\n  HostName x.test\n');
  const kruh = ssh.read(path.join(dir, 'kruh'), { defaultUser: 'x' });
  check('kruhový Include nezacyklí', kruh.sessions.map((s) => s.name), ['x']);

  // ============================================ chybějící soubor
  const nic = ssh.read(path.join(dir, 'neexistuje'), { defaultUser: 'x' });
  check('chybějící soubor je prostě prázdný', nic.sessions, []);

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
