# Charon

Dvoupanelový SFTP/FTP klient pro macOS — náhrada WinSCP. Samostatná desktopová
aplikace (Electron), ne webová stránka: vlastní okno, vlastní ikona v Docku,
plný přístup k souborům na disku.

Dva panely jsou dva břehy a Charon je ten, kdo mezi nimi převáží. Na rozdíl od
předlohy vozí i zpátky.

## Co umí

| Funkce z WinSCP | Stav |
| --- | --- |
| Dva panely vedle sebe, přetahování mezi nimi i z Finderu | ✅ |
| Úprava vzdáleného souboru v editoru s automatickým nahráním při uložení | ✅ |
| Synchronizace adresářů s náhledem, co se provede | ✅ |
| SFTP (heslo, klíč, ssh-agent) i FTP / FTPS | ✅ |
| Fronta přenosů — průběh, pauza, navázání na přerušený přenos | ✅ |
| Uložené relace včetně hesel, ve složkách | ✅ |
| Import relací z WinSCP i s hesly | ✅ |
| Zachování času změny souboru při přenosu | ✅ |
| Ověřování identity serveru (host key i TLS certifikát) | ✅ |
| Dotaz při přepisu existujícího souboru | ✅ |
| Koš na serveru místo nevratného mazání | ✅ |
| Práva souborů (chmod), přejmenování, mazání, nové složky | ✅ |
| Přesun mezi panely (F6), ne jen kopírování | ✅ |
| Řazení kliknutím na hlavičku sloupce | ✅ |
| Historie cest (zpět/vpřed) a záložky | ✅ |
| Filtr a výběr podle masky souborů | ✅ |
| Hledání souborů na serveru | ✅ |
| Dopočítání velikosti složek | ✅ |
| Sloupce vlastníka a skupiny, nastavitelný dvojklik | ✅ |

Nepodporuje SCP, WebDAV ani S3 — relace v těchto protokolech se při importu
zobrazí, ale nejdou naimportovat.

## Spuštění

```bash
npm install
npm start          # vývojový režim
npm run dist       # sestaví .dmg do složky dist/
```

## Import z WinSCP

WinSCP hesla nešifruje, jen obfuskuje reverzibilním algoritmem, jehož klíčem je
`UserName + HostName`. Importér je proto umí přenést včetně hesel.

**Na Windows** si vyexportujte konfiguraci jedním ze dvou způsobů:

1. Ve WinSCP: **Tools → Export/Backup Configuration…** → uloží `WinSCP.ini`
2. Nebo v `regedit` exportujte klíč
   `HKEY_CURRENT_USER\Software\Martin Prikryl\WinSCP 2` do `.reg` souboru

Soubor přeneste na Mac a v aplikaci zvolte **Import z WinSCP…**. Zobrazí se
přehled nalezených relací s tím, u kterých se podařilo přečíst heslo, a vyberete
si, co naimportovat.

### Dvě omezení, na která můžete narazit

- **Master Password.** Když ho máte ve WinSCP zapnuté, hesla jsou navíc
  zašifrovaná AES a takhle je vytáhnout nelze. Aplikace to pozná a upozorní.
  Řešení: ve WinSCP dočasně vypnout (Options → Preferences → Security), export
  zopakovat, pak zase zapnout.
- **Klíče `.ppk`.** Cesta k privátnímu klíči je windowsová a formát PuTTY,
  který OpenSSH nečte. Klíč převedete přes `puttygen klic.ppk -O private-openssh -o klic`
  a cestu doplníte v nastavení relace ručně.

## Ověřování identity serveru

Při prvním připojení přes SFTP aplikace ukáže otisk klíče serveru a zeptá se,
co s ním. Otisk je ve stejném tvaru, jaký vypisuje OpenSSH, takže se dá ověřit
z jiného počítače:

```bash
ssh-keyscan -p 22 server.example.com | ssh-keygen -lf -
```

Máte tři možnosti: **zrušit**, **připojit jednorázově** (otisk se neuloží) nebo
**připojit a zapamatovat**. Známé servery z `~/.ssh/known_hosts` se rozpoznají
samy a neptají se — včetně zahashovaných záznamů a záznamů s nestandardním
portem. Klíč označený v `known_hosts` jako `@revoked` se odmítne vždy.

Když se otisk uloženého serveru později změní, aplikace **nepřipojí** a ukáže
oba otisky vedle sebe. Server mohl být přeinstalován, ale stejně tak se za něj
někdo může vydávat — proto je předvyplněná odpověď „zrušit".

