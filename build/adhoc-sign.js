'use strict';

/**
 * Podpis „sám sebou" (ad-hoc) po sestavení balíčku.
 *
 * Bez vývojářského certifikátu za 99 dolarů ročně se aplikace notarizovat
 * nedá, ale podepsaná být musí: na Apple Siliconu spouští systém jen kód
 * s platným podpisem. electron-builder podepisování přeskakuje, takže
 * v balíčku zůstane jen podpis od linkeru na hlavní binárce a `_CodeSignature`
 * celého balíčku chybí. Stažená aplikace pak dostane karanténu, systém si
 * ověří podpis, neuspěje — a ohlásí, že je „poškozena a nelze ji otevřít".
 *
 * S ad-hoc podpisem je balíček celistvý a hlášení se změní na obvyklé
 * „nelze ověřit vývojáře", které jde odklepnout. Karanténu to nesundá; na to
 * je `xattr -dr com.apple.quarantine` nebo sestavení u sebe (`install-app`),
 * kde se karanténa vůbec nenasazuje.
 */

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const jmeno = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${jmeno}.app`);

  // --force přepíše podpis od linkeru, --deep vezme i vnořené rámce a helpery.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  // Když by podpis nesedl, ať to praskne tady a ne až u uživatele.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • aplikace podepsána ad-hoc  app=${app}`);
};
