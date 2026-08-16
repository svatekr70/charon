'use strict';

/**
 * Převod konců řádků.
 *
 * Zajímavá je jediná věc: hranice mezi kusy dat. Když jeden skončí `CR`
 * a další začne `LF`, patří k sobě — a naivní převod je rozpojí, takže
 * v souboru zůstane osamocený `CR` a prázdný řádek navíc. Proto se tu
 * testuje po jednom bajtu.
 */

const { toCrlf, toLf } = require('../src/main/eol');

let pass = 0;
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/** Prožene data převodem po zadaných kusech a vrátí výsledek. */
function projed(tovarna, vstup, velikostKusu) {
  return new Promise((resolve, reject) => {
    const t = tovarna();
    const kusy = [];
    t.on('data', (d) => kusy.push(d));
    t.on('end', () => resolve(Buffer.concat(kusy)));
    t.on('error', reject);

    const buf = Buffer.from(vstup);
    for (let i = 0; i < buf.length; i += velikostKusu) {
      t.write(buf.subarray(i, i + velikostKusu));
    }
    t.end();
  });
}

const text = (b) => b.toString('binary').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');

async function main() {
  // Každý případ projedeme po celku i po jednotlivých bajtech — hranice kusů
  // je jediné místo, kde se převod dá pokazit.
  const pripady = [
    ['prázdný vstup', toCrlf, '', ''],
    ['LF na CRLF', toCrlf, 'a\nb\n', 'a\r\nb\r\n'],
    ['už hotové CRLF se nezdvojí', toCrlf, 'a\r\nb\r\n', 'a\r\nb\r\n'],
    ['smíšený soubor se srovná', toCrlf, 'a\nb\r\nc\n', 'a\r\nb\r\nc\r\n'],
    ['osamocené CR zůstává', toCrlf, 'a\rb', 'a\rb'],
    ['bez konců řádků se nic nemění', toCrlf, 'jenom text', 'jenom text'],
    ['soubor končící LF', toCrlf, 'a\n', 'a\r\n'],

    ['CRLF na LF', toLf, 'a\r\nb\r\n', 'a\nb\n'],
    ['LF zůstane LF', toLf, 'a\nb\n', 'a\nb\n'],
    ['smíšený se sjednotí', toLf, 'a\r\nb\nc\r\n', 'a\nb\nc\n'],
    ['osamocené CR se nemaže', toLf, 'a\rb', 'a\rb'],
    ['soubor končící CR', toLf, 'a\r', 'a\r'],
    ['soubor končící CRLF', toLf, 'a\r\n', 'a\n'],
  ];

  for (const [popis, tovarna, vstup, ocekavano] of pripady) {
    check(`${popis} (najednou)`, text(await projed(tovarna, vstup, 1024)), text(Buffer.from(ocekavano)));
    check(`${popis} (po bajtech)`, text(await projed(tovarna, vstup, 1)), text(Buffer.from(ocekavano)));
  }

  // ================================================ hranice přesně mezi CR a LF
  const naHrane = Buffer.from('rádek jedna\r\nrádek dvě\r\n');
  const kdeCr = naHrane.indexOf(0x0d);
  const pulky = [naHrane.subarray(0, kdeCr + 1), naHrane.subarray(kdeCr + 1)];
  const t = toLf();
  const out = [];
  t.on('data', (d) => out.push(d));
  const hotovo = new Promise((r) => t.on('end', r));
  t.write(pulky[0]); t.write(pulky[1]); t.end();
  await hotovo;
  check('CR na konci kusu a LF na začátku dalšího se spojí',
    text(Buffer.concat(out)), text(Buffer.from('rádek jedna\nrádek dvě\n')));

  // ================================================ binární data se nepoškodí
  // Do textové masky se občas připlete i binárka; osamocené CR ani jiné bajty
  // se v převodu na LF nesmí ztratit.
  const binarka = Buffer.from([0x00, 0x0d, 0xff, 0x0d, 0x0a, 0x80, 0x0d]);
  const poLf = await projed(toLf, binarka, 1);
  check('binární data přežijí převod na LF',
    [...poLf], [0x00, 0x0d, 0xff, 0x0a, 0x80, 0x0d]);
  check('a nic se neztratí na konci', poLf[poLf.length - 1], 0x0d);

  console.log(`\n${pass} prošlo, ${fail} selhalo`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test selhal výjimkou:', err); process.exit(1); });
