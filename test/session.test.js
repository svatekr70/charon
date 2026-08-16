'use strict';

/** Správce relací — pořadí záložek, přepínání a úklid při zavření. */

const { Session, SessionManager } = require('../src/main/session');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const truthy = (label, v) => check(label, Boolean(v), true);

/** Náhrada relace — správce potřebuje jen id, describe() a close(). */
function fake(id, closed) {
  return {
    id,
    describe: () => ({ id, name: `relace ${id}` }),
    close: async () => { closed.push(id); },
  };
}

async function main() {
  const closed = [];
  const m = new SessionManager();

  check('na začátku není nic', m.list(), []);
  check('ani aktivní', m.activeId, null);

  m.add(fake('a', closed));
  m.add(fake('b', closed));
  m.add(fake('c', closed));
  check('pořadí odpovídá otevírání', m.list().map((s) => s.id), ['a', 'b', 'c']);
  check('poslední otevřená je vpředu', m.activeId, 'c');
  check('a je tak označená', m.list().filter((s) => s.active).map((s) => s.id), ['c']);

  m.setActive('a');
  check('přepnutí dopředu', m.activeId, 'a');
  m.setActive('neexistuje');
  check('na neznámou se nepřepne', m.activeId, 'a');

  // Zavření záložky vzadu nesmí přehodit tu vpředu.
  await m.remove('b');
  check('zavřená zmizí z pořadí', m.list().map((s) => s.id), ['a', 'c']);
  check('vpředu zůstává původní', m.activeId, 'a');
  check('a zavřela se', closed, ['b']);

  // Zavření té vpředu přepne na jinou.
  await m.remove('a');
  check('po zavření přední se přepne', m.activeId, 'c');
  check('zbývá jedna', m.list().map((s) => s.id), ['c']);

  let missing = null;
  try { m.get('a'); } catch (e) { missing = e; }
  truthy('sáhnutí na zavřenou relaci se ohlásí', missing && /už není otevřená/.test(missing.message));
  check('has() o ní neví', m.has('a'), false);
  check('o otevřené ví', m.has('c'), true);

  await m.remove('c');
  check('bez relací není aktivní žádná', m.activeId, null);
  check('a seznam je prázdný', m.list(), []);

  // Zavření všeho najednou.
  const closed2 = [];
  const m2 = new SessionManager();
  m2.add(fake('x', closed2));
  m2.add(fake('y', closed2));
  await m2.closeAll();
  check('closeAll zavře všechny', closed2.sort(), ['x', 'y']);
  check('a vyprázdní seznam', m2.list(), []);
  check('i aktivní', m2.activeId, null);

  await m.remove('neexistuje'); // nesmí spadnout
  check('zavření neznámé nespadne', true, true);

  // ================= fronta z minula se nesmí přepsat dřív, než se zeptáme
  // Relace při otevření vždycky ohlásí prázdnou frontu. Kdyby se ukládala
  // rovnou, smazala by přesně to, na co se okno teprve chystá zeptat.
  const zapsano = [];
  const session = new Session({
    id: 'q1',
    config: { protocol: 'sftp', host: 'h', port: 22, username: 'u', name: 'Relace' },
    siteId: 'site-q',
    deps: {
      openAdapter: async () => ({}),
      send: () => {},
      log: () => {},
      settings: () => ({}),
      askConflict: async () => ({ action: 'skip' }),
      askEditOverwrite: async () => ({ action: 'skip' }),
      rememberQueue: (key, items) => zapsano.push({ key, pocet: items.length }),
    },
  });

  session.queue.add([{ direction: 'up', localPath: '/a', remotePath: '/b', size: 1 }]);
  check('před rozhodnutím se nic neukládá', zapsano.length, 0);

  session.queueAdopted = true;
  session.queue.add([{ direction: 'up', localPath: '/c', remotePath: '/d', size: 1 }]);
  truthy('po rozhodnutí už ano', zapsano.length > 0);
  check('a ukládá se pod klíčem relace', zapsano[zapsano.length - 1].key, 'site-q');

  // ============ dokončený přenos zahodí uložené výpisy
  // Nahraný soubor mění obsah složky. Kdyby paměť zůstala, panel by ho po
  // obnovení neukázal a člověk by nahrával podruhé.
  session.listCache.set('/www', [{ name: 'index.php', type: 'f' }]);
  check('výpis je uložený', Boolean(session.listCache.get('/www')), true);

  const [idPrenosu] = session.queue.add([{ direction: 'up', localPath: '/x', remotePath: '/www/x', size: 1 }]);
  check('samotné zařazení paměť neruší', Boolean(session.listCache.get('/www')), true);

  const polozka = session.queue.items.find((i) => i.id === idPrenosu);
  polozka.status = 'done';
  session.queue._emitUpdate(true);
  check('dokončený přenos ji zahodí', session.listCache.get('/www'), null);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