Dialog je záměrně systémový, ne součást okna aplikace: obsah stránky ho tak
nemá jak napodobit. Změna serveru nebo portu u uložené relace otisk zahodí,
aby nepotvrzoval něco jiného, než k čemu se připojujete.

### FTPS a TLS certifikáty

U FTPS platí totéž. Když certifikát neprojde proti systémovým autoritám —
typicky je podepsaný sám sebou, vystavený na jiné jméno nebo prošlý — ukáže se
komu byl vydán, kdo ho vydal, do kdy platí a jeho otisk SHA-256. Ten je ve
stejném tvaru, jaký vypíše OpenSSL, takže se dá porovnat:

```bash
openssl s_client -connect server.example.com:21 -starttls ftp \
  | openssl x509 -noout -fingerprint -sha256
```

Podstatné je **kdy** se ptáme: certifikát se kontroluje mezi TLS handshakem
a přihlášením. Kdyby se ověřoval až po připojení, jméno a heslo by u serveru,
který se za ten pravý jen vydává, už byly. Proto se nepoužívá `access()`
z knihovny, ale jeho kroky zvlášť.

Když se certifikát později vymění za jiný, kterému **systém věří** (běžná
obnova u autority), uložený otisk se tiše srovná a nic nevyskočí. Výstraha
přijde jen tehdy, když se otisk liší a systém novému certifikátu taky nevěří.

Únikový východ zůstává: *Přijmout jakýkoliv certifikát bez ptaní*. Je vypnutý
a nedoporučuje se — s potvrzením otisku ho nepotřebujete.

## Když cílový soubor už existuje

Přenos se nikdy nezahájí přes existující soubor bez zeptání. Dialog ukáže
velikost a čas obou verzí a nabídne:

| Volba | Co udělá |
| --- | --- |
| Přepsat | Nahradí cíl zdrojem |
| Navázat | Doplní jen chybějící konec (jen když je cíl kratší) |
| Přeskočit | Nechá cíl být |
| Jen když je novější | Přenese jen tehdy, je-li zdroj novější |
| Přejmenovat | Uloží jako `název (2).přípona` |
| Zrušit vše | Vyprázdní frontu |

Zaškrtnutím **Použít na všechny další** se volba uplatní na zbytek fronty;
po jejím vyprázdnění se zase ptá. Klávesa Esc znamená *přeskočit*, nikdy
*přepsat*.

Nezeptá se ve dvou případech, kdy už rozhodnutí padlo jinde: u synchronizace
(přepis jste odsouhlasili v náhledu) a při ukládání souboru otevřeného
v editoru (přepsat vzdálený soubor je přesně to, co uložení znamená).

## Koš na serveru

Lokálně se mazalo do systémového koše a na serveru nevratně. Nově se i na
serveru maže přesunem — položka se přejmenuje pod složku koše a **zachová si
původní cestu**:

```
/var/www/html/index.php  →  ~/.charon-trash/2026-08-16/var/www/html/index.php
```

Přesun je jen přejmenování, takže nestojí žádný přenos dat. Když ho server
odmítne (koš by byl na jiném svazku), aplikace to ohlásí a **nesmaže natvrdo**
jako náhradní řešení.

Nastavuje se u každé relace zvlášť — složka koše i automatický úklid po zadaném
počtu dní. Ruční vysypání je v nabídce *Soubor* a v kontextovém menu serverového
panelu. Mazání s klávesou **Shift** koš obejde a smaže rovnou.

## Kde se co ukládá

| Co | Kde |
| --- | --- |
| Relace | `~/Library/Application Support/charon/sites.json` |
| Nastavení | `~/Library/Application Support/charon/settings.json` |
| Šifrovací klíč k heslům | macOS Keychain, položka `Charon` |
| Dočasné soubory otevřené v editoru | `$TMPDIR/charon-edit/` |

Hesla se do `sites.json` zapisují zašifrovaná (AES-256-GCM); klíč leží
v Keychain, ne v souboru.

## Klávesové zkratky

| Klávesa | Akce |
| --- | --- |
| `F5` | Zkopírovat vybrané do druhého panelu |
| `F6` | Přesunout vybrané do druhého panelu |
| `F4` | Upravit vzdálený soubor v editoru |
| `F2` | Přejmenovat |
| `F7` | Nová složka |
| `⌫` | Smazat do koše (lokálního i serverového) |
| `⇧⌫` | Smazat natrvalo, s vynecháním koše |
| `Tab` | Přepnout panel |
| `Enter` | Otevřít složku / soubor |
| `⌘A` | Vybrat vše |
| `+` / `−` | Vybrat / odznačit podle masky |
| `⌘[` / `⌘]` | Zpět / vpřed v historii cest |
| `⌘F` | Filtr (vlevo) nebo hledání na serveru (vpravo) |
| psaní | Skok na položku podle názvu |
| `⌘R` | Obnovit oba panely |
| `⌘S` | Synchronizace adresářů |
| `⌘O` / `⌘D` | Připojit / odpojit |

