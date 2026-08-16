'use strict';

const crypto = require('crypto');
const { ipcMain } = require('electron');

/**
 * Dotazy z hlavního procesu do okna.
 *
 * Běžné IPC jde opačným směrem (okno se ptá hlavního procesu). Fronta přenosů
 * ale potřebuje uprostřed práce zjistit, co má uživatel s konfliktem udělat,
 * takže dotaz posíláme do okna a čekáme na odpověď.
 *
 * Každý dotaz má vždycky náhradní odpověď pro případ, že okno zmizí —
 * jinak by fronta uvízla na promise, který nikdo nesplní.
 */
const pending = new Map();

function register() {
  ipcMain.handle('prompt:answer', (_e, { id, answer }) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.resolve(answer);
    return true;
  });
}

function ask(win, channel, payload, fallback) {
  if (!win || win.isDestroyed()) return Promise.resolve(fallback);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, { resolve, fallback });
    win.webContents.send(channel, { id, ...payload });
  });
}

/** Zavolat při zavření okna, ať nic nečeká donekonečna. */
function cancelAll() {
  for (const [, entry] of pending) entry.resolve(entry.fallback);
  pending.clear();
}

module.exports = { register, ask, cancelAll };
