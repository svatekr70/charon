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
| Masky souborů pro přenosy i synchronizaci | ✅ |
| Souběžné přenosy a omezení rychlosti | ✅ |
| Přenos přes dočasný název | ✅ |
| Hlídání složky s automatickým nahráváním | ✅ |
| Víc připojení naráz v záložkách | ✅ |
| Vlastní příkazy a konzole na serveru | ✅ |
| Vlastnosti souboru, rekurzivní práva a kontrolní součet | ✅ |
| Detekce cizí změny při ukládání z editoru | ✅ |
| Nedokončená fronta přežije zavření aplikace | ✅ |
| Automatické obnovení spadlého spojení | ✅ |
| SSH brána (jump host) a proxy SOCKS5 / HTTP | ✅ |
| Pracovní plochy — uložená sada otevřených záložek | ✅ |
| Světlý, tmavý a systémový motiv | ✅ |
| Ikony souborů a složek podle typu | ✅ |
| Odhad zbývajícího času a celková velikost | ✅ |
| Práva nahraných souborů | ✅ |
| Uložené nastavení synchronizace u relace | ✅ |
| Import z `~/.ssh/config` včetně bran | ✅ |
| Barva a poznámka u relace | ✅ |
| Vyrovnávací paměť výpisů | ✅ |
| Správce relací se stromem složek a hledáním | ✅ |
| Režimy synchronizace a řešení konfliktů | ✅ |
| Řazení a řízení položek ve frontě | ✅ |
| Kódování názvů a časový posun u starších FTP | ✅ |
| Hromadné přejmenování s náhledem | ✅ |
| Otevření Terminálu v aktuální cestě | ✅ |
| Akce po vyprázdnění fronty | ✅ |
| Přenos jen nových a změněných souborů | ✅ |
| Kopie, symlink a ruční čas na serveru | ✅ |
| Editor podle přípony | ✅ |
| Záloha přepsaných souborů | ✅ |
| Nastavitelné keepalive a timeouty | ✅ |
| Textový režim a konverze konců řádků | ✅ |
| Porovnání složek přímo v panelech | ✅ |
| Otevření z adresy a kopírování adresy | ✅ |
| Otevření v přiřazené aplikaci | ✅ |
| Synchronizované procházení | ✅ |
| Profily nastavení přenosu | ✅ |
| Záznam komunikace do souboru | ✅ |
| Víc spojení na jeden velký soubor | ✅ |
| Vlastní písmo, velikost a přiblížení | ✅ |
| Nastavení rozdělené na oddíly | ✅ |
| Kontrola aktualizací | ✅ |

Nepodporuje SCP, WebDAV ani S3 — relace v těchto protokolech se při importu
zobrazí, ale nejdou naimportovat.

## Spuštění

### Rovnou z projektu

```bash
npm install
npm start
```

Okno naskočí za pár vteřin. Takhle se aplikace spouští při vývoji — zavřením
terminálu skončí. `npm run dev` je totéž; nástroje pro vývojáře se otevřou až
`npm run devtools`, aby při běžném spuštění ze zdrojáků nepřekážely.

### Jako opravdová aplikace

```bash
npm run dist
```

Vznikne `dist/mac-arm64/Charon.app` (na dvojklik) a `dist/Charon-1.0.0-arm64.dmg`
pro přenos jinam. Do Aplikací se přetáhne z DMG, nebo příkazem:

```bash
cp -R dist/mac-arm64/Charon.app /Applications/
```

Aplikace je podepsaná jen ad-hoc, bez vývojářského certifikátu. Sestavená
lokálně se otevře bez řečí; kdybys DMG poslal na jiný Mac, Gatekeeper ho
zastaví a bude potřeba **pravý klik → Otevřít**.

Data (relace, nastavení) jsou společná pro oba způsoby spuštění, takže se
o nic nepřijde přepnutím mezi nimi.

### Aktualizace

Aplikace se **sama neaktualizuje** a ani nic nesestavuje při spuštění.

- `npm start` pouští zdrojové soubory přímo, takže stačí okno zavřít a spustit
  znovu — žádný build.
- `.app` v Aplikacích je snímek z chvíle sestavení. Po změnách ji vyměníte:

```bash
npm run install-app
```

Tenhle příkaz sestaví novou verzi a nahradí tu v `/Applications`. Aplikace
přitom nesmí běžet.

Automatické aktualizace by potřebovaly někde vystavené vydání (typicky GitHub
Releases) a `electron-updater`. Dokud je Charon jen pro tebe, je `install-app`
jednodušší.

## Správce relací

`⌘K` nebo tlačítko vlevo v liště. Strom složek, hledání podle názvu, serveru,
uživatele i poznámky, detail vybrané relace vpravo. Připojíte dvojklikem nebo
Enterem, šipkami se dá procházet rovnou z pole hledání. Sbalené složky si
aplikace pamatuje.

Rozbalovací seznam, který tu byl původně, stačil na pět relací; u sedmdesáti
ve dvaceti složkách se v něm nedalo nic najít.

Připojení, zakládání, úprava i mazání relací se odbývá tady, takže v liště
zůstalo jediné tlačítko, které správce otevře — na jeho popisku je vidět,
která relace je vybraná. Samostatná tlačítka *Připojit*, *＋ Relace*,
*Upravit* a *Smazat* zmizela; dělala podruhé to, co dialog.

**Duplikovat** vytvoří kopii včetně hesla — kopie se skládá v hlavním procesu,
protože do okna se hesla nikdy neposílají.

## Lišta

Zleva relace, pak přenos (nahrát, stáhnout, přenést s volbami), operace se
soubory (nová složka, přejmenovat, editor, smazat), panely (obnovit, porovnat,
souběžné procházení, hledání) a nástroje (synchronizace, hlídání složky,
příkazy na serveru). Vpravo nastavení.

Akce míří na panel, ve kterém stojíte — kromě nahrání a stažení, kde je směr
dán tlačítkem; kdyby se i ta ptala na aktivní panel, znamenalo by jedno
tlačítko pokaždé něco jiného. Co zrovna nejde, je zašedlé: bez spojení
zůstane přístupná jen lokální strana, bez výběru jen „nová složka".

