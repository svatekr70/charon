'use strict';

/**
 * Příkaz pro otevření Terminálu na serveru.
 *
 * Název složky si nevybíráme my — přichází ze serveru a klidně může obsahovat
 * apostrof, středník nebo mezery. Z takového názvu musí vzniknout argument,
 * ne další příkaz. Proto se to počítá v modulu a testuje se to tady.
 */

const { execFileSync } = require('child_process');
const { sshCommand } = require('../src/main/terminal');

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

const zaklad = { host: 'server.test', username: 'web', port: 22, protocol: 'sftp' };

function main() {
  check('nejjednodušší případ',
    sshCommand(zaklad, '/var/www'),
    "ssh web@server.test -t 'cd '\\''/var/www'\\'' && exec $SHELL -l'");

  check('nestandardní port se doplní',
    sshCommand({ ...zaklad, port: 2222 }, '/w').startsWith('ssh -p 2222 web@server.test'), true);
  check('port 22 se nepíše', sshCommand(zaklad, '/w').includes('-p'), false);
  check('klíč se předá', sshCommand({ ...zaklad, privateKeyPath: '/Users/a/.ssh/id_ed25519' }, '/w')
    .includes('-i /Users/a/.ssh/id_ed25519'), true);
  check('brána se předá jako -J',
    sshCommand({ ...zaklad, tunnelHost: 'brana.test', tunnelUsername: 'admin', tunnelPort: 2022 }, '/w')
      .includes('-J admin@brana.test:2022'), true);
  check('bez uživatele se jméno nevymýšlí',
    sshCommand({ host: 'h.test', port: 22 }, '/w').includes('ssh h.test'), true);

  // ============================================ ošklivé názvy složek
  // Tohle je ta podstatná část: nic z toho se nesmí stát příkazem.
  const zakerne = [
    "/var/www/; touch OVLADNUTO",
    "/var/www/$(touch OVLADNUTO)",
    "/var/www/`touch OVLADNUTO`",
    "/var/www/it's here",
    '/var/www/a b c',
    '/var/www/&& rm -rf ~',
  ];
  for (const dir of zakerne) {
    // Podstatné je, že se cesta v shellu rozloží na jediný argument a přijde
    // celá. Ověřujeme to tak, že necháme skutečný /bin/sh, ať ji vypíše.
    const { shellQuote } = require('../src/main/commands');
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${shellQuote(dir)}`], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    });
    check(`shell v ${JSON.stringify(dir)} vidí jeden argument`, out.split('\n').filter(Boolean).length, 1);
    check('  a dorazí přesně', out.trim(), dir);

    // A v celém příkazu se ta cesta objeví jen uvnitř uzavřené části.
    const prikaz = sshCommand(zaklad, dir);
    truthy('  příkaz začíná ssh a končí spuštěním shellu',
      prikaz.startsWith('ssh ') && prikaz.endsWith("exec $SHELL -l'"));
  }

  // Kdyby uzavření selhalo, tenhle soubor by vznikl — ověříme, že nevznikl.
  const fs = require('fs');
  check('žádný příkaz se nespustil', fs.existsSync('OVLADNUTO'), false);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main();
