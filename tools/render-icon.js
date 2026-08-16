'use strict';

/**
 * Vykreslí ikonu z SVG do PNG ve všech velikostech, které macOS chce.
 *
 * Rasterizér je Chromium, který je v Electronu stejně po ruce — přidávat kvůli
 * jedné ikoně další závislost by bylo víc práce než užitku. Z hotových PNG
 * sestaví `iconutil` (součást macOS) výsledný `.icns`.
 *
 *   npx electron tools/render-icon.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const KOREN = path.join(__dirname, '..', 'build');
const SVG = path.join(KOREN, 'icon.svg');
const ICONSET = path.join(KOREN, 'icon.iconset');

// Velikosti podle Apple; @2x je totéž dvakrát větší.
const VELIKOSTI = [16, 32, 64, 128, 256, 512, 1024];

async function main() {
  await app.whenReady();
  fs.mkdirSync(ICONSET, { recursive: true });
  const svg = fs.readFileSync(SVG, 'utf8');

  // Okno vyrábíme jedno a jen ho zvětšujeme. Druhé okno na pozadí se
  // v Electronu spolehlivě načíst nepodařilo — a jedno stačí.
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: { offscreen: true },
  });

  for (const px of VELIKOSTI) {
    win.setContentSize(px, px);

    const html = `<!doctype html><meta charset="utf-8">
      <style>html,body{margin:0;padding:0;background:transparent}
      svg{display:block;width:${px}px;height:${px}px}</style>${svg}`;
    const docasny = path.join(ICONSET, `.render.html`);
    fs.writeFileSync(docasny, html);
    await win.loadFile(docasny);
    // Chvíli počkáme na dokreslení přechodů; bez toho vyjde občas prázdno.
    await new Promise((r) => setTimeout(r, 300));

    // Na Retině vrací capturePage dvojnásobek bodů, takže výsledek ještě
    // srovnáme na přesnou velikost — iconutil na ni trvá.
    const obrazek = await win.webContents.capturePage();
    const presne = obrazek.getSize().width === px ? obrazek : obrazek.resize({ width: px, height: px });
    fs.writeFileSync(path.join(ICONSET, `icon_${px}x${px}.png`), presne.toPNG());
    console.log(`  ${px}×${px} (sejmuto ${obrazek.getSize().width})`);
  }
  win.destroy();
  fs.rmSync(path.join(ICONSET, '.render.html'), { force: true });

  // iconutil chce dvojice jmen icon_NxN a icon_NxN@2x.
  const dvojice = [[16, 32], [32, 64], [128, 256], [256, 512], [512, 1024]];
  for (const [zaklad, dvakrat] of dvojice) {
    fs.copyFileSync(
      path.join(ICONSET, `icon_${dvakrat}x${dvakrat}.png`),
      path.join(ICONSET, `icon_${zaklad}x${zaklad}@2x.png`),
    );
  }
  for (const px of [64, 1024]) {
    fs.rmSync(path.join(ICONSET, `icon_${px}x${px}.png`), { force: true });
  }

  console.log('Hotovo:', ICONSET);
  app.exit(0);
}

main().catch((err) => { console.error(err); app.exit(1); });
