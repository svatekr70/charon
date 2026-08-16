/**
 * Adresa relace: `sftp://uzivatel@server:2222/cesta`.
 *
 * Slouží k dvěma věcem — vložit adresu a rovnou se připojit, a naopak si
 * adresu otevřené relace zkopírovat, aby šla poslat kolegovi.
 *
 * Heslo v adrese přijímáme (WinSCP i prohlížeče to umí a lidé to tak
 * posílají), ale **nikdy ho do adresy nepíšeme**: zkopírovaná adresa se
 * často ocitne v chatu nebo v ticketu, kde už zůstane.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UrlSession = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  /** Schéma → protokol a šifrování, jak je zná zbytek aplikace. */
  const SCHEMES = {
    sftp: { protocol: 'sftp', ftps: 'none', port: 22 },
    ssh: { protocol: 'sftp', ftps: 'none', port: 22 },
    ftp: { protocol: 'ftp', ftps: 'none', port: 21 },
    ftps: { protocol: 'ftp', ftps: 'explicit', port: 21 },
    ftpes: { protocol: 'ftp', ftps: 'explicit', port: 21 },
    ftpis: { protocol: 'ftp', ftps: 'implicit', port: 990 },
  };

  /**
   * Rozebere adresu na údaje relace.
   *
   * @returns {{protocol: string, host: string, port: number, username: string,
   *   password: string, ftps: string, remoteDir: string, name: string}}
   * @throws {Error} když adresa nedává smysl — s vysvětlením, co s ní je
   */
  function parse(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('Zadejte adresu');

    // Bez schématu předpokládáme SFTP; kdo píše ručně, obvykle ho vynechá.
    const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `sftp://${raw}`;

    let u;
    try {
      u = new URL(s);
    } catch {
      throw new Error('Tohle není platná adresa');
    }

    const schema = u.protocol.replace(':', '').toLowerCase();
    const znama = SCHEMES[schema];
    if (!znama) {
      throw new Error(`Protokol ${schema.toUpperCase()} neumíme — jde SFTP, FTP a FTPS`);
    }
    if (!u.hostname) throw new Error('V adrese chybí server');

    // `new URL` nechává v cestě procenta; uživatel čeká skutečné znaky.
    let cesta = '';
    try {
      cesta = decodeURIComponent(u.pathname || '');
    } catch {
      cesta = u.pathname || '';
    }
    if (cesta === '/') cesta = '';

    return {
      protocol: znama.protocol,
      ftps: znama.ftps,
      host: u.hostname,
      port: Number(u.port) || znama.port,
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
      remoteDir: cesta,
      // Název pro záložku; adresa bez cesty se čte líp než celá URL.
      name: `${u.username ? `${decodeURIComponent(u.username)}@` : ''}${u.hostname}`,
    };
  }

  /**
   * Sestaví adresu z relace a cesty. Heslo se do ní nedostane.
   */
  function format(cfg, remotePath = '') {
    const schema = cfg.protocol === 'ftp'
      ? (cfg.ftps === 'implicit' ? 'ftpis' : cfg.ftps === 'explicit' ? 'ftps' : 'ftp')
      : 'sftp';
    const vychozi = SCHEMES[schema].port;
    const port = Number(cfg.port) && Number(cfg.port) !== vychozi ? `:${cfg.port}` : '';
    const uzivatel = cfg.username ? `${encodeURIComponent(cfg.username)}@` : '';

    // Lomítka v cestě musí zůstat lomítky, jinak by z adresy nešlo nic poznat.
    const cesta = String(remotePath || '')
      .split('/')
      .map((c) => encodeURIComponent(c))
      .join('/');

    return `${schema}://${uzivatel}${cfg.host}${port}${cesta}`;
  }

  return { parse, format, SCHEMES };
}));