Ikony jsou kreslené jako maska ve stejném zápisu jako ikony souborů
(rám 16 × 16, tah 1,4, kulaté rohy) — barvu berou z písma tlačítka, takže
v tmavém motivu zesvětlají a na zvýrazněném tlačítku zbělají samy. Tvary
jsou v `src/renderer/icons.css` jako proměnné `--i-*`, tlačítko si o ně
řekne přes `class="ibtn" data-icon="…"`. Kde se tvar opakuje (ozubené kolo,
okno terminálu), jen se přejmenuje, nekreslí podruhé.

Popisky u tlačítek jsou vypnuté a akci prozradí tooltip; zapnout je jde
v **Nastavení → Vzhled**. Do lišty se schválně nedostaly věci, které se dělají
jednou za čas (import z WinSCP, vysypání koše, vlastnosti), a věci vázané na
jednu stranu (zpět, vpřed, výš, domů, filtr, záložky cest) — ty zůstávají
v hlavičkách panelů.

## Záložky

Každé připojení má vlastní záložku a **nic se mezi nimi nesdílí** — vlastní
spojení pro procházení, vlastní zásobu spojení pro přenosy, vlastní frontu,
hlídání složky i soubory otevřené v editoru. Přenos v jedné záložce tak nemůže
spadnout kvůli tomu, co se děje v jiné, a přenosy vzadu běží dál. Že se v nich
něco děje, ukazuje počet u názvu záložky.

Vlastní je i lokální panel a historie cest, takže přepnutí vrátí obě strany
přesně tam, kde jste je nechali. Nová záložka přebírá lokální cestu z té,
ve které stojíte — obvykle se pracuje na jednom projektu a jen střídají servery.

| Klávesa | Akce |
| --- | --- |
| `⌘O` | Připojit v nové záložce |
| `⌘W` | Zavřít záložku |
| `⌃Tab` / `⌃⇧Tab` | Další / předchozí záložka |

Zavřít záložku s běžícími přenosy jde, ale aplikace se zeptá. Bez otevřené
záložky zůstává použitelný aspoň lokální panel.

## Import relací

Obojí je v **Nastavení → Relace**; v liště tlačítko nemají, protože se importuje
obvykle jednou a pak už nikdy.

### Z `~/.ssh/config`

Přirozenější zdroj pro Mac: vezmou se servery, uživatelé, porty, klíče
i brány (`ProxyJump`). Hesla tam nejsou — přihlašuje se klíčem.

Napodobujeme pravidla OpenSSH v rozsahu, který je k něčemu: platí **první**
nalezená hodnota (takže `Host *` funguje jako výchozí nastavení, ne jako
přepis), vzory se zástupnými znaky jsou šablony a samy se neimportují,
`Include` se načítá včetně hvězdičky v názvu. Bloky `Match` neumíme — jejich
podmínky nejde vyhodnotit bez skutečného spojení, tak se přeskakují.

### Z WinSCP

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

## Fronta přežije zavření aplikace

Nedokončené přenosy se ukládají průběžně, takže se o ně nepřijde, když se
aplikace zavře nebo spadne uprostřed nahrávání. Při dalším připojení ke stejné
relaci se Charon zeptá, jestli je má vrátit do fronty.

