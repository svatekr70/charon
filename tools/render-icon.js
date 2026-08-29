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
const PNG = path.join(KOREN, 'icon.png');
const ICONSET = path.join(KOREN, 'icon.iconset');

// Velikosti podle Apple; @2x je totéž dvakrát větší.
const VELIKOSTI = [16, 32, 64, 128, 256, 512, 1024];

async function main() {
  await app.whenReady();
  fs.mkdirSync(ICONSET, { recursive: true });
  // Předloha může být kreslená (icon.svg) nebo hotový obrázek (icon.png).
  // Rasterizér je v obou případech týž; PNG má přednost, aby šlo dodanou
  // grafiku nasadit, aniž by se přepisovala kresba. Zdroj ať je aspoň
  // 1024 × 1024, jinak se největší velikost roztáhne a rozmaže.
  const jePng = fs.existsSync(PNG);
  const png = jePng ? fs.readFileSync(PNG).toString('base64') : null;
  console.log(`Předloha: ${jePng ? 'build/icon.png' : 'build/icon.svg'}`);
  const svg = jePng ? null : fs.readFileSync(SVG, 'utf8');

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

    // Kreslená předloha si rámeček nese sama; dodaný obrázek ne, a tak se
    // orámuje tady. Bez toho by v Docku mezi zaoblenými dlaždicemi svítil
    // hranatý čtverec. Mřížka je Applova: obsah je čtverec 824 bodů
    // uprostřed plátna 1024 se zaoblením 185, zbytek nechává místo na stín.
    const dlazdice = px * 824 / 1024;
    const html = jePng
      ? `<!doctype html><meta charset="utf-8">
      <style>html,body{margin:0;padding:0;background:transparent}
      .dlazdice{
        width:${dlazdice}px; height:${dlazdice}px; margin:${(px - dlazdice) / 2}px;
        border-radius:${px * 185 / 1024}px; overflow:hidden;
        box-shadow:0 ${px * 10 / 1024}px ${px * 18 / 1024}px rgba(11,35,56,.3);
      }
      /* Kresba se v dlaždici o kousek přiblíží. Dodaný obrázek mívá kolem
         sebe rezervu — u téhle je to 86 % šířky a 78 % výšky — a v 32
         bodech se pak motiv scvrkne do nečitelna. 1,12 je spočítané tak,
         aby se krajní tahy ještě vešly dovnitř a nic se neuřízlo. */
      .dlazdice img{display:block; width:100%; height:100%; transform:scale(1.12)}</style>
      <div class="dlazdice"><img src="data:image/png;base64,${png}" alt=""></div>`
      : `<!doctype html><meta charset="utf-8">
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
