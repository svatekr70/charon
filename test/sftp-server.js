'use strict';

/**
 * Minimální SFTP server pro testy — jen tenká vrstva nad skutečným
 * adresářem na disku. Slouží k ověření, že adaptér, fronta a synchronizace
 * mluví s protokolem správně, bez závislosti na externím serveru.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Server } = require('ssh2');
const { STATUS_CODE, OPEN_MODE } = require('ssh2').utils.sftp;

/**
 * @param {number} [latencyMs] umělé zpoždění každé odpovědi. Na loopbacku je
 *   latence nulová, takže bez něj nejde změřit, co souběžné přenosy vlastně
 *   řeší — a to je právě latence, ne šířka pásma.
 */
function startTestServer({
  root, hostKeyPath, user = 'test', password = 'test', latencyMs = 0, port = 0,
}) {
  return new Promise((resolve) => {
    const handles = new Map();
    let nextHandle = 1;

    const makeHandle = (payload) => {
      const id = nextHandle++;
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(id, 0);
      handles.set(id, payload);
      return buf;
    };
    const getHandle = (buf) => handles.get(buf.readUInt32BE(0));
    const dropHandle = (buf) => handles.delete(buf.readUInt32BE(0));

    // Cesty klienta jsou absolutní posixové — mapujeme je pod testovací kořen.
    const real = (p) => path.join(root, path.normalize(`/${p}`));

    const attrs = (st) => ({
      mode: st.mode,
      uid: st.uid,
      gid: st.gid,
      size: st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    });

    // Živá spojení si držíme, ať jde server zavřít i uprostřed přenosu.
    const clients = new Set();

    const server = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)] }, (client) => {
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === user && ctx.password === password) ctx.accept();
        else if (ctx.method === 'none') ctx.reject(['password']);
        else ctx.reject(['password']);
      });

      client.on('ready', () => {
        // Protažení spojení dál (direct-tcpip). Bez toho by nešlo vyzkoušet
        // připojení přes bránu, protože forwardOut nemá kdo obsloužit.
        client.on('tcpip', (acceptFwd, rejectFwd, info) => {
          const upstream = net.connect({ host: info.destIP, port: info.destPort }, () => {
            const channel = acceptFwd();
            channel.pipe(upstream).pipe(channel);
          });
          upstream.on('error', () => rejectFwd());
        });

        client.on('session', (accept) => {
          const session = accept();

          // Shell pro testy vlastních příkazů a konzole. Server poslouchá jen
          // na 127.0.0.1 s pevnými testovacími údaji a běží výhradně v testech;
          // do ničeho jiného se používat nesmí.
          session.on('exec', (acceptExec, rejectExec, info) => {
            const stream = acceptExec();
            // Klient posílá absolutní cesty ze serveru; ty jsou u nás jen
            // uvnitř testovacího kořene. Úvodní „cd" proto přepíšeme stejně,
            // jako to dělá real() u ostatních operací.
            const command = info.command.replace(
              /^cd '((?:[^']|'\\'')*)' && /,
              (_m, dir) => `cd '${real(dir.split("'\\''").join("'"))}' && `,
            );
            const child = spawn('/bin/sh', ['-c', command], { cwd: root });
            child.stdout.on('data', (d) => stream.write(d));
            child.stderr.on('data', (d) => stream.stderr.write(d));
            child.on('error', () => { stream.exit(127); stream.end(); });
            child.on('close', (code) => {
              stream.exit(code ?? 0);
              stream.end();
            });
          });

          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp();

            if (latencyMs > 0) {
              // Odpovědi posíláme se zpožděním; server se tím chová jako
              // vzdálený stroj přes internet.
              for (const m of ['status', 'handle', 'data', 'name', 'attrs']) {
                const orig = sftp[m].bind(sftp);
                sftp[m] = (...args) => setTimeout(() => orig(...args), latencyMs);
              }
            }

            sftp.on('REALPATH', (id, p) => {
              const target = p === '.' || p === '' ? '/' : path.normalize(`/${p}`);
              sftp.name(id, [{ filename: target, longname: target, attrs: {} }]);
            });

            sftp.on('OPENDIR', (id, p) => {
              try {
                const entries = fs.readdirSync(real(p));
                sftp.handle(id, makeHandle({ kind: 'dir', dir: real(p), entries, pos: 0 }));
              } catch {
                sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
              }
            });

            sftp.on('READDIR', (id, h) => {
              const st = getHandle(h);
              if (!st || st.kind !== 'dir') return sftp.status(id, STATUS_CODE.FAILURE);
              if (st.pos >= st.entries.length) return sftp.status(id, STATUS_CODE.EOF);
              const batch = st.entries.slice(st.pos, st.pos + 50).map((name) => {
                const s = fs.lstatSync(path.join(st.dir, name));
                const a = attrs(s);
                const kind = s.isDirectory() ? 'd' : s.isSymbolicLink() ? 'l' : '-';
                const perms = permString(s.mode);
                return {
                  filename: name,
                  longname: `${kind}${perms} 1 owner group ${String(s.size).padStart(8)} Jan  1 00:00 ${name}`,
                  attrs: a,
                };
              });
              st.pos += batch.length;
              return sftp.name(id, batch);
            });

            const doStat = (id, p) => {
              try { sftp.attrs(id, attrs(fs.lstatSync(real(p)))); }
              catch { sftp.status(id, STATUS_CODE.NO_SUCH_FILE); }
            };
            sftp.on('STAT', doStat);
            sftp.on('LSTAT', doStat);

            // Pořadí argumentů je u SYMLINK proslulá past: norma říká
            // (odkaz, cíl), OpenSSH to má prohozené a ssh2 podle toho emituje
            // jinak. Naše protistrana v testu je ssh2, tedy pořadí podle normy.
            sftp.on('SYMLINK', (id, linkPath, targetPath) => {
              try {
                fs.symlinkSync(targetPath, real(linkPath));
                sftp.status(id, STATUS_CODE.OK);
              } catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });

            sftp.on('READLINK', (id, p) => {
              try {
                const cil = fs.readlinkSync(real(p));
                sftp.name(id, [{ filename: cil, longname: cil, attrs: {} }]);
              } catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });

            sftp.on('FSTAT', (id, h) => {
              const st = getHandle(h);
              if (!st) return sftp.status(id, STATUS_CODE.FAILURE);
              try { return sftp.attrs(id, attrs(fs.fstatSync(st.fd))); }
              catch { return sftp.status(id, STATUS_CODE.FAILURE); }
            });

            sftp.on('OPEN', (id, filename, flags) => {
              let mode = 'r';
              if (flags & OPEN_MODE.APPEND) mode = 'a';
              else if (flags & OPEN_MODE.WRITE) mode = (flags & OPEN_MODE.TRUNC) ? 'w' : 'r+';
              // EXCL znamená „vytvoř, ale jen když ještě není". Skutečné
              // servery ho ctí, takže ho musí ctít i tenhle — jinak by se na
              // něm ochrana proti přepsání nedala ověřit.
              if ((flags & OPEN_MODE.EXCL) && (mode === 'w' || mode === 'a')) mode += 'x';
              try {
                if (mode === 'r+' && !fs.existsSync(real(filename))) mode = 'w';
                const fd = fs.openSync(real(filename), mode);
                sftp.handle(id, makeHandle({ kind: 'file', fd }));
              } catch {
                sftp.status(id, STATUS_CODE.FAILURE);
              }
            });

            sftp.on('READ', (id, h, offset, length) => {
              const st = getHandle(h);
              if (!st || st.kind !== 'file') return sftp.status(id, STATUS_CODE.FAILURE);
              const buf = Buffer.alloc(length);
              const read = fs.readSync(st.fd, buf, 0, length, offset);
              if (read === 0) return sftp.status(id, STATUS_CODE.EOF);
              return sftp.data(id, buf.subarray(0, read));
            });

            sftp.on('WRITE', (id, h, offset, data) => {
              const st = getHandle(h);
              if (!st || st.kind !== 'file') return sftp.status(id, STATUS_CODE.FAILURE);
              fs.writeSync(st.fd, data, 0, data.length, offset);
              return sftp.status(id, STATUS_CODE.OK);
            });

            sftp.on('CLOSE', (id, h) => {
              const st = getHandle(h);
              if (st && st.kind === 'file') { try { fs.closeSync(st.fd); } catch { /* už zavřeno */ } }
              dropHandle(h);
              sftp.status(id, STATUS_CODE.OK);
            });

            sftp.on('MKDIR', (id, p) => {
              try { fs.mkdirSync(real(p), { recursive: true }); sftp.status(id, STATUS_CODE.OK); }
              catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });
            sftp.on('RMDIR', (id, p) => {
              try { fs.rmdirSync(real(p)); sftp.status(id, STATUS_CODE.OK); }
              catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });
            sftp.on('REMOVE', (id, p) => {
              try { fs.unlinkSync(real(p)); sftp.status(id, STATUS_CODE.OK); }
              catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });
            sftp.on('RENAME', (id, from, to) => {
              try { fs.renameSync(real(from), real(to)); sftp.status(id, STATUS_CODE.OK); }
              catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });
            sftp.on('SETSTAT', (id, p, a) => {
              try {
                if (a.mode !== undefined) fs.chmodSync(real(p), a.mode & 0o777);
                if (a.atime !== undefined && a.mtime !== undefined) fs.utimesSync(real(p), a.atime, a.mtime);
                sftp.status(id, STATUS_CODE.OK);
              } catch { sftp.status(id, STATUS_CODE.FAILURE); }
            });
          });
        });
      });

      client.on('error', () => { /* klient se odpojil */ });
    });

    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        // ssh2 čeká se zavřením na dožití všech spojení. Test ale server často
        // vypíná právě proto, aby zjistil, co se stane při výpadku — takže je
        // ukončíme sami, jinak by se close() nedočkal.
        close: () => new Promise((r) => {
          for (const c of clients) { try { c.end(); } catch { /* už zavřený */ } }
          clients.clear();
          server.close(r);
          // Kdyby některé spojení nedoumíralo, po chvíli ho utneme natvrdo.
          setTimeout(() => { try { server.close(); } catch { /* už zavřený */ } r(); }, 1500).unref();
        }),
      });
    });
  });
}

function permString(mode) {
  const b = (n) => `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`;
  return b((mode >> 6) & 7) + b((mode >> 3) & 7) + b(mode & 7);
}

module.exports = { startTestServer };
