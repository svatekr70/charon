//
//  Vykreslí ikony Charonu ze systémové sady SF Symbols.
//
//  Spouští se ručně přes `npm run icons`, ne při sestavení — výsledné PNG
//  jsou v repozitáři a Xcode ani Swift nejsou k překladu aplikace potřeba.
//
//  Kreslí se do PNG s alfa kanálem, protože z SF Symbols se vektor ven
//  dostat nedá: symboly jsou zamčené v Assets.car a i `NSImage.draw` do PDF
//  z nich udělá bitmapu. Aplikaci to nevadí — ikony se stejně používají jako
//  maska, takže tvar nese průhlednost a barvu určuje `--icon-color` v CSS.
//  Kreslí se proto bíle: barevný kanál nikdo nečte.
//
//  Všechny symboly jdou do stejně velkého čtverce a při stejné velikosti
//  písma. To je důležité — kdyby se každý ořízl na svůj vlastní obrys,
//  tenká šipka by se roztáhla na velikost složky a sada by přestala držet
//  pohromadě. Takhle zůstanou poměry přesně takové, jak je Apple navrhl.
//
//  Kreslí se s velkou rezervou (viz `strana`), aby ikony zůstaly ostré i po
//  přiblížení okna (⌘+) na sítnicovém displeji.
//

import AppKit

let velikostPisma: CGFloat = 88      // v bodech; určuje tloušťku tahu vůči tvaru
let strana = 128                     // hrana čtvercového PNG v pixelech
// Hrana pomyslného rámečku, do kterého se sada vejde celá. Je schválně
// větší než běžný symbol (medián je kolem 107): kdyby se normalizovalo na
// medián, musely by se ty rozmáchlejší tvary (`</>`, oko, zástrčka) zmenšit
// jednotlivě, a tím by se rozbily poměry, které Apple pečlivě vyvážil.
// Takhle projdou všechny jedním měřítkem a v rámečku zbude po stranách
// volno. To se dorovná v CSS: maska se kreslí větší než 16 px, protože
// běžný symbol vyplní jen zhruba tři čtvrtiny hrany. Roste s váhou tahu:
// v `.semibold` jsou symboly o pár procent větší než v `.regular`, takže
// se rámeček musel zvětšit s nimi — jinak by se nejširší z nich ořízly.
let normal: CGFloat = 152
let cil = "src/renderer/icons"

// Jméno ikony v Charonu -> jméno symbolu v systému.
// Pořadí kopíruje icons.css, ať se to dá porovnávat vedle sebe.
let mapa: [(String, String)] = [
  // --- soubory a složky ---
  ("folder", "folder"),
  ("up", "arrow.up.left"),
  ("link", "link"),
  ("file", "doc"),
  ("text", "doc.plaintext"),
  ("image", "photo"),
  ("video", "film"),
  ("audio", "music.note"),
  ("archive", "archivebox"),
  ("disk", "opticaldiscdrive"),
  ("code", "curlybraces"),
  ("markup", "chevron.left.forwardslash.chevron.right"),
  ("style", "paintbrush"),
  ("data", "cylinder.split.1x2"),
  ("config", "gearshape"),
  ("pdf", "doc.richtext"),
  ("doc", "doc.text"),
  ("sheet", "tablecells"),
  ("slides", "rectangle.on.rectangle"),
  ("font", "textformat"),
  ("exe", "terminal"),
  ("key", "key"),

  // --- relace ---
  ("sites", "server.rack"),
  ("connect", "cable.connector"),
  ("disconnect", "cable.connector.slash"),
  ("newtab", "plus.rectangle"),
  ("workspaces", "square.stack.3d.up"),
  ("openurl", "globe"),
  ("import", "square.and.arrow.down"),

  // --- přenos a fronta ---
  ("upload", "arrow.up.circle"),
  ("download", "arrow.down.circle"),
  ("move", "arrow.up.forward.square"),
  ("transfer-opts", "slider.horizontal.3"),
  ("queue", "list.bullet.rectangle"),
  ("pause", "pause"),
  ("resume", "play"),
  ("cancel", "xmark.circle"),

  // --- soubory ---
  ("newfolder", "folder.badge.plus"),
  ("newfile", "doc.badge.plus"),
  ("rename", "character.cursor.ibeam"),
  ("edit", "pencil"),
  ("duplicate", "doc.on.doc"),
  ("delete", "trash"),
  ("properties", "info.circle"),
  ("mask", "viewfinder"),
  ("emptytrash", "trash.fill"),

  // --- panely ---
  ("refresh", "arrow.clockwise"),
  ("compare", "rectangle.split.2x1"),
  ("syncbrowse", "arrow.left.arrow.right"),
  ("filter", "line.3.horizontal.decrease"),
  ("find", "magnifyingglass"),
  ("hidden", "eye"),
  ("bookmark", "bookmark"),
  ("home", "house"),
  ("levelup", "arrow.up.to.line"),
  ("back", "arrow.left"),
  ("fwd", "arrow.right"),

  // Chybí tu schválně `terminal`, `settings`, `eye` a `browse`: v icons.css
  // jsou zkratkou na jiný tvar, takže by to byly jen kopie souboru navíc.

  // --- nástroje ---
  ("sync", "arrow.triangle.2.circlepath"),
  ("watch", "antenna.radiowaves.left.and.right"),
  ("shell", "apple.terminal"),
  ("commands", "play.rectangle"),

  // --- přenos mezi panely ---
  ("copy-right", "arrow.right.square"),
  ("copy-left", "arrow.left.square"),
  ("move-right", "arrow.right.to.line"),
  ("move-left", "arrow.left.to.line"),
  ("reveal", "arrow.up.forward.square"),

  // --- drobnosti ---
  ("eye-off", "eye.slash"),
  ("caret", "chevron.down"),
]