## Editace se zpětným nahráním

Dvojklik na vzdálený soubor (nebo `F4`) ho stáhne do dočasné složky, otevře
v editoru a hlídá. Při každém uložení se sám nahraje zpět na server — bez
dalšího kliknutí. V **Nastavení** si můžete zvolit editor (např.
`Visual Studio Code`); prázdné pole znamená výchozí aplikaci podle přípony.

## Masky souborů

Stejný zápis se používá na filtr v panelu, na výběr klávesami `+` a `−`
i na hledání:

| Zápis | Význam |
| --- | --- |
| `*` | libovolný počet znaků |
| `?` | právě jeden znak |
| `[abc]`, `[a-z]` | jeden znak z výčtu nebo rozsahu |
| `[*]` | hvězdička jako obyčejný znak |
| `a; b` nebo `a, b` | víc masek najednou |
| `vzor \| výluka` | za svislítkem je výluka, ta má přednost |
| `slozka/` | platí jen pro složky |

Nezáleží na velikosti písmen. Příklad: `*.php; *.css | .git/; node_modules/`
vybere PHP a CSS, ale vynechá dvě složky.

Filtr nikdy neschovává složky — jinak by se nedalo doklikat níž.

## Hledání souborů na serveru

`⌘F` v pravém panelu (nebo *Soubor → Najít soubory na serveru*) projde strom od
zadané cesty a hledá podle masky. Nálezy přibývají průběžně, takže se dá začít
pracovat dřív, než hledání doběhne, a kdykoliv ho jde zastavit. Z výsledků se dá
rovnou stahovat, otevřít soubor v editoru nebo skočit na jeho místo v panelu.

Hledání se zastaví na 5000 nálezech a hloubce 40 úrovní — obojí je pojistka
proti překlepu v masce, ne technický limit.

## Synchronizace

Porovná lokální a vzdálený strom a **nejdřív ukáže seznam akcí** — teprve po
potvrzení se cokoliv přenese. Směr může být jednosměrný i obousměrný, porovnávat
lze podle času, velikosti nebo obojího. Mazání je volitelné a před provedením se
na něj aplikace ještě jednou zeptá.

Aby opakovaná synchronizace nehlásila pořád tytéž soubory, přenáší se i čas
změny — přes `SETSTAT` u SFTP a `MFMT` u FTP.

U FTP je kolem času několik nástrah, které aplikace řeší za vás:

- Textový výpis (`LIST`) hlásí čas jen na minuty, bez sekund a bez časové zóny.
  Pro zobrazení se parsuje, ale pro porovnávání se čas nechá upřesnit příkazem
  `MDTM`, který vrací UTC na sekundu. Proto porovnání trvá u FTP déle než výpis.
- Tolerance je u FTP 61 s (u SFTP 2 s), aby minutová přesnost nezpůsobovala
  falešné rozdíly.
- Když server neumí `MFMT`, nahraný soubor dostane čas „teď". Přenos kvůli tomu
  neselže, ale opakovaná synchronizace by pak soubory hlásila znovu — v takovém
  případě přepněte porovnávání **na velikost**.

## Testy

```bash
npm test
```

- `test/winscp-import.test.js` — dekódování hesel WinSCP, parsování `.ini` i `.reg`
- `test/mask.test.js` — zápis masek souborů
- `test/safety.test.js` — otisky klíčů a `known_hosts`, odmítnutí neověřeného
  serveru, všechny volby při konfliktu, přesun a chování koše
- `test/browse.test.js` — dopočítání velikosti složek a hledání souborů
- `test/e2e.test.js` — SFTP: přenosy, pauza, navázání, chmod a synchronizace proti
  dočasnému SFTP serveru z `test/sftp-server.js`
- `test/ftp.test.js` — FTP: totéž proti dočasnému FTP serveru, včetně navázání
  přes `REST`/`APPE` a parsování časů z textového výpisu
- `test/ftps.test.js` — FTPS: potvrzování otisku certifikátu a hlavně kontrola,
  že se při nepotvrzeném certifikátu heslo na server vůbec neodešle

Testovací SSH klíč a certifikáty v `test/fixtures/` slouží **jen k testům** —
servery běží na `127.0.0.1` na náhodném portu a nikam se nepublikují.