Pomáhá tomu i [přenos přes dočasný název](#přenos-přes-dočasný-název) —
rozepsaný `.filepart` na disku zůstane, takže se navazuje tam, kde se přestalo,
a nezačíná se od nuly. Když nabídku odmítnete, zapomene se; cílový soubor
zůstane nedotčený, protože nedokončený přenos se do něj ještě nepromítl.

## Když spojení spadne

Výpadek linky ani restart serveru neznamená, že se musíte připojovat ručně.
Charon to pozná, ohlásí to ve stavovém řádku a zkusí se připojit znovu —
třikrát, s prodlevou 1, 3 a 8 vteřin. Záložka i stavový řádek mezitím ukazují
*připojuji* (tečka u názvu pomalu bliká).

Když se to povede, rozdělaná fronta pokračuje dál a navazuje na to, co už se
přeneslo. Když ne, relace zůstane odpojená a připojíte se sami — opakovat to
donekonečna by jen zbytečně bušilo do serveru, který třeba záměrně neběží.

Zavřete-li záložku sami, nic se neobnovuje.

## Cesta k serveru — brána a proxy

Server, který není vidět z internetu, bývá dostupný přes jiný stroj. V dialogu
relace je na to sekce **Cesta k serveru** (jen SFTP; FTP potřebuje kromě
řídicího ještě datová spojení a ta by tudy neprošla):

| Nastavení | K čemu |
| --- | --- |
| Brána (jump host) | SSH stroj, přes který se protáhne spojení k cíli — obdoba `ssh -J` |
| Proxy SOCKS5 | Typicky firemní síť; podporuje i jméno a heslo |
| Proxy HTTP CONNECT | Totéž přes HTTP proxy |

Dá se to kombinovat: proxy vede k bráně, brána k cíli. Adresu cíle posíláme
proxy jménem, aby si ji přeložila sama — na vaší straně by se přeložit nemusela.

**Klíč brány se ověřuje stejně přísně jako klíč cíle.** Je to stroj, kterým jde
všechno ostatní, takže na něm záleží nejvíc; při prvním připojení se na jeho
otisk zeptáme zvlášť. Bez potvrzeného klíče se spojení neotevře.

Hesla k bráně i k proxy se ukládají zašifrovaná stejně jako ta ostatní.

## Pracovní plochy

**Okno → Pracovní plochy** (`⇧⌘O`) uloží sadu právě otevřených záložek i s tím,
v jaké složce jsou na obou stranách. Příště ji otevřete jedním kliknutím —
hodí se, když se pravidelně vracíte ke stejné skupině serverů.

Ukládají se jen záložky z uložených relací; u jednorázového připojení není co
otevřít. Když se některá relace nepřipojí, ostatní se otevřou i tak a řekne se,
kolik jich z kolika vyšlo.

## Kde se co ukládá

| Co | Kde |
| --- | --- |
| Relace | `~/Library/Application Support/charon/sites.json` |
| Nastavení a pracovní plochy | `~/Library/Application Support/charon/settings.json` |
| Nedokončená fronta | `~/Library/Application Support/charon/queue.json` |
| Šifrovací klíč k heslům | macOS Keychain, položka `Charon` |
| Dočasné soubory otevřené v editoru | `$TMPDIR/charon-edit/` |

Hesla se do `sites.json` zapisují zašifrovaná (AES-256-GCM); klíč leží
v Keychain, ne v souboru.

## Ikona

Vlastní, kreslená v `build/icon.svg`. Charon je převozník, který vozí duše přes
Styx — tedy přesně to, co aplikace dělá se soubory: bere je z jednoho břehu na
druhý. Proto loďka s postavou v kápi proti světlé obloze a modrá voda přes
spodní půlku. Všechno na siluetu, aby to bylo čitelné i ve 32 bodech, kde
z detailů stejně zbude jen tvar.

```bash
npm run icon
```

Vykreslí SVG do všech velikostí, které macOS chce, a složí `build/icon.icns`.
Rasterizérem je Chromium z Electronu — přidávat kvůli jedné ikoně další
závislost by bylo víc práce než užitku. Na Retině vrací snímek dvojnásobek
bodů, takže se výsledek ještě srovnává na přesnou velikost; `iconutil` na ní
trvá.

## Písmo a velikost

**Nastavení → Vzhled.** Písmo rozhraní a písmo pro cesty a výpisy se vybírají
z toho, co máte v systému; u druhého jsou nabídnutá jen neproporcionální
(poznají se změřením — v takovém písmu je „i" stejně široké jako „W").

Velikost písma platí pro **seznamy souborů**, kde na ní záleží nejvíc; výška
řádku se přizpůsobí sama. Zvětšit celé rozhraní jde přiblížením
(`⌘+`, `⌘−`, `⌘0`) — to je ostřejší a nic se nerozsype, protože se zvětší
všechno proporcionálně, ne jen text.

## Nastavení

Voleb je přes třicet, takže je dialog rozdělený na oddíly: Přenosy, Editor,
Vzhled, Panely, Síť, Relace. Formulář zůstává jeden a všechna pole v něm —
schovávají se jen oddíly, takže ukládání neřeší, co je zrovna vidět.

## Aktualizace

**Nastavení → Relace → Repozitář na GitHubu.** Zjistí se jen to, že je venku
novější vydání, a dostanete odkaz — nic se nestahuje ani neinstaluje;
automatická instalace by potřebovala podepsanou aplikaci. Dokud repozitář
nezadáte, nekontroluje se nic: předstírat kontrolu, když není kam se dívat,
je horší než ji nemít.

Verzi a na čem to běží ukáže **Charon → O aplikaci Charon**.

## Vzhled

**Nastavení → Vzhled → Motiv** nabízí *Podle systému* (výchozí), *Světlý*
a *Tmavý*. Volba platí i pro systémové dialogy, rám okna a posuvníky.

Barvy jsou v jednom bloku na začátku `styles.css` a každá je zapsaná jednou,
funkcí `light-dark()`. Přepnutí motivu je pak jediná vlastnost na `<html>`:
bez ní rozhoduje systém, s `data-theme` uživatel. Že se barva nezačne psát
natvrdo někde v pravidlech, hlídá `test/theme.test.js` — v tom druhém motivu
by se to projevilo jako nečitelné místo a všiml by si toho až uživatel.

## Ikony a typy souborů

Každá položka v panelu má ikonu podle toho, co to je — složka, obrázek, video,
archiv, zdrojový kód, klíč, nastavení. Typ se určuje z názvu: obsah bychom si
kvůli tomu museli z serveru stáhnout, a to u složky s tisíci soubory nepřipadá
v úvahu.

Rozhoduje `src/common/filekind.js`. Kromě přípony zná i soubory, které žádnou
nemají (`.htaccess`, `.env`, `Dockerfile`, `Makefile`), a případy, kde přípona
mate:

| Soubor | Škatulka | Proč |
| --- | --- | --- |
| `logo.svg` | obrázek | technicky je to značkovací jazyk, ale člověk čeká obrázek |
| `navrh.key` | prezentace | `.key` je Keynote; klíče bývají `.pem` nebo `.pub` |
| `index.php` | zdrojový kód | MIME má sice `application/…`, kód to je pořád |
| `vykaz.csv` | tabulka | otevírá se v tabulkovém procesoru, ne v editoru |
| `.env.local` | nastavení | odvozeniny `.local`, `.example` a spol. se poznají taky |

Stejný modul plní sloupec **Typ** v dialogu vlastností, kde je vidět i celý
MIME. Panel a vlastnosti se tak nemůžou rozejít v tom, co je co.

Ikony se kreslí jako maska, ne jako obrázek: tvar vezme z SVG a barvu dostane
z palety. Proto samy zesvětlají v tmavém motivu a zbělají na vybraném řádku,
aniž by musely existovat dvakrát. Na 924 položkách je vykreslení stejně rychlé
jako bez nich (16,5 vs. 16,6 ms) — dvacet různých tvarů si prohlížeč
dekóduje jednou.

## Rozlišení relací

V dialogu relace je sekce **Rozlišení relace**: barva a poznámka. Barva obarví
záložku i hlavičku serverového panelu, poznámka se v hlavičce vypíše. Se
záložkami, kde je otevřeno víc serverů naráz, je to nejlevnější pojistka proti
smazání něčeho na špatném stroji.

## Paměť výpisů

Návrat do složky, kterou jste právě viděli, je okamžitý. Uložený výpis platí
půl minuty a **jakýkoliv zápis na server ho zahodí celý** — přejmenování, mazání
i dokončený přenos. Zahazuje se schválně víc, než by bylo nutné: nejhorší, co se
tím stane, je jedno načtení navíc, kdežto zastaralý výpis vede k mazání souboru,
který už neexistuje. `⌘R` se paměti neptá nikdy. Vypnout se dá v nastavení.

## Hromadné přejmenování

Vyberte víc položek a v kontextovém menu zvolte hromadné přejmenování. Najít
a nahradit, volitelně regulárním výrazem, jen na jméně / jen na příponě / na
celém názvu, a `{n}` vloží pořadové číslo (od kolika, po kolika, na kolik míst).

Náhled se přepočítává při každé změně a **přejmenovat nejde, dokud v něm je
konflikt**: dva soubory pod stejným názvem, lomítko v názvu nebo název, který
už ve složce je. Přejmenování je nevratné, takže se radši nedělá nic.

Kroky se navíc řadí tak, aby se nic nepřepsalo ani při posunu názvů
(`1 → 2` a zároveň `2 → 3`): kolidující soubor se nejdřív odklidí pod dočasný
název. Z rozhraní se takový případ vyrobit skoro nedá, ale modul počítá plán
pro kohokoliv, kdo ho použije.

## Terminál

V kontextovém menu panelu je **Otevřít Terminál zde**. Lokálně se otevře
v dané složce. U serveru se sestaví příkaz `ssh` (včetně portu, klíče a brány)
a **vloží se do schránky** — spustit ho za vás by znamenalo psát příkazy do
cizího shellu a heslo bychom tam stejně nedostali. Název složky se uzavírá do
apostrofů; že z něj nemůže vzniknout příkaz, hlídá `test/terminal.test.js`
skutečným `/bin/sh`.

## Drobné operace na serveru

V kontextovém menu serverového panelu:

- **Duplikovat na serveru** — kopie bez stahování. Zkusí se `cp` přes shell,
  takže data server vůbec neopustí. Když shell není k dispozici (nebo je SFTP
  uzavřené v jiném kořeni než shell), kopie proteče přes tento počítač a řekne
  se to.
- **Vytvořit odkaz** — symbolický odkaz. Jen SFTP; FTP na to nemá příkaz.
- **Změnit čas změny** — ruční nastavení razítka, i pro víc položek naráz.

## Editor podle přípony

V **Nastavení → Editor** se dají zapsat pravidla `maska = aplikace` oddělená
svislítkem, třeba `*.png; *.jpg = Preview | *.sql = TablePlus`. Platí první,
které sedne, takže obecné patří nakonec. Bez pravidla se použije výchozí
editor; bez něj rozhodne systém — u obrázku nebo PDF je to jediné rozumné.

## Keepalive a timeouty

**Nastavení → Síť**. Keepalive drží spojení při nečinnosti; `0` ho vypne.
Některé servery ho totiž nesnesou a spojení kvůli němu naopak zavřou — když
vám relace padá právě při nečinnosti, zkuste nulu.

Aktivní režim FTP (`PORT`/`EPRT`) Charon **neumí**: knihovna, na které stojí
FTP, implementuje jen pasivní režim. Anonymní přihlášení zaškrtnete u relace.

## Porovnání panelů a synchronizované procházení

**⇄ Porovnat** (`⌘D`) obarví u kraje řádku, co se liší proti druhé straně:
zelená je novější tady, oranžová starší, modrá tu je navíc. Jen v aktuální
složce — do hloubky je od toho synchronizace. Barvou se schválně nesahá na
text; ten už nese význam podle typu souboru.

**⇉ Synchronizované procházení** (`⌘Y`) udělá tentýž krok i v druhém panelu.
Mirroruje se jen vstup do podsložky a návrat o úroveň výš; u skoku někam
jinam by se druhá strana ocitla na cestě, která s ní nemá nic společného.
Když protějšek neexistuje, řekne se to a druhá strana zůstane, kde byla.

## Adresa relace

`⌘L` otevře připojení z adresy typu `sftp://uzivatel@server:2222/var/www`.
Relace se nikam neukládá, je to jednorázové připojení. Schéma se dá vynechat
(předpokládá se SFTP), heslo v adrese se použije.

Opačně: **Kopírovat adresu této složky** v kontextovém menu serverového panelu.
**Heslo se do zkopírované adresy nikdy nedostane** — taková adresa se často
ocitne v chatu nebo v ticketu, kde už zůstane.

## Profily nastavení přenosu

V dialogu ⇧F5 se dá vybrat pojmenovaný profil: maska, „jen nové a změněné",
práva nahraných souborů a textový režim. Profil platí **jen pro ten jeden
přenos** — nastavení aplikace nemění. Jinak by se jednorázová odchylka
(„na tenhle server nahraj s právy 755") tiše stala trvalou a projevila by se
příště úplně jinde.

Profily nepřežijí obnovení fronty po restartu: nedokončeným položkám se
ukládá cesta a postup, ne volby, se kterými byly zařazené.

## Záznam komunikace

**Nastavení → Editor → Zaznamenávat komunikaci se serverem.** Ve stavovém
řádku je vidět závěr, v záznamu celý rozhovor — u serveru, který se chová
divně, je to jediné, co pomůže.

Hesla se do záznamu nedostanou (`PASS` se zkracuje, stejně tak heslo v adrese).
Soubor je jeden na den, leží v `~/Library/Application Support/charon/logs/`
a nad 5 MB se odloží stranou.

## Klávesové zkratky

| Klávesa | Akce |
| --- | --- |
| `F5` | Zkopírovat vybrané do druhého panelu |
| `⇧F5` | Přenést s volbami (cíl a maska) |
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
| `⌘U` | Hlídat složku a nahrávat změny |
| `⌘L` | Příkazy na serveru |
| `⌘I` | Vlastnosti vybraného |
| `⌘O` | Připojit v nové záložce |
| `⌘W` | Zavřít záložku |

## Editace se zpětným nahráním

Dvojklik na vzdálený soubor (nebo `F4`) ho stáhne do dočasné složky, otevře
v editoru a hlídá. Při každém uložení se sám nahraje zpět na server — bez
dalšího kliknutí.

Před nahráním se ale ověří, že se soubor na serveru mezitím nezměnil. Když do
něj sáhl někdo jiný, Charon se zeptá a **ve výchozím stavu nenahraje** —
zahodit cizí změnu je horší než neuložit vlastní. Když se stav zjistit nedá
(server nehlásí čas, spadlo spojení), ukládá se bez ptaní; jinak by se
u takového serveru nedalo uložit vůbec nic. V **Nastavení** si můžete zvolit editor (např.
`Visual Studio Code`); prázdné pole znamená výchozí aplikaci podle přípony.

## Souběžné přenosy

Ve výchozím stavu běží **3 přenosy naráz**, každý přes vlastní spojení
(*Nastavení → Přenosy*, 1 až 16). Je to znát hlavně u spousty malých souborů,
kde rozhoduje latence, ne šířka pásma — při odezvě 20 ms je čtyřnásobná
souběžnost v testech asi **4× rychlejší**. Na rychlé lince s jedním velkým
souborem rozdíl nečekejte.

Servery počet spojení z jedné adresy často omezují. Když další nepovolí,
Charon se sám zmenší na to, co prošlo, napíše to do stavového řádku a pokračuje
— přenosy kvůli tomu neselžou.

## Přenos přes dočasný název

Soubor se přenáší pod jménem `<název>.filepart` a na cílové se **přejmenuje až
po dokončení**. Do té chvíle zůstává původní soubor nedotčený — na živém webu
tak návštěvník nikdy netrefí poloviční PHP soubor. Stejná přípona jako ve
WinSCP, takže je i z jiného klienta na první pohled vidět, co se stalo.

Přejmenování se dělá přes rozšíření `posix-rename@openssh.com`, které cíl
nahradí jedním krokem a bez okamžiku, kdy soubor neexistuje. Když ho server
nemá, zbývá smazat a přejmenovat.

Co se stane při přerušení:

| Situace | Rozepsaný soubor |
| --- | --- |
| **Pauza** | zůstane — je z čeho navázat |
| **Chyba** | zůstane — opakování na něj naváže |
| **Zrušení** | uklidí se, aby po sobě nenechal nepořádek |

Cizí rozepsaný soubor z dřívějška se nikdy nepoužije mlčky. Dialog při přepisu
navázání **nabídne** (a počítá s velikostí rozepsaného souboru, ne hotového
pod cílovým jménem), ale rozhodnutí necháme na vás — mohl by pocházet z jiné
verze zdroje.

Vypnout jde v *Nastavení → Přenosy*; tam se dá nastavit i spodní hranice
velikosti. Přejmenování je jedno kolo navíc na soubor, takže u tisíců drobných
souborů přes pomalou linku se vyplatí ho pro ně přeskočit.

## Víc spojení na jeden soubor

**Nastavení → Přenosy → Víc spojení na jeden soubor od (MB).** Velký soubor si
rozdělí víc spojení mezi sebe, každé stahuje svůj úsek do jednoho souboru na
svou pozici. Výchozí je vypnuto (`0`).

Má to smysl, když server škrtí jeden proud, ale celkem pustí víc — což je na
sdíleném hostingu běžné. Změřeno proti serveru s odezvou 12 ms: 8 MB jedním
spojením 5,3 s, čtyřmi 1,4 s, tedy **3,7× rychleji**. Na místní síti se
nezmění nic.

Zatím jen **stahování přes SFTP**; FTP by na to potřebovalo pro každý úsek
zvlášť řídicí spojení a odstřelovat přenos po přečtení N bajtů, což je křehké.

Tři věci, které z toho plynou:

- Spojení navíc se berou, **jen když jsou volná**. Kdyby se na ně čekalo, vzal
  by si segmentovaný přenos to, co potřebuje jiná položka fronty, a fronta by
  uvázla sama o sobě. Když nezbývá nic, teče to jedním proudem.
- **Přenáší se vždycky přes dočasný název**, i když je jinak vypnutý. Kdyby
  jeden úsek selhal, zůstal by na cíli soubor správné velikosti s dírou
  uvnitř — a to se pozná až při použití.
- **Nenavazuje se.** Dokud přenos nedojede, je v souboru díra a z velikosti se
  nic nepozná. Nejde to dohromady ani s textovým režimem, protože úseky by se
  rozešly na hranicích převodu.

## Odhad zbývajícího času

Fronta hlásí, kolik toho zbývá a jak dlouho to potrvá. Rychlost se měří jako
průtok celé fronty v posuvném okně osmi vteřin — rychlost jednotlivé položky je
průměr od jejího začátku, takže po dokončení ze součtu zmizí a odhad by poskočil.

Když u některé položky neznáme velikost, odhad se neukáže a napíše se, kolika
položek se to týká. Odhad, který nemůže vyjít, je horší než žádný.

## Práva nahraných souborů

Volby jsou tři: nechat na serveru (výchozí), nastavit pevně, nebo zachovat
lokální. Soubory a složky se nastavují každé zvlášť — u složek zachovávat není
co, vznikají až na serveru, takže se řídí pevnou hodnotou vedle.

Nastavit je jde na třech místech a **dědí se odshora dolů**:

| Kde | Platí pro | Prázdné znamená |
| --- | --- | --- |
| **Nastavení → Přenosy** | všechny servery | nechat na serveru |
| **relace → Práva nahraných souborů** | jeden server | platí nastavení aplikace |
| **Přenést s volbami** | jednu dávku | platí relace, pod ní nastavení |

Dědí se po jednotlivých polích, ne po celé trojici. Relace tedy může předepsat
jen práva složek a práva souborů nechat na obecném nastavení; jeden přenos zase
může přebít jen práva souborů. Dialog *Přenést s volbami* pod poli píše, co
zrovna platí a odkud to je.

Ve **Vlastnostech** vybrané položky na serveru se zadává jedno číslo — práva
souborů — a složky se od něj odvozují volbou **Složkám přidat spouštění**:
644 → 755, 640 → 750, 664 → 775. Spouštění u složky znamená „smí se do ní
vstoupit", takže hromadné `chmod -R 644` na celý web je přesně ten způsob, jak
si ho zamknout; proto je volba zapnutá. Se zaškrtnutím **Použít i na podsložky
a soubory uvnitř** se tím jedním zadáním přenastaví celý strom.

Pole pro složky se ukazuje jen tam, kde má co dělat: u vybraného souboru
žádná volba pro složky není, u samotné složky bez rekurze je zadané číslo
přímo její.

Osmičkový zápis je všude doprovázený zaškrtávací mřížkou (vlastník / skupina /
ostatní × čtení / zápis / spouštění) a pod ní zápisem, jak ho ukazuje panel —
`rwxr-xr-x`. Obojí je tatáž hodnota: kdo umí `755`, napíše ho, kdo ne, zaškrtá.
Prázdné pole zůstává prázdné, dokud se do mřížky neklikne; zvláštní bity
(setuid, setgid, sticky) mřížka nenabízí, ale když je v poli někdo má, zůstanou
tam. Totéž ovládání je i ve **Vlastnostech** vybraného souboru na serveru.

Práva se nastavují až na konečné cestě, aby to dopadlo stejně s dočasným názvem
i bez něj. Týkají se jen nahrávání — při stahování rozhoduje místní systém, a
proto se v dialogu při stahování ani nenabízejí. Když je server nastavit neumí
(starší FTP bez `SITE CHMOD`), přenos kvůli tomu neselže a jen se to připíše
k položce.

Změna práv u otevřené relace platí hned, na příští připojení se nečeká.

## Textový režim

**Nastavení → Přenosy → Textový režim**: maska souborů, kterých se to týká,
a jaké konce řádků má mít soubor na serveru. Při stažení se sjednocuje vždycky
na `LF` (konvence macOS), při nahrání podle volby.

Skript s `CRLF` se na Unixu neprovede a `.bat` s `LF` zase na Windows —
tohle je jediný způsob, jak to řešit jinak než ručně.

Dvě věci, které z toho plynou:

- **Navazování přerušeného přenosu se v textovém režimu nepoužije.** Po převodu
  neodpovídá počet bajtů zdroji, takže „dopiš od pozice N" by soubor rozsypalo.
  Soubor se radši přenese celý.
- Soubor má na druhé straně jinou velikost, proto se u něj *jen nové a změněné*
  neřídí velikostí, ale jen časem změny. Jinak by se přenášel pořád dokola.

Binární soubory, které se do masky připletou, se nepoškodí: osamocené `CR` se
nemaže a žádný jiný bajt se nemění. Ale masku je stejně lepší psát úzce.

## Záloha před přepsáním

Koš na serveru řeší mazání, tohle přepis — druhý způsob, jak přijít o data,
a na rozdíl od mazání se děje bez ptaní pokaždé, když nahrajete novější verzi.
V **Nastavení → Přenosy** se dá zvolit odložení vedle jako `.bak-datum`, nebo
přesun do koše na serveru.

Záloha se dělá jen při plném nahrání; při navazování rozepsaného přenosu ne —
tam už je stejně přepsáno. Když se nepovede, přenos kvůli tomu neselže a jen
se to připíše k položce.

## Po dokončení fronty

Vpravo v hlavičce fronty je volba **Po dokončení**: nic, upozornit, odpojit,
uspat Mac. Rozhoduje se o ní ve chvíli, kdy se pouští velký přenos, proto je
u fronty a ne schovaná v nastavení.

Odpojení ani uspání se neprovede, když něco selhalo — po chybě chce člověk
vidět, co se stalo, ne najít ráno uspaný počítač.

## Omezení rychlosti

Nastavuje se v *Nastavení → Přenosy* v kB/s, nebo pravým tlačítkem na položku
ve frontě. Globální limit platí **dohromady pro všechny běžící přenosy**, ne na
každý zvlášť — zadáváte, kolik smí Charon ubrat z linky. Položka může mít navíc
vlastní limit; pak platí oba a rozhoduje ten přísnější.

Model je „děravý kbelík" se zásobou na jednu sekundu dopředu, takže po chvíli
nečinnosti přenos nevystřelí na několikanásobek limitu.

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

### Masky u přenosů

Na složky se schválně uplatní **jen výluky**. Kdyby platilo i zahrnutí, maska
`*.php` by zakázala vstup do každé podsložky a rekurzivní přenos by nenašel nic.
Vyloučit `.git/` naopak smysl dává.

Maska platí i na položky, které jste označili ručně. Když je ve výluce
`node_modules/`, nenahraje se, ani když ji vyberete a zmáčknete F5 — jinak by
se na masku nedalo spolehnout.

Kolik položek maska vynechala, se **vždycky napíše do stavového řádku**. Tiché
vynechání by vypadalo, jako by se přeneslo všechno.

Maska se nastavuje na třech místech:

| Kde | Platnost |
| --- | --- |
| **Nastavení → Přenosy** | výchozí pro každé F5 a přetažení |
| **⇧F5** (Přenést s volbami) | jen pro ten jeden přenos, volitelně se uloží jako výchozí |
| **Dialog synchronizace** | jen pro to porovnání |

U synchronizace platí maska na obě strany. Kdyby platila jen na jednu, soubory
vyloučené vlevo by se vpravo tvářily jako přebytek k smazání.

U **přesunu (F6)** se výchozí maska záměrně nepoužívá — vynechaný soubor by
zůstal na zdroji a člověk by si myslel, že přesunul všechno.

## Hledání souborů na serveru

`⌘F` v pravém panelu (nebo *Soubor → Najít soubory na serveru*) projde strom od
zadané cesty a hledá podle masky. Nálezy přibývají průběžně, takže se dá začít
pracovat dřív, než hledání doběhne, a kdykoliv ho jde zastavit. Z výsledků se dá
rovnou stahovat, otevřít soubor v editoru nebo skočit na jeho místo v panelu.

Hledání se zastaví na 5000 nálezech a hloubce 40 úrovní — obojí je pojistka
proti překlepu v masce, ne technický limit.

## Vlastnosti souboru

`⌘I` nebo *Vlastnosti…* v kontextové nabídce serverového panelu. Ukáže velikost,
čas, práva, vlastníka a skupinu; umí je i změnit.

Práva se zadávají zvlášť pro **soubory** a zvlášť pro **složky**. Není to
zbytečné rozlišování: `644` na složce by ji znepřístupnilo, takže vedle sebe
patří `644` a `755`. Prázdné pole znamená „neměnit". Rekurzivní použití se
před spuštěním ptá.

Vlastník a skupina se u SFTP zadávají čísly (UID a GID) — jména protokol nezná.

Kontrolní součet se počítá **na serveru** příkazem (`sha256sum`, `shasum`,
`md5sum` — zkouší se postupně), takže se nemusí nic stahovat. U FTP se zkusí
`XMD5`/`XCRC`, které ale spousta serverů nemá; pak to Charon řekne.

## Příkazy na serveru

`⌘L` otevře konzoli: napíšeš příkaz, uvidíš výstup i návratový kód. Šipkami
nahoru a dolů se prochází historie. Funguje **jen přes SFTP** — FTP shell nemá
a Charon to rovnou řekne, místo aby se tvářil, že se nic nestalo.

Každý příkaz běží v samostatném neinteraktivním shellu, takže `cd` mezi příkazy
nedrží. Pracovní adresář se proto vkládá před příkaz a bere se z pravého panelu
— jinak by všechno běželo v domovském adresáři, což je proti očekávání člověka,
který kouká na otevřenou složku.

## Vlastní příkazy

*Soubor → Vlastní příkazy…* Pojmenované příkazy nad vybranými soubory, které se
pak objeví v kontextové nabídce panelu. Běží buď na serveru, nebo na tomhle
počítači.

| Zápis | Význam |
| --- | --- |
| `!` | cesta k vybranému souboru |
| `!N` | název souboru bez cesty |
| `!&` | všechny vybrané soubory |
| `!/` | vzdálený adresář |
| `!\` | lokální adresář |
| `!?Otázka?výchozí!` | zeptá se před spuštěním |
| `!!` | samotný vykřičník |

Volba *Spustit zvlášť pro každý vybraný soubor* spustí příkaz tolikrát, kolik
je vybraných položek; jinak proběhne jednou se všemi.

**Dosazené hodnoty se samy uzavírají do apostrofů**, takže vlastní uvozovky
psát nemusíte. Je to hlavně pojistka: název souboru si nevybírá ten, kdo příkaz
psal, a soubor pojmenovaný `a; rm -rf ~` se nesmí stát částí příkazu. Na to je
zvláštní test proti skutečnému shellu.

Příklady:

```
grep -n !?Co hledat?TODO! !N        # najde v souboru, zeptá se na co
tar czf zaloha.tgz !&               # zabalí všechny vybrané
php -l !                            # zkontroluje syntaxi
open !\                             # otevře lokální složku ve Finderu
```

## Hlídání složky

`⌘U` nebo *Soubor → Hlídat složku a nahrávat změny*. Charon sleduje lokální
strom a každou změnu rovnou nahraje — uložíš soubor v editoru a je nahoře.
Ve WinSCP se tomu říká *Keep remote directory up to date*.

Volba **Nejdřív srovnat, co se liší** projede obě strany a dorovná rozdíly,
než se začne hlídat. Bez ní se nahrává jen to, co se změní potom.

Platí tu maska, takže `.git/` a `node_modules/` se dají vyloučit. Rozepsané
soubory `.filepart` se ignorují vždycky — vznikají při stahování do hlídané
složky a nahrát je zpátky by byl kolotoč.

**Mazání na serveru je ve výchozím stavu vypnuté.** Hlídání běží na pozadí bez
potvrzování a smazaný soubor je nevratná věc, takže tohle rozhodnutí má padnout
vědomě. Když ho zapnete, smazané položky jdou do koše na serveru — pokud ho má
relace zapnutý; jinak zmizí nenávratně a aplikace na to před spuštěním upozorní.

Že něco běží na pozadí, je vidět ve stavovém řádku i v samotném dialogu,
včetně počtu nahraných souborů a poslední akce.

## Synchronizace

Porovná lokální a vzdálený strom a **nejdřív ukáže seznam akcí** — teprve po
potvrzení se cokoliv přenese. Směr může být jednosměrný i obousměrný, porovnávat
lze podle času, velikosti nebo obojího. Mazání je volitelné a před provedením se
na něj aplikace ještě jednou zeptá.

Směr, kritérium, maska i mazání se **pamatují u relace** — naklikává se pořád
totéž, tak proč pokaždé znovu. Ukládá se při porovnání a platí jen pro uložené
relace; u jednorázového připojení není kam. Cesty se nepamatují schválně: ty
určují panely, ve kterých zrovna stojíte, a předvyplnit je odjinud by znamenalo
synchronizovat něco jiného, než na co se díváte.

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

## Testovací servery

Na zkoušení bez zásahu do skutečných serverů:

```bash
npm run servers
```

Spustí dva servery na localhostu — jeden SFTP a jeden FTP, protože se každý
chová jinak (FTP nemá shell, hlásí čas jen na minuty, neumí změnu vlastníka):

| | Adresa | Přihlášení | Data |
| --- | --- | --- | --- |
| SFTP | `127.0.0.1:2222` | `test` / `test` | `test-data/sftp/` |
| FTP | `127.0.0.1:2121` | `test` / `test` | `test-data/ftp/` |

Vzdálený adresář je `/www`, obsah zůstává mezi spuštěními. V Charonovi jsou
připravené relace **Test SFTP (localhost)** a **Test FTP (localhost)** ve složce
*Testovací*. Servery poslouchají jen na `127.0.0.1`.

Při prvním připojení k SFTP se objeví dialog s otiskem klíče — je to ten
z `test/fixtures/host_key`, takže ho můžete potvrdit.

## Testy

```bash
npm test
```

- `test/winscp-import.test.js` — dekódování hesel WinSCP, parsování `.ini` i `.reg`
- `test/mask.test.js` — zápis masek souborů
- `test/theme.test.js` — světlý a tmavý motiv: že se barvy píšou jen v paletě,
  že má každá obě podoby a že volba přebije systém v obou směrech
- `test/filekind.test.js` — rozpoznání typu souboru. Hlídá hlavně případy, kde
  přípona mate, a to, že každá škatulka má nakreslenou ikonu — bez pravidla ve
  stylu by položka dostala výchozí ikonu a nikdo by si toho nevšiml
- `test/eta.test.js` — odhad zbývajícího času proti skutečnému přenosu se
  známou rychlostí; ověřuje se i to, že na pauze a při stojícím přenosu odhad
  zmizí místo aby zamrzl na poslední hodnotě
- `test/uploadperms.test.js` — práva nahraných souborů. Kontroluje se, co má
  soubor na druhé straně, ne že jsme zavolali chmod; a že přenos nepadá, když
  server chmod neumí
- `test/sshconfig.test.js` — čtení `~/.ssh/config`. Hlavně pravidlo „první
  hodnota vyhrává", vzory, `ProxyJump` a `Include` včetně kruhového odkazu
- `test/listcache.test.js` — paměť výpisů: platnost, zahazování a to, že se
  nezahodí zrovna složka, kterou člověk právě používá
- `test/siteprofile.test.js` — nastavení synchronizace uložené u relace;
  hlavně že ho nesmaže úprava relace
- `test/syncmodes.test.js` — režimy synchronizace. Testuje se hlavně to, co se
  přenést **nesmí**: „jen novější" nesmí přepsat čerstvější soubor na cíli
  a „jen srovnat časy" nesmí sáhnout na obsah ani nic smazat
- `test/queueorder.test.js` — řazení fronty a pozastavení jedné položky;
  hlavně že ji společné „Pokračovat" nerozeběhne
- `test/ftpquirks.test.js` — kódování názvů a časový posun proti skutečnému
  FTP serveru, včetně toho, že se posun netýká času z `MDTM` (ten je v UTC)
- `test/rename.test.js` — plán hromadného přejmenování: kolize, prázdné názvy
  a pořadí kroků, ve kterém se nic nepřepíše
- `test/terminal.test.js` — uzavírání cesty do apostrofů. Ověřuje skutečný
  `/bin/sh`, že ze složky `'; touch OVLADNUTO` vznikne argument, ne příkaz
- `test/eol.test.js` — převod konců řádků, hlavně na hranicích mezi kusy dat:
  když jeden skončí `CR` a další začne `LF`, patří k sobě. Testuje se i po
  jednotlivých bajtech
- `test/textmode.test.js` — textový režim při skutečném přenosu: že se použije
  jen na masku, že se u něj nenavazuje a že binární soubor přežije
- `test/backup.test.js` — záloha před přepsáním; hlavně že selhání zálohy
  nezastaví přenos a že u nového souboru není co zálohovat
- `test/queuedone.test.js` — akce po dokončení fronty. Testuje se hlavně, kdy
  se hlásit **nemá**: po prázdném kliknutí a na pauze
- `test/fileops.test.js` — kopie, odkaz a ruční čas proti skutečnému serveru,
  včetně záskoku, když shell cestu nevidí
- `test/network.test.js` — keepalive, timeouty a anonymní přihlášení; nula
  musí opravdu vypínat, ne se spolknout jako „nezadáno"
- `test/urlsession.test.js` — adresa relace tam i zpět; hlavně že se heslo
  nikdy nedostane do adresy ke zkopírování
- `test/profiles.test.js` — profily přenosu. Podstatné je, že profil nemění
  nastavení aplikace — jinak by se jednorázová odchylka stala trvalou
- `test/sessionlog.test.js` — záznam komunikace: že v něm je, co má být,
  a že v něm není heslo
- `test/segmented.test.js` — přenos víc spojeními. Skládat soubor z kusů je
  nejrychlejší způsob, jak ho tiše poškodit, takže se všechno kontroluje
  otiskem proti zdroji — a hlavně se ověřuje, co se stane, když jeden úsek
  selže nebo když spojení navíc nejsou
- `test/version.test.js` — porovnávání verzí. Textově by `1.10.0` vyšlo starší
  než `1.9.0` a beta by se vnucovala uživateli finální verze
- `test/dialogs.test.js` — stavba dialogů: že lišta tlačítek je uvnitř
  formuláře. Tlačítko mimo něj vypadá stejně a nedělá vůbec nic
- `test/session.test.js` — správce záložek: pořadí, přepínání a úklid
- `test/editconflict.test.js` — detekce cizí změny při ukládání z editoru
- `test/properties.test.js` — rekurzivní práva a kontrolní součty proti
  skutečnému `sha256sum`
- `test/queue-store.test.js` — co z fronty přežije zavření aplikace a co ne
- `test/netpath.test.js` — proxy a SSH brána proti skutečné proxy (napsané
  v testu podle RFC) a skutečné bráně. Hlídá se hlavně to, že se bez ověřeného
  klíče brána neotevře — bez toho by tunel nechránil před ničím
- `test/reconnect.test.js` — obnovení spojení proti serveru, který se opravdu
  vypne a zase zapne. Ověřuje se i to, na co se nesmí reagovat: vlastní zavření
  záložky se neobnovuje a dva pokusy naráz se nepřekrývají
- `test/commands.test.js` — doplňování šablon a spouštění příkazů. Uzavírání do
  apostrofů se ověřuje i doopravdy: soubor pojmenovaný `a; touch HACKED` se
  přečte jako soubor a nic navíc nevznikne
- `test/safety.test.js` — otisky klíčů a `known_hosts`, odmítnutí neověřeného
  serveru, všechny volby při konfliktu, přesun a chování koše
- `test/browse.test.js` — dopočítání velikosti složek a hledání souborů
- `test/transfer-mask.test.js` — masky u přenosů a synchronizace, včetně toho,
  že vyloučená složka neprojde ani jako ručně vybraný kořen
- `test/tempname.test.js` — přenos přes dočasný název; hlavně to, že cílový
  soubor zůstane během přenosu nedotčený
- `test/watcher.test.js` — hlídání složky. U automatiky je stejně důležité,
  na co nereaguje: bez výslovného zapnutí nesmí nic smazat a rozepsané soubory
  nesmí nahrávat dokola
- `test/parallel.test.js` — souběžné přenosy, zásoba spojení a omezení
  rychlosti. Rychlost se měří proti hodinkám, ne proti počítadlu omezovače;
  zrychlení souběžností se ověřuje proti serveru s umělou latencí, protože
  na loopbacku by se neprojevilo
- `test/e2e.test.js` — SFTP: přenosy, pauza, navázání, chmod a synchronizace proti
  dočasnému SFTP serveru z `test/sftp-server.js`
- `test/ftp.test.js` — FTP: totéž proti dočasnému FTP serveru, včetně navázání
  přes `REST`/`APPE` a parsování časů z textového výpisu
- `test/ftps.test.js` — FTPS: potvrzování otisku certifikátu a hlavně kontrola,
  že se při nepotvrzeném certifikátu heslo na server vůbec neodešle

Testovací SSH klíč a certifikáty v `test/fixtures/` slouží **jen k testům** —
servery běží na `127.0.0.1` na náhodném portu a nikam se nepublikují.
