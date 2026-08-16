'use strict';

const { shellQuote } = require('./commands');

/**
 * Příkaz `ssh`, kterým se člověk dostane do téže složky na serveru.
 *
 * Sestavuje se sem, a ne rovnou v obsluze, kvůli testu: název složky si
 * nevybíráme my. Složka `'; rm -rf ~` je legitimní název a musí z něj vzniknout
 * argument, ne další příkaz.
 *
 * Heslo do příkazu nepatří — kdo se přihlašuje heslem, zadá si ho v terminálu
 * sám. Příkaz se proto jen připraví do schránky a spustí ho uživatel.
 */
function sshCommand(cfg, dir) {
  const casti = ['ssh'];

  const port = Number(cfg.port);
  if (port && port !== 22) casti.push('-p', String(port));
  if (cfg.privateKeyPath) casti.push('-i', cfg.privateKeyPath);

  if (cfg.tunnelHost) {
    const tp = Number(cfg.tunnelPort);
    casti.push('-J', `${cfg.tunnelUsername ? `${cfg.tunnelUsername}@` : ''}${cfg.tunnelHost}${
      tp && tp !== 22 ? `:${tp}` : ''}`);
  }

  casti.push(`${cfg.username ? `${cfg.username}@` : ''}${cfg.host}`);
  casti.push('-t', `cd ${shellQuote(dir || '/')} && exec $SHELL -l`);

  // Uzavíráme všechno, co není zjevně neškodné. Raději apostrof navíc než
  // příkaz, který se v cizím terminálu chová jinak, než jak vypadá.
  return casti.map((c) => (/^[\w@%+=:,./-]+$/.test(c) ? c : shellQuote(c))).join(' ');
}

module.exports = { sshCommand };
