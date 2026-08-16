/**
 * Rozpoznání typu souboru podle názvu.
 *
 * Slouží k ikonám v panelech a k popisu ve vlastnostech souboru. Obsah
 * nečteme — na serveru bychom si kvůli tomu museli stáhnout začátek každého
 * souboru ve výpisu, což je u tisícipoložkové složky nemyslitelné. Přípona
 * je tedy jediné vodítko, které máme; u souborů bez přípony pomůže ještě
 * zavedený název (`Makefile`, `.htaccess`).
 *
 * `mime` je skutečný typ podle IANA tam, kde existuje. `kind` je hrubší
 * škatulka, podle níž se vybírá ikona — MIME jich má stovky, ale ikon má smysl
 * mít dvacet.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FileKind = api;
}(typeof self !== 'undefined' ? self : globalThis, () => {
  /** Přípona → MIME. Jen to, co člověk potká na webovém serveru nebo v projektu. */
  const MIME = {
    // obrázky
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/vnd.microsoft.icon',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    psd: 'image/vnd.adobe.photoshop',

    // video a zvuk
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aiff: 'audio/aiff',

    // archivy a obrazy disků
    zip: 'application/zip',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    bz2: 'application/x-bzip2',
    xz: 'application/x-xz',
    tar: 'application/x-tar',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    dmg: 'application/x-apple-diskimage',
    iso: 'application/x-iso9660-image',
    pkg: 'application/vnd.apple.installer+xml',

    // zdrojový kód
    js: 'text/javascript',
    mjs: 'text/javascript',
    cjs: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    php: 'application/x-httpd-php',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    java: 'text/x-java-source',
    kt: 'text/x-kotlin',
    swift: 'text/x-swift',
    c: 'text/x-c',
    h: 'text/x-c',
    cpp: 'text/x-c++',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    pl: 'text/x-perl',
    lua: 'text/x-lua',
    sh: 'application/x-sh',
    bash: 'application/x-sh',
    zsh: 'application/x-sh',
    fish: 'application/x-sh',
    ps1: 'application/x-powershell',
    bat: 'application/x-bat',
    vue: 'text/x-vue',
    svelte: 'text/x-svelte',

    // značkovací jazyky a styly
    html: 'text/html',
    htm: 'text/html',
    xhtml: 'application/xhtml+xml',
    twig: 'text/x-twig',
    latte: 'text/x-latte',
    blade: 'text/x-blade',
    ejs: 'text/x-ejs',
    hbs: 'text/x-handlebars',
    css: 'text/css',
    scss: 'text/x-scss',
    sass: 'text/x-sass',
    less: 'text/x-less',
    styl: 'text/x-styl',

    // data a konfigurace
    json: 'application/json',
    xml: 'application/xml',
    yml: 'application/yaml',
    yaml: 'application/yaml',
    toml: 'application/toml',
    ini: 'text/plain',
    conf: 'text/plain',
    cfg: 'text/plain',
    env: 'text/plain',
    plist: 'application/xml',
    sql: 'application/sql',
    db: 'application/vnd.sqlite3',
    sqlite: 'application/vnd.sqlite3',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',

    // dokumenty
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    odt: 'application/vnd.oasis.opendocument.text',
    rtf: 'application/rtf',
    pages: 'application/x-iwork-pages-sffpages',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    numbers: 'application/x-iwork-numbers-sffnumbers',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odp: 'application/vnd.oasis.opendocument.presentation',
    key: 'application/x-iwork-keynote-sffkey',

    // text
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    log: 'text/plain',
    rst: 'text/x-rst',

    // písma
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',

    // spustitelné a klíče
    exe: 'application/vnd.microsoft.portable-executable',
    msi: 'application/x-msdownload',
    app: 'application/x-executable',
    bin: 'application/octet-stream',
    pem: 'application/x-pem-file',
    crt: 'application/x-x509-ca-cert',
    cer: 'application/x-x509-ca-cert',
    p12: 'application/x-pkcs12',
    pfx: 'application/x-pkcs12',
    pub: 'application/x-pem-file',
    asc: 'application/pgp-keys',
  };

  /**
   * Soubory bez přípony, které přesto poznáme podle jména.
   * Klíč je název malými písmeny.
   */
  const BY_NAME = {
    dockerfile: { kind: 'config', mime: 'text/x-dockerfile' },
    makefile: { kind: 'code', mime: 'text/x-makefile' },
    procfile: { kind: 'config', mime: 'text/plain' },
    rakefile: { kind: 'code', mime: 'text/x-ruby' },
    gemfile: { kind: 'config', mime: 'text/x-ruby' },
    vagrantfile: { kind: 'config', mime: 'text/x-ruby' },
    readme: { kind: 'text', mime: 'text/plain' },
    license: { kind: 'text', mime: 'text/plain' },
    changelog: { kind: 'text', mime: 'text/plain' },
    '.htaccess': { kind: 'config', mime: 'text/plain' },
    '.htpasswd': { kind: 'key', mime: 'text/plain' },
    '.env': { kind: 'config', mime: 'text/plain' },
    '.gitignore': { kind: 'config', mime: 'text/plain' },
    '.gitattributes': { kind: 'config', mime: 'text/plain' },
    '.editorconfig': { kind: 'config', mime: 'text/plain' },
    '.npmrc': { kind: 'config', mime: 'text/plain' },
    '.dockerignore': { kind: 'config', mime: 'text/plain' },
    '.ds_store': { kind: 'binary', mime: 'application/octet-stream' },
  };

  /** Přípony, u kterých je škatulka jiná, než by z MIME vyšlo. */
  const KIND_BY_EXT = {
    svg: 'image',       // je to sice značkovací jazyk, ale člověk čeká obrázek
    twig: 'markup',
    latte: 'markup',
    blade: 'markup',
    ejs: 'markup',
    hbs: 'markup',
    ini: 'config',
    conf: 'config',
    cfg: 'config',
    env: 'config',
    plist: 'config',
    csv: 'sheet',
    tsv: 'sheet',
    sql: 'data',
    db: 'data',
    sqlite: 'data',
    key: 'slides',      // .key je Keynote; klíče bývají .pem/.pub
    sh: 'exe',
    bash: 'exe',
    zsh: 'exe',
    fish: 'exe',
    ps1: 'exe',
    bat: 'exe',
    dmg: 'disk',
    iso: 'disk',
    pkg: 'disk',
    md: 'text',
    markdown: 'text',
    rst: 'text',
    log: 'text',
  };

  /** Popisky pro dialog vlastností. */
  const LABELS = {
    folder: 'Složka',
    link: 'Odkaz',
    image: 'Obrázek',
    video: 'Video',
    audio: 'Zvuk',
    archive: 'Archiv',
    disk: 'Obraz disku',
    code: 'Zdrojový kód',
    markup: 'Značkovací jazyk',
    style: 'Styly',
    data: 'Data',
    config: 'Nastavení',
    doc: 'Dokument',
    pdf: 'PDF',
    sheet: 'Tabulka',
    slides: 'Prezentace',
    font: 'Písmo',
    exe: 'Skript nebo program',
    key: 'Klíč nebo certifikát',
    text: 'Text',
    binary: 'Soubor',
  };

  /** Škatulka odvozená z MIME, když ji nemáme určenou napevno. */
  function kindFromMime(mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('font/') || mime === 'application/vnd.ms-fontobject') return 'font';
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'markup';
    // PHP má MIME v application/*, ačkoliv je to zdrojový kód jako každý jiný.
    if (/x-httpd-php|x-php/.test(mime)) return 'code';
    if (mime === 'text/css' || mime.startsWith('text/x-scss') || mime.startsWith('text/x-sass')
      || mime.startsWith('text/x-less') || mime.startsWith('text/x-styl')) return 'style';
    if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/yaml'
      || mime === 'application/toml' || mime === 'application/sql') return 'data';
    if (/spreadsheet|ms-excel|numbers/.test(mime)) return 'sheet';
    if (/presentation|powerpoint|keynote/.test(mime)) return 'slides';
    if (/word|opendocument\.text|rtf|pages/.test(mime)) return 'doc';
    if (/zip|gzip|bzip2|x-xz|x-tar|vnd\.rar|7z-compressed/.test(mime)) return 'archive';
    if (/pem|x509|pkcs12|pgp-keys/.test(mime)) return 'key';
    if (/executable|msdownload|portable-executable|x-sh|x-powershell|x-bat/.test(mime)) return 'exe';
    if (mime === 'text/plain' || mime === 'text/markdown' || mime.startsWith('text/x-rst')) return 'text';
    if (mime.startsWith('text/')) return 'code';
    return 'binary';
  }

  /** Přípona bez tečky, malými písmeny. Soubor začínající tečkou přípony nemá. */
  function extensionOf(name) {
    const base = String(name || '');
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
  }

  /**
   * Typ položky ve výpisu.
   *
   * @param {string} name název souboru
   * @param {string} [type] 'd' složka, 'l' odkaz, jinak soubor
   * @returns {{kind: string, mime: string, label: string, ext: string}}
   */
  function of(name, type) {
    if (type === 'd') return { kind: 'folder', mime: 'inode/directory', label: LABELS.folder, ext: '' };
    if (type === 'l') return { kind: 'link', mime: 'inode/symlink', label: LABELS.link, ext: '' };

    const plain = String(name || '');
    const lower = plain.toLowerCase();
    const ext = extensionOf(plain);

    // Celé jméno má přednost před příponou. Kvůli tomu poznáme i odvozeniny
    // jako `.env.local` nebo `.env.example`, které se v projektech válí běžně.
    const stripped = lower.replace(/\.(local|dist|example|sample|bak|old)$/, '');
    const byName = BY_NAME[lower] || BY_NAME[stripped];
    if (byName) return { ...byName, label: LABELS[byName.kind], ext };

    const mime = MIME[ext] || 'application/octet-stream';
    const kind = KIND_BY_EXT[ext] || kindFromMime(mime);
    return { kind, mime, label: LABELS[kind] || LABELS.binary, ext };
  }

  /** Jen MIME; hodí se do dialogu vlastností. */
  function mimeOf(name, type) {
    return of(name, type).mime;
  }

  return { of, mimeOf, extensionOf, LABELS, MIME };
}));
