'use strict';

/**
 * Co si relace pamatuje mezi spuštěními.
 *
 * Nastavení synchronizace se naklikává pořád stejné, takže se ukládá k relaci.
 * Podstatné je, že ho nesmí smazat úprava relace — kdo si opraví heslo, nechce
 * přijít o to, že synchronizuje jedním směrem s maskou.
 *
 * Hesla se v testu nezadávají schválně: SiteStore je šifruje klíčem z Keychainu
 * a test nemá co sahat na klíčenku.
 */

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { SiteStore } = require('../src/main/sites');

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

const PROFIL = { direction: 'up', criteria: 'time', mask: '*.php | .git/', deleteExtra: true };

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-site-'));
  const store = new SiteStore(dir);
  await store.load();

  const id = await store.upsert({
    name: 'Web', protocol: 'sftp', host: 'example.test', port: 22, username: 'u',
  });
  check('nová relace žádné nastavení nemá', store.list()[0].sync, null);

  await store.setSync(id, PROFIL);
  check('uložený profil se vrátí ze seznamu', store.list()[0].sync, PROFIL);

  // ============ úprava relace o profil nesmí připravit
  await store.upsert({ id, name: 'Web ostrý', protocol: 'sftp', host: 'example.test', port: 22, username: 'u' });
  check('úprava relace profil zachová', store.list()[0].sync, PROFIL);
  check('a jméno se změnilo', store.list()[0].name, 'Web ostrý');

  // ============ přežije restart
  const znovu = new SiteStore(dir);
  await znovu.load();
  check('po znovunačtení je profil na místě', znovu.list()[0].sync, PROFIL);

  // ============ profily se nemíchají mezi relacemi
  const druha = await znovu.upsert({ name: 'Jiná', protocol: 'ftp', host: 'jina.test', port: 21, username: 'x' });
  check('druhá relace svůj profil nemá', znovu.list().find((s) => s.id === druha).sync, null);
  await znovu.setSync(druha, { direction: 'down', criteria: 'size', mask: '', deleteExtra: false });
  check('a první zůstává beze změny', znovu.list().find((s) => s.id === id).sync, PROFIL);

  // ============ jen očekávaná pole, a jen v očekávaném tvaru
  await znovu.setSync(id, { direction: 'up', criteria: 'time', mask: '*.css', deleteExtra: 'ano', cosiNavic: 'x' });
  check('cizí pole se neuloží', Object.keys(znovu.list().find((s) => s.id === id).sync).sort(),
    ['criteria', 'deleteExtra', 'direction', 'mask']);
  check('a zaškrtnutí je pravdivostní hodnota',
    znovu.list().find((s) => s.id === id).sync.deleteExtra, true);

  // ============ heslo ven jen na vyžádání a jen to jedno pole
  // Šifrování drží klíč z Keychainu, takže se tu neověřuje obsah, ale co
  // metoda vůbec pustí ven: cizí pole nesmí projít ani omylem.
  let chyba = null;
  try { await znovu.reveal(id, 'username'); } catch (e) { chyba = e; }
  truthy('jiné než heslo se rozšifrovat nedá', chyba && /není heslo/.test(chyba.message));
  chyba = null;
  try { await znovu.reveal(id, 'hostKeyFingerprint'); } catch (e) { chyba = e; }
  truthy('ani otisk klíče', chyba && /není heslo/.test(chyba.message));
  chyba = null;
  try { await znovu.reveal('neexistuje', 'password'); } catch (e) { chyba = e; }
  truthy('u neznámé relace se ozve', chyba && /neexistuje/.test(chyba.message));
  check('relace bez hesla vrátí prázdno', await znovu.reveal(id, 'password'), '');
  check('a seznam hesla dál neposílá',
    Object.keys(znovu.list()[0]).filter((k) => /password|passphrase/i.test(k)).sort(),
    ['hasPassphrase', 'hasPassword', 'hasProxyPassword', 'hasTunnelPassword']);

  // ============ zapomenutí
  await znovu.setSync(id, null);
  check('profil jde zahodit', znovu.list().find((s) => s.id === id).sync, null);
  await znovu.setSync('neexistuje', PROFIL); // nesmí spadnout
  check('neznámá relace nespadne', znovu.list().length, 2);

  await fsp.rm(dir, { recursive: true, force: true });
  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