// Váha tahu. `.regular` vypadá vedle zbytku rozhraní tence — ručně kreslená
// sada, co tu byla předtím, měla tah 1,4 bodu na rám 16, což je poznat.
// `.semibold` tomu odpovídá; `.bold` už některé tvary (dům, složka) zaplácne.
let cfg = NSImage.SymbolConfiguration(pointSize: velikostPisma, weight: .semibold, scale: .medium)

func symbol(_ jmeno: String) -> NSImage? {
    NSImage(systemSymbolName: jmeno, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
}

// --- první průchod: existují všechny symboly a jak jsou velké? ---
var obrazky: [(String, NSImage)] = []
var chybi: [String] = []
for (jmeno, symJmeno) in mapa {
    if let i = symbol(symJmeno) { obrazky.append((jmeno, i)) }
    else { chybi.append("\(jmeno) -> \(symJmeno)") }
}
if !chybi.isEmpty {
    print("NEZNÁMÉ SYMBOLY (\(chybi.count)):")
    chybi.forEach { print("  \($0)") }
    exit(1)
}

let nejsirsi = obrazky.map(\.1.size.width).max()!
let nejvyssi = obrazky.map(\.1.size.height).max()!
print("největší symbol: \(nejsirsi) x \(nejvyssi) bodů, rámeček \(normal)")
if max(nejsirsi, nejvyssi) > normal {
    print("POZOR: symbol přerostl rámeček a ořízl by se — zvětši `normal`")
    exit(1)
}

// --- druhý průchod: každý doprostřed stejně velkého čtverce ---
try? FileManager.default.createDirectory(atPath: cil, withIntermediateDirectories: true)
let merítko = CGFloat(strana) / normal
var celkem = 0

for (jmeno, img) in obrazky {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: strana, pixelsHigh: strana,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high

    let s = NSSize(width: img.size.width * merítko, height: img.size.height * merítko)
    let r = NSRect(x: (CGFloat(strana) - s.width) / 2, y: (CGFloat(strana) - s.height) / 2,
                   width: s.width, height: s.height)
    img.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1)
    // Tvar nese alfa kanál; barvu přebarvíme na bílou, ať v souboru nezůstane
    // systémový odstín, který by se dal omylem přečíst jako záměr.
    NSColor.white.set()
    NSRect(x: 0, y: 0, width: strana, height: strana).fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else { continue }
    try? png.write(to: URL(fileURLWithPath: "\(cil)/\(jmeno).png"))
    celkem += png.count
}
print("hotovo: \(obrazky.count) ikon, \(celkem / 1024) kB celkem")
