'use strict';

/**
 * Režimy synchronizace a konflikty.
 *
 * Synchronizace je nejnebezpečnější funkce v aplikaci: jedním kliknutím
 * přepíše práci na druhé straně. Testuje se proto hlavně to, co se přenést
 * **nesmí** — režim „jen novější" nesmí přepsat čerstvější soubor na cíli
 * a režim „jen srovnat časy" nesmí sáhnout na obsah.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { startTestServer } = require('./sftp-server');
const { SftpAdapter } = require('../src/main/adapters/sftp');
const { compare } = require('../src/main/sync');

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

/** Přehledný souhrn: co se má stát s kterým souborem. */
const shrn = (res) => res.actions
  .map((a) => `${a.rel}:${a.action}`)
  .sort();

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'charon-sm-'));
  const serverRoot = path.join(tmp, 'server');
  const localRoot = path.join(tmp, 'local');
  const www = path.join(serverRoot, 'www');
  await fsp.mkdir(www, { recursive: true });
  await fsp.mkdir(localRoot, { recursive: true });

  const server = await startTestServer({ root: serverRoot, hostKeyPath: path.join(__dirname, 'fixtures', 'host_key') });
  const adapter = new SftpAdapter();
  await adapter.connect(
    { host: '127.0.0.1', port: server.port, username: 'test', password: 'test' },
    { verifyHostKey: () => true },
  );

  const stary = new Date('2026-01-01T10:00:00Z');
  const novy = new Date('2026-06-01T10:00:00Z');

  const pisLokal = async (jmeno, obsah, cas) => {
    const p = path.join(localRoot, jmeno);
    await fsp.writeFile(p, obsah);
    await fsp.utimes(p, cas, cas);
  };
  const pisServer = async (jmeno, obsah, cas) => {
    const p = path.join(www, jmeno);
    await fsp.writeFile(p, obsah);
    await fsp.utimes(p, cas, cas);
  };

  // lokální novější, na serveru starší
  await pisLokal('lokalni-novejsi.txt', 'nová verze', novy);
  await pisServer('lokalni-novejsi.txt', 'stará', stary);
  // na serveru novější — tohle je ten soubor, o který jde
  await pisLokal('server-novejsi.txt', 'stará', stary);
  await pisServer('server-novejsi.txt', 'novější na serveru', novy);
  // jen lokálně
  await pisLokal('jen-lokalni.txt', 'x', novy);
  // jen na serveru
  await pisServer('jen-server.txt', 'y', novy);
  // stejná velikost, jiný čas — jediný případ pro srovnání času
  await pisLokal('jiny-cas.txt', 'stejne', novy);
  await pisServer('jiny-cas.txt', 'stejne', stary);

  const zaklad = { direction: 'toRemote', criteria: 'timeSize' };

  // ================================================ vše, co se liší
  const vse = await compare(adapter, localRoot, '/www', { ...zaklad, mode: 'diff' });
  check('režim „vše co se liší" nahraje i starší lokální', shrn(vse), [
    'jen-lokalni.txt:upload',
    'jiny-cas.txt:upload',
    'lokalni-novejsi.txt:upload',
    'server-novejsi.txt:upload',
  ]);

  // ================================================ jen novější
  const novejsi = await compare(adapter, localRoot, '/www', { ...zaklad, mode: 'newer' });
  check('režim „jen novější" novější soubor na serveru nepřepíše', shrn(novejsi), [
    'jen-lokalni.txt:upload',
    'jiny-cas.txt:upload',
    'lokalni-novejsi.txt:upload',
    'server-novejsi.txt:conflict',
  ]);
  const konflikt = novejsi.actions.find((a) => a.rel === 'server-novejsi.txt');
  truthy('a řekne proč', /na serveru je novější/.test(konflikt.why), konflikt.why);
  truthy('konflikt nese obě velikosti i časy',
    konflikt.localSize > 0 && konflikt.remoteSize > 0 && konflikt.localMtime && konflikt.remoteMtime);

  // ================================================ jen existující
  const existujici = await compare(adapter, localRoot, '/www', { ...zaklad, mode: 'diff', onlyExisting: true });
  check('„jen na obou stranách" nic nezakládá', shrn(existujici), [
    'jiny-cas.txt:upload',
    'lokalni-novejsi.txt:upload',
    'server-novejsi.txt:upload',
  ]);

  // ================================================ jen srovnat časy
  const casy = await compare(adapter, localRoot, '/www', { ...zaklad, mode: 'timestamps' });
  check('srovnání času se týká jen souborů se stejnou velikostí', shrn(casy), ['jiny-cas.txt:touchRemote']);
  const touch = casy.actions[0];
  check('a nese čas ze zdroje', Math.round(touch.mtime / 1000), Math.round(novy.getTime() / 1000));
  check('nic se nepřenáší', casy.actions.filter((a) => ['upload', 'download'].includes(a.action)).length, 0);

  // Ani s mazáním se v tomhle režimu nic nemaže — jen se srovnává čas.
  const casyMazani = await compare(adapter, localRoot, '/www', { ...zaklad, mode: 'timestamps', deleteExtra: true });
  check('a nic se nemaže, ani když je mazání zapnuté',
    casyMazani.actions.filter((a) => a.action.startsWith('delete') || a.action.startsWith('rmdir')).length, 0);

  // ================================================ obousměrně
  const oba = await compare(adapter, localRoot, '/www', { direction: 'both', criteria: 'timeSize', mode: 'diff' });
  check('obousměrně vyhrává novější na každé straně', shrn(oba), [
    'jen-lokalni.txt:upload',
    'jen-server.txt:download',
    'jiny-cas.txt:upload',
    'lokalni-novejsi.txt:upload',
    'server-novejsi.txt:download',
  ]);

  // ================================================ skutečný konflikt
  // Stejný čas, jiná velikost: nedá se rozhodnout, kdo má pravdu.
  await pisLokal('spor.txt', 'lokální verze delší', novy);
  await pisServer('spor.txt', 'kratší', novy);
  const spor = (await compare(adapter, localRoot, '/www', { direction: 'both', criteria: 'timeSize', mode: 'diff' }))
    .actions.find((a) => a.rel === 'spor.txt');
  check('shodný čas a jiná velikost je konflikt', spor.action, 'conflict');
  truthy('s vysvětlením', /čas je stejný/.test(spor.why), spor.why);
  check('konflikt sám o sobě nic nepřenese', spor.localPath.endsWith('spor.txt') && !spor.resolve, true);

  // ================================================ režim se vrací volajícímu
  check('výsledek nese použitý režim', (await compare(adapter, localRoot, '/www', { ...zaklad, mode: 'newer' })).mode, 'newer');

  await adapter.disconnect();
  await server.close();
  await fsp.rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
