/**
 * TeXlyre Live-Sync Bot (sync.js)
 *
 * Synchronisiert in Echtzeit zwischen einem TeXlyre WebRTC-Kollaborationsraum
 * und deinem lokalen Projektordner (z. B. in VS Code).
 *
 * Features:
 * - Automatische Authentifizierung / Gast-Session-Verbindung
 * - ORDNER-SYNC: Alle Dateien des TeXlyre-Projekts werden mit ihrem
 *   richtigen Namen lokal gespiegelt (main.tex, kapitel1.tex, bilder/logo.png, ...)
 * - Dokument-Zuordnung: Jede lokale Datei wird gezielt in das passende
 *   TeXlyre-Dokument geschrieben (kein "Welches Dokument ist gemeint?"-Problem mehr)
 * - Echtzeit-Zwei-Wege-Sync ohne Echo-Schleifen
 * - PDF-Download direkt aus dem TeXlyre-Dateisystem (Befehl: print)
 * - Umfassende Verbindungs- und Diagnosetests mit farbigem Terminal-Dashboard
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const child_process = require('child_process');

// --- FARBEN & FORMATIERUNG ---
const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    blue: "\x1b[34m",
    bgBlue: "\x1b[44m",
    bgGreen: "\x1b[42m"
};

// Solange ein Auswahlmenü im Terminal offen ist, werden Log-Zeilen
// zurückgehalten, damit sie das Menü nicht zerreißen.
let holdOutput = false;
const heldOutput = [];

function out(text) {
    if (holdOutput) {
        heldOutput.push(text);
        return;
    }
    console.log(text);
}

function releaseOutput() {
    holdOutput = false;
    while (heldOutput.length > 0) console.log(heldOutput.shift());
}

function log(emoji, title, message = '', color = colors.reset) {
    const time = new Date().toLocaleTimeString();
    out(`${colors.dim}[${time}]${colors.reset} ${emoji} ${colors.bright}${title}${colors.reset} ${color}${message}${colors.reset}`);
}

/** "/kapitel/intro.tex" -> "kapitel/intro.tex" */
function docLabel(texPath) {
    return (texPath || '').replace(/^\/+/, '') || 'unbekanntes Dokument';
}

function formatSize(chars) {
    if (chars < 1024) return `${chars} B`;
    return `${(chars / 1024).toFixed(1)} KB`;
}

function extractConciseLatexError(raw) {
    if (!raw) return '';
    const lines = raw.split('\n');
    const filtered = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (
            line.startsWith('!') ||
            line.match(/^l\.\d+/) ||
            line.match(/error:/i) ||
            line.includes('Fatal error') ||
            line.includes('Emergency stop')
        ) {
            filtered.push(line);
            if (lines[i + 1]) {
                const next = lines[i + 1].trim();
                if (!next.startsWith('!') && !next.startsWith('Here is how much') && next.length > 0) {
                    filtered.push('   ' + next);
                    i++;
                }
            }
        }
    }
    return filtered.join('\n').trim();
}

function normalizeDoc(s) {
    return (s || '').replace(/\r\n/g, '\n').trimEnd();
}

function printBanner() {
    console.log(`
${colors.cyan}╔═══════════════════════════════════════════════════════════════╗
║             TeXlyre <-> Lokaler Live-Sync                     ║
║         Echtzeit-Kollaboration für LaTeX & Typst              ║
╚═══════════════════════════════════════════════════════════════╝${colors.reset}
`);
}

// =============================================================================
// AUSNAHMELISTE: Dateien, die zum Sync-Skript gehören und NIEMALS
// mit TeXlyre abgeglichen werden. Alles andere im Ordner wird synchronisiert.
// =============================================================================
const SCRIPT_OWNED_DIRS = [
    'node_modules',
    '.git',
    '.vscode',
    '.idea',
    '.texlyre_profile',
    'output'
];

const SCRIPT_OWNED_FILES = [
    'sync.js',
    'headless-sync.js',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'readme.md',
    'texlyre-errors.log',
    '.gitignore',
    '.puppeteerrc.cjs',
    '.ds_store',
    'thumbs.db',
    'desktop.ini'
];

const SCRIPT_OWNED_EXTENSIONS = ['.zip', '.log'];

// TeXlyre-interne Ordner (Compiler-Cache, Zwischenprodukte, PDF-Ausgabe)
const TEXLYRE_INTERNAL_PREFIXES = ['/.texlyre_cache/', '/.texlyre_src/'];

// --- ARGUMENTE PARSEN ---
const args = process.argv.slice(2);
let roomId = '';
let roomUrl = '';
let singleFile = '';           // --file=... => nur diese eine Datei synchronisieren
let isVisible = false;
let debounceMs = 75;
let pollMs = 100;              // Poll-Intervall für das aktive Dokument (CodeMirror)
let remotePollMs = 1000;       // Poll-Intervall für alle übrigen Projektdateien
let deleteRemoved = false;
let extraIgnores = [];
let openPdfAfterPrint = true;  // --no-open => PDF nach 'print' nicht automatisch öffnen

for (const arg of args) {
    if (arg.startsWith('--room=')) {
        roomId = arg.replace('--room=', '').trim();
    } else if (arg.startsWith('--url=')) {
        roomUrl = arg.replace('--url=', '').trim();
    } else if (arg.startsWith('--file=')) {
        singleFile = arg.replace('--file=', '').trim();
    } else if (arg === '--visible' || arg === '--show' || arg === '--headless=false') {
        isVisible = true;
    } else if (arg.startsWith('--debounce=')) {
        debounceMs = parseInt(arg.replace('--debounce=', ''), 10) || 75;
    } else if (arg.startsWith('--poll=')) {
        pollMs = parseInt(arg.replace('--poll=', ''), 10) || 100;
    } else if (arg.startsWith('--remote-poll=')) {
        remotePollMs = parseInt(arg.replace('--remote-poll=', ''), 10) || 1000;
    } else if (arg === '--delete-removed') {
        deleteRemoved = true;
    } else if (arg === '--no-open') {
        openPdfAfterPrint = false;
    } else if (arg.startsWith('--ignore=')) {
        extraIgnores = arg.replace('--ignore=', '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
        printBanner();
        console.log(`
${colors.yellow}Verwendung:${colors.reset}
  node sync.js --room=<DEINE_RAUM_ID> [Optionen]
  ${colors.dim}oder${colors.reset}
  node sync.js --url=<DEINE_TEXLYRE_URL> [Optionen]

${colors.yellow}Optionen:${colors.reset}
  --room=<ID>          Die Raum-ID aus TeXlyre (z. B. e8092eef-926b-421b-8562-2a6683678bac)
  --url=<URL>          Die vollständige TeXlyre-Kollaborations-URL
  --visible            Zeigt das Browserfenster zur visuellen Kontrolle an
  --file=<DATEI>       Nur EINE bestimmte Datei synchronisieren (statt des ganzen Ordners)
  --ignore=a.tex,b.tex Zusätzliche Dateien vom Sync ausschließen (kommagetrennt)
  --delete-removed     Lokale Dateien löschen, wenn sie in TeXlyre gelöscht wurden
  --no-open            PDF nach 'print' nicht automatisch im Browser öffnen
  --debounce=<ms>      Wartezeit in ms nach lokalem Tastendruck vor Upload (Standard: 75)
  --poll=<ms>          Intervall in ms für das aktive Dokument (Standard: 100)
  --remote-poll=<ms>   Intervall in ms für alle übrigen Dateien (Standard: 1000)

${colors.yellow}Beispiele:${colors.reset}
  node sync.js --room=e8092eef-926b-421b-8562-2a6683678bac
  node sync.js --room=e8092eef-926b-421b-8562-2a6683678bac --visible
  npm start -- --room=e8092eef-926b-421b-8562-2a6683678bac
`);
        process.exit(0);
    }
}

// --- AUTOMATISCHE ERKENNUNG DER RAUM-ID ---
if (!roomId && !roomUrl) {
    const candidatePaths = [
        path.join(__dirname, 'projects.json'),
        path.join(__dirname, '..', 'LatexTest', 'projects.json')
    ];
    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            try {
                const projects = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (Array.isArray(projects) && projects.length > 0 && projects[0].id) {
                    roomId = projects[0].id;
                    log('🔍', '[AUTO-DETECT]', `Raum-ID automatisch aus '${path.basename(p)}' gefunden: ${roomId}`, colors.yellow);
                    break;
                }
            } catch (e) {}
        }
    }
}

if (!roomId && !roomUrl) {
    printBanner();
    console.log(`
${colors.red}❌ Keine Raum-ID oder URL übergeben!${colors.reset}

${colors.yellow}So startest du den Live-Sync:${colors.reset}
1. Öffne dein Dokument in TeXlyre (https://texlyre.org/texlyre)
2. Kopiere die Webadresse aus der Browserzeile (z. B. https://texlyre.org/texlyre/#yjs:abc-123)
3. Führe folgenden Befehl im Terminal aus:
   ${colors.green}npm start -- --room=abc-123${colors.reset}
   ${colors.dim}oder${colors.reset}
   ${colors.green}node sync.js --url=https://texlyre.org/texlyre/#yjs:abc-123${colors.reset}

${colors.cyan}Tipp: Mit '--visible' kannst du das Browserfenster live mitverfolgen:${colors.reset}
   ${colors.green}npm start -- --room=abc-123 --visible${colors.reset}
`);
    process.exit(1);
}

// URL normalisieren
let targetUrl = roomUrl;
if (!targetUrl) {
    targetUrl = `https://texlyre.org/texlyre/#yjs:${roomId}`;
} else {
    if (targetUrl.includes('texlyre.github.io') && !targetUrl.includes('/texlyre')) {
        targetUrl = targetUrl.replace('texlyre.github.io', 'texlyre.github.io/texlyre');
    }
    if (!roomId) {
        const m = targetUrl.match(/yjs:([^&?#]+)/);
        if (m) roomId = m[1];
    }
}

printBanner();

// --- AUTO-BEREINIGUNG: BESCHÄDIGTER PUPPETEER CACHE ---
// Verhindert den Fehler: "The browser folder exists but the executable is missing",
// der auftritt wenn ein früherer Download abgebrochen wurde.
function cleanupCorruptedPuppeteerCache() {
    try {
        const homeDir = os.homedir();
        const cacheBase = path.join(homeDir, '.cache', 'puppeteer', 'chrome');
        if (!fs.existsSync(cacheBase)) return;
        const entries = fs.readdirSync(cacheBase, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const folderPath = path.join(cacheBase, entry.name);
                const exeCandidates = [
                    path.join(folderPath, 'chrome-win64', 'chrome.exe'),
                    path.join(folderPath, 'chrome.exe'),
                    path.join(folderPath, 'chrome-linux64', 'chrome'),
                    path.join(folderPath, 'chrome-mac-x64', 'Google Chrome for Testing.app'),
                    path.join(folderPath, 'chrome-mac-arm64', 'Google Chrome for Testing.app')
                ];
                const hasValidExe = exeCandidates.some(c => fs.existsSync(c));
                if (!hasValidExe) {
                    try {
                        fs.rmSync(folderPath, { recursive: true, force: true });
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}
}
cleanupCorruptedPuppeteerCache();

// --- KONTROLLE 1: PUPPETEER VERFÜGBARKEIT ---
let puppeteer;
function loadPuppeteer() {
    try {
        return require('puppeteer');
    } catch (e) {
        try {
            return require('puppeteer-core');
        } catch (e2) {
            const fallbackPath = path.join(__dirname, '..', 'LatexTest', 'node_modules', 'puppeteer');
            if (fs.existsSync(fallbackPath)) {
                try {
                    return require(fallbackPath);
                } catch (err) {}
            }
        }
    }
    return null;
}

puppeteer = loadPuppeteer();

if (!puppeteer) {
    log('⚙️', '[ABHÄNGIGKEIT]', 'Puppeteer ist noch nicht installiert. Installiere automatisch (dies dauert nur wenige Sekunden)...', colors.yellow);
    try {
        cleanupCorruptedPuppeteerCache();
        // Führe Installation aus – PUPPETEER_SKIP_DOWNLOAD verhindert unvollständige Browser-Downloads
        child_process.execSync('npm install --no-audit --no-fund', {
            stdio: 'inherit',
            cwd: __dirname,
            env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' }
        });
        puppeteer = loadPuppeteer();
        if (puppeteer) {
            log('✅', '[ABHÄNGIGKEIT]', 'Puppeteer wurde erfolgreich installiert!', colors.green);
        }
    } catch (installErr) {
        // Fallback: Benutzer informieren
    }
}

if (!puppeteer) {
    log('❌', '[ABHÄNGIGKEIT]', 'Puppeteer ist noch nicht installiert.', colors.red);
    console.log(`
${colors.yellow}Bitte führe folgenden Befehl aus, um Puppeteer zu installieren:${colors.reset}
  ${colors.green}npm install${colors.reset}

Danach starte den Sync erneut mit:
  ${colors.green}npm start -- --room=${roomId || 'DEINE_ID'}${colors.reset}
`);
    process.exit(1);
}

// --- KONTROLLE 2: NETZWERK & TEXLYRE ERREICHBARKEIT ---
function checkNetworkConnectivity(url) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(url);
            const req = https.request({
                hostname: parsed.hostname,
                port: 443,
                path: parsed.pathname,
                method: 'HEAD',
                timeout: 8000
            }, (res) => {
                resolve({ ok: res.statusCode < 500, statusCode: res.statusCode });
            });
            req.on('error', (err) => resolve({ ok: false, error: err.message }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: 'Timeout nach 8 Sekunden' });
            });
            req.end();
        } catch (e) {
            resolve({ ok: false, error: e.message });
        }
    });
}

// --- BROWSER-PFAD ERMITTELN (CHROME / EDGE / BRAVE VOM SYSTEM) ---
function findBrowserExecutable() {
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    const candidates = [];

    if (isWindows) {
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const localAppData = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');

        candidates.push(
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        );
    } else if (isMac) {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        );
    } else if (isLinux) {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge'
        );
    }

    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }

    // Fallback: Puppeteer-eigener Cache im Benutzerprofil (nur wenn ausführbare Datei wirklich existiert)
    try {
        const cacheBase = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
        if (fs.existsSync(cacheBase)) {
            const entries = fs.readdirSync(cacheBase);
            for (const entry of entries) {
                const possibleExes = [
                    path.join(cacheBase, entry, 'chrome-win64', 'chrome.exe'),
                    path.join(cacheBase, entry, 'chrome.exe'),
                    path.join(cacheBase, entry, 'chrome-linux64', 'chrome')
                ];
                for (const exe of possibleExes) {
                    if (fs.existsSync(exe)) return exe;
                }
            }
        }
    } catch (e) {}

    return undefined;
}

/**
 * Öffnet ein PDF in einem neuen Fenster des normalen Browsers (Chrome/Edge/
 * Brave mit dem gewohnten Benutzerprofil – NICHT im Sync-Browser).
 * Ohne passenden Browser greift der Standard-PDF-Betrachter des Systems.
 */
function openPdfInBrowser(pdfPath, browserExecutable) {
    const fileUrl = require('url').pathToFileURL(pdfPath).href;
    const spawnDetached = (cmd, cmdArgs, options = {}) => {
        const child = child_process.spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', ...options });
        child.on('error', () => {});
        child.unref();
    };

    // Den Chrome aus dem Puppeteer-Cache nicht verwenden: das wäre ein
    // fremder Test-Browser statt des eigenen Browsers.
    const isSystemBrowser = browserExecutable &&
        fs.existsSync(browserExecutable) &&
        !/[\\/]\.cache[\\/]puppeteer[\\/]/i.test(browserExecutable);

    try {
        if (isSystemBrowser) {
            spawnDetached(browserExecutable, ['--new-window', fileUrl]);
        } else if (process.platform === 'win32') {
            spawnDetached('cmd', ['/c', 'start', '""', `"${pdfPath}"`], { windowsVerbatimArguments: true });
        } else if (process.platform === 'darwin') {
            spawnDetached('open', [pdfPath]);
        } else {
            spawnDetached('xdg-open', [pdfPath]);
        }
        return true;
    } catch (e) {
        return false;
    }
}

// =============================================================================
// PFAD-HILFSFUNKTIONEN (TeXlyre-Pfad "/kapitel/intro.tex" <-> lokale Datei)
// =============================================================================

/** Wandelt einen TeXlyre-Pfad in einen absoluten lokalen Pfad um. */
function texlyrePathToLocal(texPath) {
    const rel = texPath.replace(/^\/+/, '').split('/').join(path.sep);
    return path.join(__dirname, rel);
}

/** Wandelt einen lokalen (relativen) Pfad in einen TeXlyre-Pfad um. */
function localPathToTexlyre(relPath) {
    return '/' + relPath.split(path.sep).join('/').replace(/^\/+/, '');
}

/**
 * Entscheidet, ob eine Datei zum Sync-Skript gehört (und damit ignoriert wird).
 * relPath ist relativ zum Projektordner, z. B. "node_modules\\foo\\bar.js".
 */
function isScriptOwned(relPath) {
    const parts = relPath.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) return true;

    // Ordner-Ausnahmen (an beliebiger Stelle im Pfad)
    for (const part of parts) {
        if (SCRIPT_OWNED_DIRS.includes(part)) return true;
        // Auch Kopien des Browser-Profils (z. B. .texlyre_profile_backup)
        if (part.toLowerCase().startsWith('.texlyre_profile')) return true;
    }

    const base = parts[parts.length - 1].toLowerCase();
    if (SCRIPT_OWNED_FILES.includes(base)) return true;
    if (extraIgnores.includes(base) || extraIgnores.includes(relPath.toLowerCase())) return true;

    const ext = path.extname(base);
    if (SCRIPT_OWNED_EXTENSIONS.includes(ext)) return true;

    return false;
}

/** Entscheidet, ob ein TeXlyre-Pfad synchronisiert werden soll. */
function isSyncableTexlyrePath(texPath) {
    if (!texPath || !texPath.startsWith('/')) return false;
    for (const prefix of TEXLYRE_INTERNAL_PREFIXES) {
        if (texPath.startsWith(prefix)) return false;
    }
    if (texPath === '/.texlyre_cache' || texPath === '/.texlyre_src') return false;
    const rel = texPath.replace(/^\/+/, '').split('/').join(path.sep);
    if (isScriptOwned(rel)) return false;
    if (singleFile) {
        return rel.toLowerCase() === singleFile.toLowerCase();
    }
    return true;
}

// =============================================================================
// ZUSTAND
// =============================================================================

/** Zuletzt bekannter Inhalt je TeXlyre-Pfad (Echo-Schutz in beide Richtungen). */
const lastSynced = new Map();          // texPath -> string (Textdateien)
/** Zeitpunkt der letzten lokalen Änderung je Pfad. */
const lastLocalSave = new Map();       // texPath -> timestamp
/** Metadaten der Remote-Dateien aus dem letzten Poll. */
const remoteMeta = new Map();          // texPath -> { lastModified, size }
/** Zähler, wie oft eine bekannte Datei in Folge nicht mehr auftauchte. */
const missingStreak = new Map();       // texPath -> Anzahl
const MISSING_THRESHOLD = 5;
/** Bereits ausgegebene Hinweise (damit Warnungen nicht spammen). */
const warnedOnce = new Set();
/**
 * Dateien, die gerade per 'new' in TeXlyre angelegt werden -> erwarteter Inhalt.
 * Bis TeXlyre diesen Inhalt gespeichert hat, wird kein (leerer)
 * Zwischenstand aus TeXlyre auf die lokale Datei geschrieben.
 */
const creatingPaths = new Map();

let uploadQueue = Promise.resolve();   // Serialisiert Dokumentwechsel + Uploads

function warnOnce(key, emoji, title, msg, color) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    log(emoji, title, msg, color);
}

// =============================================================================
// BROWSER-SEITIGE HILFSBIBLIOTHEK
// Wird als window.__TLX in die TeXlyre-Seite injiziert.
// =============================================================================
function installPageLibrary(projectId) {
    // Achtung: Dieser Code läuft IM BROWSER, nicht in Node.
    const DB_NAME = 'texlyre-project-' + projectId;
    const INTERNAL_PREFIXES = ['/.texlyre_cache/', '/.texlyre_src/'];

    let cachedDb = null;
    /** Dokument-ID -> Pfad der verknüpften Datei (wird von listFiles() gepflegt). */
    const docPathById = new Map();

    async function openDb() {
        if (cachedDb) return cachedDb;
        const names = (await indexedDB.databases()).map(d => d.name);
        if (!names.includes(DB_NAME)) {
            throw new Error('Projekt-Datenbank nicht gefunden: ' + DB_NAME);
        }
        cachedDb = await new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        cachedDb.onclose = () => { cachedDb = null; };
        cachedDb.onversionchange = () => { try { cachedDb.close(); } catch (e) {} cachedDb = null; };
        return cachedDb;
    }

    function reqToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Listet alle Dateien auf, ohne die (teils sehr großen) Inhalte zu laden.
     * Nutzt openKeyCursor auf dem 'path'-Index, damit die TeX-Cache-Dateien
     * (Fonts, .sty, ...) gar nicht erst deserialisiert werden.
     */
    async function listCandidateIds() {
        const db = await openDb();
        const tx = db.transaction('files', 'readonly');
        const store = tx.objectStore('files');
        const result = [];

        if (store.indexNames.contains('path')) {
            const index = store.index('path');
            await new Promise((resolve, reject) => {
                const req = index.openKeyCursor();
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor) { resolve(); return; }
                    const p = cursor.key;
                    let internal = false;
                    for (const prefix of INTERNAL_PREFIXES) {
                        if (typeof p === 'string' && p.startsWith(prefix)) { internal = true; break; }
                    }
                    if (!internal) result.push({ path: p, id: cursor.primaryKey });
                    cursor.continue();
                };
                req.onerror = () => reject(req.error);
            });
        } else {
            const all = await reqToPromise(store.getAll());
            for (const rec of all) {
                let internal = false;
                for (const prefix of INTERNAL_PREFIXES) {
                    if (rec.path && rec.path.startsWith(prefix)) { internal = true; break; }
                }
                if (!internal) result.push({ path: rec.path, id: rec.id });
            }
        }
        return result;
    }

    function decodeText(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content;
        try {
            return new TextDecoder('utf-8').decode(
                content instanceof ArrayBuffer ? new Uint8Array(content) : content
            );
        } catch (e) {
            return '';
        }
    }

    function toBase64(content) {
        const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : new Uint8Array(content || []);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function contentLength(content) {
        if (content == null) return 0;
        if (typeof content === 'string') return content.length;
        if (content instanceof ArrayBuffer) return content.byteLength;
        return content.length || 0;
    }

    /**
     * Metadaten aller relevanten Dateien (ohne Inhalte an Node zu übertragen).
     * Alle get()-Anfragen werden gemeinsam abgesetzt, damit die IndexedDB-
     * Transaktion zwischendurch nicht inaktiv wird.
     */
    async function listFiles() {
        const candidates = await listCandidateIds();
        const db = await openDb();
        const store = db.transaction('files', 'readonly').objectStore('files');
        const records = await Promise.all(
            candidates.map(c => reqToPromise(store.get(c.id)).catch(() => null))
        );
        const files = records.filter(Boolean);
        // Zuordnung Dokument-ID -> Pfad für boundPath() aktuell halten
        docPathById.clear();
        for (const rec of files) {
            if (rec.documentId && !rec.isDeleted) docPathById.set(rec.documentId, rec.path);
        }
        return files.map(rec => ({
            id: rec.id,
            path: rec.path,
            name: rec.name,
            type: rec.type,
            documentId: rec.documentId || null,
            isBinary: !!rec.isBinary,
            isDeleted: !!rec.isDeleted,
            excludeFromSync: !!rec.excludeFromSync,
            mimeType: rec.mimeType || '',
            lastModified: rec.lastModified || 0,
            size: rec.size || contentLength(rec.content)
        }));
    }

    /**
     * Inhalt einer einzelnen Datei (Text als String, Binär als Base64).
     * Der 'path'-Index ist NICHT eindeutig: zu einem Pfad können gelöschte
     * Altlasten existieren (z. B. eine umbenannte Datei). Deshalb immer alle
     * Treffer holen und den aktiven Datensatz bevorzugen.
     */
    async function readFile(texPath) {
        const db = await openDb();
        const store = db.transaction('files', 'readonly').objectStore('files');
        let matches = [];
        if (store.indexNames.contains('path')) {
            matches = await reqToPromise(store.index('path').getAll(texPath));
        } else {
            const all = await reqToPromise(store.getAll());
            matches = all.filter(r => r.path === texPath);
        }
        const rec = matches.find(r => !r.isDeleted) || matches[0];
        if (!rec) return null;
        if (rec.type === 'directory') return { path: rec.path, kind: 'directory' };
        if (rec.isBinary) {
            return { path: rec.path, kind: 'binary', b64: toBase64(rec.content), lastModified: rec.lastModified || 0 };
        }
        return { path: rec.path, kind: 'text', text: decodeText(rec.content), lastModified: rec.lastModified || 0 };
    }

    // ---------- Editor-Zugriff ----------

    function editorView() {
        const cm = document.querySelector('.cm-content');
        if (!cm) return null;
        if (cm.cmTile && cm.cmTile.view) return cm.cmTile.view;
        if (cm.cmView && cm.cmView.view) return cm.cmView.view;
        const editor = document.querySelector('.cm-editor');
        if (editor && editor.cmView && editor.cmView.view) return editor.cmView.view;
        return null;
    }

    function editorText() {
        const view = editorView();
        if (view && view.state && view.state.doc) return view.state.doc.toString();
        // NIEMALS auf innerText zurückgreifen: CodeMirror 6 virtualisiert das
        // Scrolling, innerText enthält nur sichtbare Zeilen.
        return null;
    }

    /** Pfad der Datei, die aktuell im Editor geöffnet ist. */
    function activePath() {
        // Verlässlichste Quelle: das tatsächlich gebundene Yjs-Dokument
        // (siehe boundPath). Die Heuristiken unten nur als Rückfallebene.
        const bound = boundPath();
        if (bound) return bound;
        // TeXlyre zeigt den Pfad des verknüpften Dokuments im Editor-Header an.
        const el = document.querySelector('.linked-filepath, .filepath-info, [class*="filepath"]');
        if (el) {
            const t = (el.textContent || '').trim();
            if (t.startsWith('/')) return t;
            if (t) return '/' + t.replace(/^\/+/, '');
        }
        // Fallback 1: im Dateibaum ausgewählten Knoten über die React-Props finden
        try {
            const selectedId = findTreeProp('selectedFileId');
            if (selectedId) {
                const node = findNodeByPredicate(n => n.id === selectedId);
                if (node && node.path) return node.path;
            }
        } catch (e) {}
        // Fallback 2: ausgewählter Knoten im DOM
        try {
            const selEl = document.querySelector('.file-node.selected, .file-node.active');
            if (selEl) {
                const nameEl = selEl.querySelector('.file-name') || selEl;
                const name = nameEl.innerText.trim();
                if (name) return '/' + name.replace(/^\/+/, '');
            }
        } catch (e) {}
        return null;
    }

    // ---------- Gebundenes Dokument (Yjs) ----------
    //
    // activePath() liest den Editor-Header. Der springt beim Dokumentwechsel
    // aber FRÜHER auf die neue Datei, als der Editor deren Inhalt zeigt. Wer
    // sich darauf verlässt, schreibt kurzzeitig den Text der alten Datei unter
    // dem Namen der neuen weg. Verlässlich ist nur das Yjs-Dokument, an das
    // der Editor tatsächlich gebunden ist: dessen WebRTC-Provider heißt
    // "<projekt>-yjs_<dokumentId>".

    const docIdByYDoc = new WeakMap();
    let boundYDocSeen = null;           // zuletzt gesehenes Yjs-Dokument im Editor
    let boundSince = 0;                 // seit wann es gebunden ist
    let bindingDetectable = false;      // wurde die Bindung schon einmal erkannt?

    /** Das Y.Doc, an das der Editor über y-codemirror gebunden ist. */
    function boundYDoc() {
        const view = editorView();
        if (!view || !Array.isArray(view.plugins)) return null;
        for (const plugin of view.plugins) {
            const v = plugin && plugin.value;
            if (!v) continue;
            const ytext = v._ytext || (v.conf && v.conf.ytext);
            if (ytext && ytext.doc) return ytext.doc;
        }
        return null;
    }

    /** Sucht in den React-Hooks über dem Editor den Provider, der zu diesem Y.Doc gehört. */
    function providerRoomFor(ydoc) {
        let el = document.querySelector('.cm-editor');
        let fiber = null;
        while (el && !(fiber = fiberOf(el))) el = el.parentElement;
        for (let i = 0; i < 20 && fiber; i++, fiber = fiber.return) {
            let hook = fiber.memoizedState;
            for (let j = 0; j < 80 && hook && typeof hook === 'object'; j++, hook = hook.next) {
                const s = hook.memoizedState;
                for (const c of [s, s && s.current]) {
                    if (c && typeof c === 'object' && c.doc === ydoc && typeof c.roomName === 'string') {
                        return c.roomName;
                    }
                }
            }
        }
        return null;
    }

    /** Dokument-ID des tatsächlich gebundenen Yjs-Dokuments (oder null). */
    function boundDocumentId() {
        const ydoc = boundYDoc();
        if (!ydoc) return null;
        if (ydoc !== boundYDocSeen) {
            boundYDocSeen = ydoc;
            boundSince = Date.now();
        }
        if (docIdByYDoc.has(ydoc)) return docIdByYDoc.get(ydoc);
        const room = providerRoomFor(ydoc);
        const m = room && room.match(/-yjs_([^/\s]+)$/);
        if (!m) return null;
        docIdByYDoc.set(ydoc, m[1]);
        bindingDetectable = true;
        return m[1];
    }

    /** Pfad der Datei, deren Inhalt der Editor WIRKLICH zeigt (oder null). */
    function boundPath() {
        const id = boundDocumentId();
        return id ? (docPathById.get(id) || null) : null;
    }

    /** Wie lange (ms) der Editor schon an dasselbe Yjs-Dokument gebunden ist. */
    function boundForMs() {
        boundDocumentId();
        return boundYDocSeen ? Date.now() - boundSince : 0;
    }

    // ---------- React-Fiber-Zugriff auf den Dateibaum ----------

    function fiberOf(el) {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
    }

    /** Sucht in den Fibers der Dateibaum-Knoten nach einer bestimmten Prop. */
    function findTreeProp(propName) {
        const nodes = document.querySelectorAll('.file-node');
        for (const n of nodes) {
            let f = fiberOf(n);
            for (let i = 0; i < 12 && f; i++, f = f.return) {
                const p = f.memoizedProps;
                if (p && p[propName] !== undefined) return p[propName];
            }
        }
        return undefined;
    }

    /**
     * Läuft über alle sichtbaren Dateibaum-Einträge und gibt das erste
     * FileNode-Objekt (aus den React-Props) zurück, das dem Prädikat entspricht.
     */
    function findNodeByPredicate(predicate) {
        const nodes = document.querySelectorAll('.file-node');
        for (const n of nodes) {
            let f = fiberOf(n);
            for (let i = 0; i < 12 && f; i++, f = f.return) {
                const p = f.memoizedProps;
                if (p && p.node && predicate(p.node)) return p.node;
            }
        }
        return null;
    }

    /** Liefert das DOM-Element des Dateibaum-Eintrags mit dem gegebenen Pfad. */
    function findNodeElement(texPath) {
        const nodes = document.querySelectorAll('.file-node');
        for (const n of nodes) {
            let f = fiberOf(n);
            for (let i = 0; i < 12 && f; i++, f = f.return) {
                const p = f.memoizedProps;
                if (p && p.node && p.node.path === texPath) return n;
            }
        }
        // Fallback: Suche nach Dateinamen direkt im DOM
        const targetBase = (texPath || '').split('/').filter(Boolean).pop();
        if (targetBase) {
            for (const n of nodes) {
                const nameEl = n.querySelector('.file-name') || n;
                if ((nameEl.innerText || '').trim() === targetBase) return n;
            }
        }
        return null;
    }

    /**
     * Klappt alle übergeordneten Ordner eines Pfads auf, damit der Eintrag
     * überhaupt im DOM erscheint. Ein Ordner gilt als aufgeklappt, sobald
     * mindestens ein Kind-Eintrag sichtbar ist.
     */
    function expandParents(texPath) {
        const segments = texPath.split('/').filter(Boolean);
        let acc = '';
        for (let i = 0; i < segments.length - 1; i++) {
            acc += '/' + segments[i];
            const prefix = acc + '/';
            const hasVisibleChild = !!findNodeByPredicate(n => n.path && n.path.startsWith(prefix));
            if (hasVisibleChild) continue;
            const folderEl = findNodeElement(acc);
            if (folderEl) folderEl.click();   // toggelt den Ordner auf
        }
    }

    /** Öffnet die Datei mit dem gegebenen Pfad im Editor. */
    async function selectFile(texPath) {
        if (activePath() === texPath) return { ok: true, via: 'already-active' };

        expandParents(texPath);

        // Strategie 1: echten Klick auf den Dateibaum-Eintrag auslösen
        const el = findNodeElement(texPath);
        if (el) {
            el.click();
            return { ok: true, via: 'click' };
        }

        // Strategie 2: onFileSelect direkt mit dem Datensatz aus IndexedDB aufrufen
        const onFileSelect = findTreeProp('onFileSelect');
        if (typeof onFileSelect === 'function') {
            const db = await openDb();
            const store = db.transaction('files', 'readonly').objectStore('files');
            let matches = [];
            if (store.indexNames.contains('path')) {
                matches = await reqToPromise(store.index('path').getAll(texPath));
            }
            const rec = matches.find(r => !r.isDeleted) || matches[0];
            if (rec) {
                onFileSelect(rec);
                return { ok: true, via: 'onFileSelect' };
            }
        }
        return { ok: false, reason: 'not-found' };
    }

    // ---------- Dateien in TeXlyre anlegen ----------

    /**
     * Liefert den Wert des FileTreeContext von TeXlyre (uploadFiles,
     * createDirectory, linkFileToDocument, ...). Das sind dieselben
     * Funktionen, die der Datei-Explorer beim Anlegen einer Datei nutzt –
     * dadurch landet die Datei auch bei allen Mitautoren.
     */
    function fileTreeApi() {
        const anchors = document.querySelectorAll('.file-node, .cm-content, .ui-panel, button');
        for (const el of anchors) {
            let f = fiberOf(el);
            for (let i = 0; i < 300 && f; i++, f = f.return) {
                const v = f.memoizedProps && f.memoizedProps.value;
                if (v && typeof v.uploadFiles === 'function' && typeof v.linkFileToDocument === 'function') {
                    return v;
                }
            }
        }
        return null;
    }

    async function activeRecord(texPath) {
        const db = await openDb();
        const store = db.transaction('files', 'readonly').objectStore('files');
        let matches = [];
        if (store.indexNames.contains('path')) {
            matches = await reqToPromise(store.index('path').getAll(texPath));
        } else {
            matches = (await reqToPromise(store.getAll())).filter(r => r.path === texPath);
        }
        return matches.find(r => !r.isDeleted) || null;
    }

    /**
     * Wartet auf den Dialog "Link File to Document" und klickt "Link Only".
     * Der Inhalt wird danach über den Editor geschrieben (bewährter Upload-Pfad).
     */
    async function confirmLinkDialog(timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            for (const overlay of document.querySelectorAll('.modal-overlay')) {
                const title = (overlay.querySelector('.ui-panel-title') || {}).textContent || '';
                const linkOnly = overlay.querySelector('button.button.danger');
                const linkCopy = overlay.querySelector('button.button.primary');
                const isLinkDialog = /link file to document|mit dokument verknüpfen/i.test(title) ||
                    (linkOnly && linkCopy && /link only|nur link/i.test(linkOnly.textContent || ''));
                if (isLinkDialog && linkOnly) {
                    linkOnly.click();
                    return true;
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }

    /**
     * Legt eine Datei (inkl. fehlender Ordner) in TeXlyre an.
     * Textdateien werden anschließend als Live-Dokument verknüpft.
     */
    async function createFile(texPath, b64) {
        const api = fileTreeApi();
        if (!api) return { ok: false, reason: 'no-api' };
        if (await activeRecord(texPath)) return { ok: false, reason: 'exists' };

        // Fehlende Ordner anlegen
        const segments = texPath.split('/').filter(Boolean);
        const fileName = segments.pop();
        let parent = '/';
        for (const seg of segments) {
            const dirPath = parent === '/' ? '/' + seg : parent + '/' + seg;
            const rec = await activeRecord(dirPath);
            if (!rec) {
                await api.createDirectory(seg, parent);
            } else if (rec.type !== 'directory') {
                return { ok: false, reason: 'parent-is-file', path: dirPath };
            }
            parent = dirPath;
        }

        const binary = atob(b64 || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await api.uploadFiles([new File([bytes], fileName)], parent);

        let rec = null;
        for (let i = 0; i < 50 && !rec; i++) {
            rec = await activeRecord(texPath);
            if (!rec) await new Promise(r => setTimeout(r, 100));
        }
        if (!rec) return { ok: false, reason: 'not-created' };
        if (rec.isBinary) return { ok: true, isBinary: true, linked: false };

        // Als Live-Dokument verknüpfen (zeigt einen Bestätigungsdialog)
        const linking = api.linkFileToDocument(rec.id).catch(() => {});
        const clicked = await confirmLinkDialog(10000);
        if (!clicked) return { ok: true, isBinary: false, linked: false, reason: 'no-dialog' };
        await Promise.race([linking, new Promise(r => setTimeout(r, 15000))]);

        const after = await activeRecord(texPath);
        return {
            ok: true,
            isBinary: false,
            linked: !!(after && after.documentId),
            documentId: (after && after.documentId) || null
        };
    }

    /** Lässt TeXlyre den Editorinhalt sofort in die verknüpfte Datei speichern. */
    function saveLinkedDocument(documentId) {
        document.dispatchEvent(new CustomEvent('trigger-save', {
            detail: { documentId: documentId, isFile: false }
        }));
        return true;
    }

    function norm(s) {
        return (s || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    }

    /**
     * Prüft, ob der Editor wirklich fertig an das Ziel-Dokument gebunden ist.
     *
     * Wichtig: Nach einem Dokumentwechsel aktualisiert React den Header
     * (.linked-filepath) FRÜHER, als die Yjs-Bindung den Editorinhalt gefüllt
     * hat. Schreibt man in diesem Moment, mischt y-codemirror den eigenen
     * Einschub mit dem nachrückenden Yjs-Zustand – das Dokument verdoppelt
     * sich. Deshalb wird hier zusätzlich verglichen, ob der Editor bereits
     * den gespeicherten Inhalt der Zieldatei zeigt.
     */
    async function editorReadyFor(texPath) {
        if (activePath() !== texPath) return false;
        const view = editorView();
        if (!view || !view.state || !view.state.doc) return false;
        const rec = await readFile(texPath);
        if (!rec || rec.kind !== 'text') return false;
        return bindingReady(texPath, view.state.doc.toString(), rec.text);
    }

    /**
     * Synchrone Bereitschaftsprüfung (ohne await, damit zwischen Prüfung und
     * Schreiben kein Dokumentwechsel dazwischenkommen kann).
     *
     * Ist die Yjs-Bindung erkennbar, muss sie auf texPath zeigen. Dann gilt der
     * Editor als fertig geladen, sobald er den gespeicherten Stand zeigt ODER
     * seit einigen Sekunden an dasselbe Dokument gebunden ist (Mitautoren
     * können ungespeicherte Änderungen haben – dann wartet der reine
     * Inhaltsvergleich sonst vergeblich).
     */
    function bindingReady(texPath, editorTextNow, storedText) {
        const sameAsStored = norm(editorTextNow) === norm(storedText);
        const bound = boundPath();
        if (bound) {
            if (bound !== texPath) return false;
            return sameAsStored || boundForMs() > 2500;
        }
        // Bindung (noch) nicht erkennbar: während eines Wechsels nie schreiben;
        // nur wenn sie nie erkennbar war, auf den alten Inhaltsvergleich zurückfallen.
        if (bindingDetectable) return false;
        return sameAsStored;
    }

    /**
     * Schreibt Text in den Editor – aber NUR, wenn wirklich die erwartete
     * Datei geöffnet UND die Yjs-Bindung fertig ist. Das ist der Kern des
     * Fixes: lieber nichts schreiben als in das falsche oder halb geladene
     * Dokument.
     */
    async function writeToEditor(expectedPath, newText) {
        const active = activePath();
        if (active !== expectedPath) {
            return { ok: false, reason: 'wrong-document', active: active };
        }
        const view = editorView();
        if (!view || !view.state || !view.state.doc || typeof view.dispatch !== 'function') {
            return { ok: false, reason: 'no-editor' };
        }

        // Gespeicherten Stand der Zieldatei holen und mit dem Editor abgleichen
        const rec = await readFile(expectedPath);
        if (!rec || rec.kind !== 'text') {
            return { ok: false, reason: 'no-record' };
        }
        if (activePath() !== expectedPath) {
            return { ok: false, reason: 'wrong-document', active: activePath() };
        }

        const oldText = view.state.doc.toString();
        if (!bindingReady(expectedPath, oldText, rec.text)) {
            const bound = boundPath();
            if (bound && bound !== expectedPath) return { ok: false, reason: 'wrong-document', active: bound };
            return { ok: false, reason: 'editor-not-in-sync' };
        }

        window.__TLX.lastPushed[expectedPath] = newText;
        if (oldText === newText) return { ok: true, unchanged: true };

        // Minimalen gemeinsamen Präfix & Suffix berechnen
        let start = 0;
        while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
        let oldEnd = oldText.length;
        let newEnd = newText.length;
        while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
            oldEnd--;
            newEnd--;
        }

        view.dispatch({ changes: { from: start, to: oldEnd, insert: newText.slice(start, newEnd) } });
        if (window.__scheduleCompile) window.__scheduleCompile();
        return { ok: true };
    }

    // ---------- PDF / Kompilierung ----------

    function compileButton() {
        const selectors = [
            '.compile-button',
            '.latex-button.compile-button',
            '[title*="Compile"]',
            '[title*="compile"]',
            'button.compile',
            '[aria-label*="Compile"]'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn) return btn;
        }
        const all = document.querySelectorAll('button');
        for (const btn of all) {
            const text = (btn.innerText || '').toLowerCase();
            if (text.includes('compile') || text.includes('kompilier')) return btn;
        }
        return null;
    }

    function isCompiling() {
        const btn = compileButton();
        if (!btn) return false;
        return !!(btn.disabled ||
            btn.classList.contains('spinning') ||
            btn.classList.contains('loading') ||
            btn.classList.contains('compiling'));
    }

    /**
     * Pfad des Dokuments, das zuletzt kompiliert wurde. TeXlyre kompiliert
     * das gerade geöffnete Dokument – angezeigte Fehler gehören also zu dem
     * Dokument, das beim Auslösen offen war (nicht zwingend zum aktuellen).
     */
    let lastCompileTarget = null;

    function triggerCompile() {
        const btn = compileButton();
        if (!btn || btn.disabled) return false;
        lastCompileTarget = activePath();
        if (window.__noteCompileTarget) window.__noteCompileTarget(lastCompileTarget);
        btn.click();
        return true;
    }

    function compileTarget() {
        return lastCompileTarget || activePath();
    }

    /** Listet die Ausgabedateien (PDF/Log) aus dem TeXlyre-Dateisystem. */
    async function listOutputs() {
        const db = await openDb();
        const store = db.transaction('files', 'readonly').objectStore('files');
        const out = [];
        if (store.indexNames.contains('path')) {
            await new Promise((resolve, reject) => {
                const req = store.index('path').openKeyCursor();
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor) { resolve(); return; }
                    if (typeof cursor.key === 'string' && cursor.key.startsWith('/.texlyre_src/__output/')) {
                        out.push({ path: cursor.key, id: cursor.primaryKey });
                    }
                    cursor.continue();
                };
                req.onerror = () => reject(req.error);
            });
        }
        const store2 = db.transaction('files', 'readonly').objectStore('files');
        const records = await Promise.all(
            out.map(o => reqToPromise(store2.get(o.id)).catch(() => null))
        );
        return records
            .filter(rec => rec && rec.type === 'file' && !rec.isDeleted)
            .map(rec => ({
                path: rec.path,
                lastModified: rec.lastModified || 0,
                size: rec.size || contentLength(rec.content),
                mimeType: rec.mimeType || ''
            }));
    }

    /** Liest eine Ausgabedatei als Base64. */
    async function readOutput(texPath) {
        const rec = await readFile(texPath);
        if (!rec) return null;
        if (rec.kind === 'binary') return rec.b64;
        if (rec.kind === 'text') return toBase64(new TextEncoder().encode(rec.text).buffer);
        return null;
    }

    window.__TLX = {
        projectId: projectId,
        dbName: DB_NAME,
        lastPushed: {},
        listFiles: listFiles,
        readFile: readFile,
        activePath: activePath,
        boundPath: boundPath,
        bindingDetectable: () => bindingDetectable,
        editorText: editorText,
        editorReadyFor: editorReadyFor,
        selectFile: selectFile,
        createFile: createFile,
        saveLinkedDocument: saveLinkedDocument,
        writeToEditor: writeToEditor,
        triggerCompile: triggerCompile,
        compileTarget: compileTarget,
        isCompiling: isCompiling,
        listOutputs: listOutputs,
        readOutput: readOutput
    };
    return true;
}

// =============================================================================
// HAUPT-SYNC-ROUTINE
// =============================================================================
async function runLiveSync() {
    log('📡', '[KONTROLLE 1/4]', 'Prüfe Internetverbindung zu TeXlyre...', colors.cyan);
    const netCheck = await checkNetworkConnectivity(targetUrl);
    if (!netCheck.ok) {
        log('⚠️', '[WARNUNG]', `TeXlyre konnte nicht direkt erreicht werden (${netCheck.error || netCheck.statusCode}). Versuche dennoch Verbindung...`, colors.yellow);
    } else {
        log('✅', '[ONLINE]', `TeXlyre-Server erreichbar (HTTP ${netCheck.statusCode}).`, colors.green);
    }

    const browserExecutable = findBrowserExecutable();
    if (!browserExecutable) {
        log('❌', '[BROWSER]', 'Kein kompatibler Chromium-Browser (Chrome, Edge, Chromium oder Brave) gefunden.', colors.red);
        console.log(`
${colors.yellow}Für die Hintergrund-Synchronisation wird ein Browser benötigt.${colors.reset}
Empfohlene Lösung:
  • Installiere Google Chrome oder Microsoft Edge auf diesem Computer.
Alternativ kannst du den Browser über Puppeteer nachladen mit:
  ${colors.green}npm run install:browser${colors.reset}
`);
        process.exit(1);
    }

    log('🚀', '[KONTROLLE 2/4]', `Starte Browser (${path.basename(browserExecutable)} | ${isVisible ? 'Sichtbares Fenster' : 'Headless im Hintergrund'})...`, colors.cyan);

    const profileDir = path.join(__dirname, '.texlyre_profile');
    if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
    }

    const launchOptions = {
        headless: !isVisible,
        userDataDir: profileDir,
        executablePath: browserExecutable,
        defaultViewport: isVisible ? null : { width: 1440, height: 900 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-fake-ui-for-media-stream',
            '--allow-file-access-from-files',
            isVisible ? '--window-size=1280,850' : '--window-size=1440,900'
        ]
    };

    let browser;
    try {
        browser = await puppeteer.launch(launchOptions);
    } catch (err) {
        if (/already running/i.test(err.message)) {
            log('❌', '[BROWSER]', 'Es läuft bereits ein Sync mit diesem Profil.', colors.red);
            console.log(`
${colors.yellow}Bitte beende zuerst den anderen Sync-Vorgang (Strg + C im anderen Terminal)
oder schließe das Browserfenster. Danach starte den Sync erneut.${colors.reset}
`);
            process.exit(1);
        }
        if (/could not find chrome|executable doesn't exist|failed to launch/i.test(err.message)) {
            log('❌', '[BROWSER]', `Browser konnte nicht gestartet werden: ${err.message}`, colors.red);
            console.log(`
${colors.yellow}Tipp: Überprüfe deinen Browser oder installiere Google Chrome / Microsoft Edge.${colors.reset}
`);
            process.exit(1);
        }
        throw err;
    }

    browser.on('disconnected', () => {
        if (isVisible) {
            console.log(`\n${colors.yellow}🛑 Das Browser-Verbindungsfenster wurde geschlossen.${colors.reset}`);
            console.log(`${colors.cyan}💡 Tipp: Starte den Sync ohne '--visible' (z. B. 'npm start -- --room=...'), damit der Browser unsichtbar im Hintergrund läuft und die Verbindung stabil bleibt.${colors.reset}\n`);
        } else {
            console.log(`\n${colors.yellow}🛑 Die Verbindung zum Hintergrund-Browser wurde unerwartet getrennt.${colors.reset}`);
            console.log(`${colors.cyan}💡 Tipp: Starte den Sync erneut mit 'npm start -- --room=${roomId || 'DEINE_ID'}'. Verwende '--visible' zur Diagnose, falls das Problem wiederholt auftritt.${colors.reset}\n`);
        }
        process.exit(0);
    });

    const page = await browser.newPage();

    // --- PRÄGNANTER FEHLER-INTERZEPTOR FÜR LATEX & KI ---
    // Fehler werden je Dokument geführt: TeXlyre kompiliert immer das gerade
    // geöffnete Dokument, und ohne Zuordnung ist nicht erkennbar, ob der
    // Fehler z. B. in main.tex oder in Document_2.tex steckt.
    const errorsByDoc = new Map();     // texPath -> letzte Fehlermeldung
    let currentCompileDoc = null;      // Dokument der zuletzt ausgelösten Kompilierung
    const errorLogPath = path.join(__dirname, 'texlyre-errors.log');
    try {
        fs.writeFileSync(errorLogPath, 'Keine Fehler bekannt (Kompilierung sauber).\n', 'utf8');
    } catch (e) {}

    function writeErrorLog() {
        const time = new Date().toLocaleTimeString();
        let text;
        if (errorsByDoc.size === 0) {
            text = `[${time}] Keine Fehler (Kompilierung sauber).\n`;
        } else {
            text = Array.from(errorsByDoc.entries())
                .map(([doc, err]) => `[${time}] LaTeX Fehler in '${docLabel(doc)}':\n${err}\n`)
                .join('\n');
        }
        try {
            fs.writeFileSync(errorLogPath, text, 'utf8');
        } catch (e) {}
    }

    function reportCompilerError(msg, docPath) {
        if (!msg) return;
        const doc = docPath || currentCompileDoc;
        const trimmed = msg.trim();
        if (errorsByDoc.get(doc) === trimmed) return;
        errorsByDoc.set(doc, trimmed);
        const time = new Date().toLocaleTimeString();
        out(`\n${colors.red}${colors.bright}[${time}] ❌ [LATEX FEHLER] in '${docLabel(doc)}'${colors.reset}\n${colors.red}${trimmed}${colors.reset}\n`);
        writeErrorLog();
    }

    function reportCompilerClean(docPath) {
        const doc = docPath || currentCompileDoc;
        if (!errorsByDoc.has(doc)) return;
        errorsByDoc.delete(doc);
        const time = new Date().toLocaleTimeString();
        out(`\n${colors.green}${colors.bright}[${time}] 🟢 [LATEX OK] '${docLabel(doc)}' kompiliert wieder fehlerfrei.${colors.reset}\n`);
        writeErrorLog();
    }

    await page.exposeFunction('__pushCompilerError', reportCompilerError);
    await page.exposeFunction('__pushCompilerClean', reportCompilerClean);
    await page.exposeFunction('__noteCompileTarget', (docPath) => {
        if (docPath) currentCompileDoc = docPath;
    });

    page.on('console', (msg) => {
        const text = msg.text();
        if (
            text.includes('Engine is still spinning') ||
            text.includes('SwiftLaTeXService') ||
            text.includes('TexLive File not exists') ||
            text.includes('writing work file') ||
            text.includes('WebAssembly')
        ) {
            return;
        }
        if (
            text.startsWith('!') ||
            text.includes('! LaTeX Error') ||
            text.includes('! Undefined control sequence') ||
            text.includes('Emergency stop') ||
            (msg.type() === 'error' && (text.includes('! ') || text.includes('l.') || text.includes('Undefined control sequence') || text.includes('LaTeX Error')))
        ) {
            const concise = extractConciseLatexError(text) || text.substring(0, 250);
            if (concise) reportCompilerError(concise);
        }
    });

    page.on('pageerror', () => { /* triviale Web-Warnings unterdrücken */ });

    log('🌐', '[KONTROLLE 3/4]', `Verbinde mit Raum: ${colors.bright}${targetUrl}${colors.reset}`, colors.cyan);

    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    } catch (e) {
        log('ℹ️', '[NAV]', 'Erster Ladeversuch abgeschlossen, prüfe Dokument-Status...', colors.dim);
    }

    // --- KONTROLLE 4: AUTHENTIFIZIERUNG / GAST-AUTOMATISIERUNG ---
    log('🔐', '[KONTROLLE 4/4]', 'Prüfe Authentifizierungsstatus...', colors.cyan);
    await new Promise(r => setTimeout(r, 2000));

    await page.waitForFunction(() => {
        const isVisible = element => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const hasGuestButton = Array.from(document.querySelectorAll('button')).some(button =>
            isVisible(button) && /try as guest/i.test(button.innerText || button.getAttribute('aria-label') || '')
        );
        const hasEditor = !!document.querySelector('.cm-content, .cm-editor, [contenteditable="true"]');
        const hasProjects = Array.from(document.querySelectorAll('h1')).some(heading =>
            /all projects/i.test(heading.textContent || '')
        );
        const hasOpenButton = Array.from(document.querySelectorAll('button')).some(button =>
            isVisible(button) && /^open$/i.test((button.innerText || '').trim())
        );
        return hasGuestButton || hasEditor || hasProjects || hasOpenButton;
    }, { timeout: 15000 }).catch(() => {});

    const isAuthRequired = await page.evaluate(() => {
        const isVisible = element => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const buttons = Array.from(document.querySelectorAll('button'));
        const hasGuestEntry = buttons.some(button =>
            isVisible(button) && /try as guest/i.test(button.innerText || button.getAttribute('aria-label') || '')
        );
        return hasGuestEntry;
    });

    if (isAuthRequired) {
        log('👤', '[GAST-LOGIN]', 'Login-Bildschirm erkannt. Starte automatische Gast-Sitzung...', colors.yellow);
        try {
            async function clickButtonByText(pattern, description) {
                const buttons = await page.$$('button');
                for (const button of buttons) {
                    const text = await button.evaluate(element =>
                        `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`
                    );
                    if (pattern.test(text)) {
                        await button.click();
                        return;
                    }
                }
                throw new Error(`Button "${description}" nicht gefunden`);
            }

            await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button =>
                /try as guest/i.test(button.innerText || button.getAttribute('aria-label') || '')
            ), { timeout: 8000 });
            await clickButtonByText(/try as guest/i, 'Try as Guest');
            await new Promise(r => setTimeout(r, 1000));

            const checkboxes = await page.$$('input[type="checkbox"]');
            for (const checkbox of checkboxes) {
                if (!(await checkbox.evaluate(element => element.checked))) await checkbox.click();
            }
            await new Promise(r => setTimeout(r, 500));

            await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(button =>
                /start guest session/i.test(button.innerText || button.getAttribute('aria-label') || '') && !button.disabled
            ), { timeout: 8000 });
            await clickButtonByText(/start guest session/i, 'Start Guest Session');
            await page.waitForFunction(() => {
                const startButton = Array.from(document.querySelectorAll('button')).find(button =>
                    /start guest session/i.test(button.innerText || button.getAttribute('aria-label') || '')
                );
                const pageText = document.body ? document.body.innerText : '';
                return !startButton || !!document.querySelector('.cm-content, .cm-editor, .file-node') ||
                    /failed to create guest session/i.test(pageText);
            }, { timeout: 8000 });
            const guestSessionError = await page.evaluate(() => {
                const text = document.body ? document.body.innerText : '';
                return /failed to create guest session/i.test(text);
            });
            if (guestSessionError) {
                throw new Error('TeXlyre konnte keine Gast-Sitzung erstellen. Das ist wahrscheinlich ein temporäres Server- oder Sitzungsproblem.');
            }
            log('✅', '[GAST-LOGIN]', 'Gast-Sitzung angefordert. Warte auf das Projekt...', colors.green);
        } catch (err) {
            log('⚠️', '[AUTH-HINWEIS]', `Automatischer Gast-Klick: ${err.message}. Warte auf Editor...`, colors.yellow);
        }
    } else {
        log('✅', '[SESSION]', 'Gespeicherte Sitzung aktiv (kein Login erforderlich).', colors.green);
    }

    // --- ERKENNUNG: PROJEKTLISTE STATT EDITOR ---
    // Wenn die Raum-URL auf die Projektübersicht umleitet (z. B. weil der Raum
    // nicht direkt geöffnet werden konnte), zeigt die Seite eine Projektliste
    // statt dem Editor. Dann muss ggf. das Projekt erst geöffnet werden.
    const isOnProjectList = await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('h1')).some(el => /all projects/i.test(el.textContent || ''));
        const openButton = Array.from(document.querySelectorAll('button')).some(el => /^open$/i.test((el.innerText || '').trim()));
        return (!!document.querySelector('.project-list-container') || heading || openButton) && !document.querySelector('.cm-content');
    });

    if (isOnProjectList) {
        log('📋', '[PROJEKT-LISTE]', 'Projektliste statt Editor erkannt. Versuche Projekt zu öffnen...', colors.yellow);

        // Strategie 1: Nochmal zur Raum-URL navigieren (manchmal reicht ein Reload)
        try {
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        } catch (e) {}
        await page.waitForFunction(() => {
            const hasEditor = !!document.querySelector('.cm-content, .cm-editor, [contenteditable="true"]');
            const hasOpenButton = Array.from(document.querySelectorAll('button')).some(button =>
                /^open$/i.test((button.innerText || '').trim())
            );
            return hasEditor || hasOpenButton;
        }, { timeout: 20000 }).catch(() => {});

        // Prüfen ob jetzt der Editor da ist
        const hasEditorNow = await page.evaluate(() => !!document.querySelector('.cm-content, .cm-editor, [contenteditable="true"]'));
        if (!hasEditorNow) {
            // Strategie 2: "Open"-Button des ersten Projekts klicken
            const clickedOpen = await page.evaluate(() => {
                const openBtn = document.querySelector('.open-button, button.action-button.primary.open-button') ||
                    Array.from(document.querySelectorAll('button')).find(button => /^open$/i.test((button.innerText || '').trim()));
                if (openBtn) { openBtn.click(); return true; }
                return false;
            });
            if (clickedOpen) {
                log('🔄', '[PROJEKT-LISTE]', 'Projekt über "Open"-Button geöffnet.', colors.cyan);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    // --- Warten auf CodeMirror Editor ---
    log('⏳', '[EDITOR]', 'Warte auf CodeMirror 6 Editor-Instanz...', colors.cyan);
    // Ein frisch angelegtes TeXlyre-Projekt hat noch keine Dateien und damit
    // auch keinen Editor. Das ist kein Fehler: Dateien kommen später per
    // Abgleich von den Mitautoren oder werden mit 'new <datei>' angelegt.
    let projectEmpty = false;
    try {
        // Erst warten, bis entweder der Editor (.cm-content), der Dateibaum (.file-node)
        // oder der leere Dateibaum eines neuen Projekts geladen ist
        await page.waitForFunction(() => {
            return !!document.querySelector('.cm-content, .cm-editor, [contenteditable="true"]') ||
                !!document.querySelector('.file-node') ||
                !!document.querySelector('.file-tree .empty-state') ||
                Array.from(document.querySelectorAll('button')).some(button => /^open$/i.test((button.innerText || '').trim()));
        }, { timeout: 35000 });

        let hasEditor = await page.evaluate(() => !!document.querySelector('.cm-content, .cm-editor, [contenteditable="true"]'));
        if (!hasEditor) {
            // Dem Dateibaum kurz Zeit geben, bevor "leer" angenommen wird
            await page.waitForSelector('.file-node', { timeout: 5000 }).catch(() => {});
            projectEmpty = await page.evaluate(() =>
                !document.querySelector('.file-node') && !!document.querySelector('.file-tree .empty-state'));
        }
        if (projectEmpty) {
            log('📭', '[LEERES PROJEKT]', "Das Projekt hat noch keine Dateien. Lege sie in TeXlyre an oder hier mit 'new main.tex' – sie werden dann automatisch synchronisiert.", colors.yellow);
        } else if (!hasEditor) {
            log('📂', '[DATEI]', 'Projekt geöffnet, wähle Start-Datei im Dateibaum...', colors.cyan);
            const clicked = await page.evaluate((wanted) => {
                const nodes = Array.from(document.querySelectorAll('.file-node'));
                if (nodes.length === 0) return false;

                // 1. Spezifisch gewünschte Datei (--file=...)
                if (wanted) {
                    const match = nodes.find(n => {
                        const name = (n.querySelector('.file-name') || n).innerText.trim().toLowerCase();
                        return name === wanted.toLowerCase() || ('/' + name) === wanted.toLowerCase();
                    });
                    if (match) { match.click(); return true; }
                }

                // 2. main.tex
                const mainNode = nodes.find(n => {
                    const name = (n.querySelector('.file-name') || n).innerText.trim().toLowerCase();
                    return name === 'main.tex';
                });
                if (mainNode) { mainNode.click(); return true; }

                // 3. Erste .tex Datei
                const texNode = nodes.find(n => {
                    const name = (n.querySelector('.file-name') || n).innerText.trim().toLowerCase();
                    return name.endsWith('.tex');
                });
                if (texNode) { texNode.click(); return true; }

                // 4. Erste gefundene Datei
                nodes[0].click();
                return true;
            }, singleFile);

            if (clicked) {
                await page.waitForSelector('.cm-content, .cm-editor, [contenteditable="true"]', { timeout: 15000 });
            }
        }

        if (!projectEmpty) {
            await page.waitForSelector('.cm-content, .cm-editor, [contenteditable="true"]', { timeout: 10000 });
            log('🟢', '[EDITOR BEREIT]', 'CodeMirror 6 Editor erfolgreich verbunden!', colors.green);
        }

        await page.addStyleTag({
            content: `
                /* 1. Autor-Namen-Badge komplett ausblenden */
                .cm-ySelectionInfo,
                [class*="ySelectionInfo"] {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                    height: 0 !important;
                    width: 0 !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    pointer-events: none !important;
                    position: absolute !important;
                }

                /* 2. Punkt über dem Cursor ausblenden */
                .cm-ySelectionCaretDot,
                [class*="ySelectionCaretDot"] {
                    display: none !important;
                }

                /* 3. Leuchtender Cursor: exakt 1 Zeile hoch */
                .cm-ySelectionCaret {
                    position: relative !important;
                    display: inline-block !important;
                    height: 1.15em !important;
                    max-height: 1.2em !important;
                    line-height: 1.15em !important;
                    vertical-align: text-bottom !important;
                    border-left: 2.5px solid #2563eb !important;
                    border-right: none !important;
                    border-top: none !important;
                    border-bottom: none !important;
                    margin-left: -1px !important;
                    margin-right: -1px !important;
                    box-shadow: 0 0 5px rgba(37, 99, 235, 0.8) !important;
                    box-sizing: border-box !important;
                }

                /* 4. Textauswahl von Mitnutzern: bündig innerhalb der Zeile */
                .cm-ySelection {
                    background-color: rgba(59, 130, 246, 0.22) !important;
                    outline: none !important;
                    box-shadow: inset 0 0 0 1px rgba(59, 130, 246, 0.75) !important;
                    border-radius: 2px !important;
                    box-sizing: border-box !important;
                }
            `
        });
        log('✨', '[DESIGN]', 'Autor-Namen ausgeblendet | Leuchtender Cursor (1-zeilig) aktiv.', colors.green);
    } catch (e) {
        // Diagnose: Was zeigt die Seite stattdessen?
        const pageState = await page.evaluate(() => {
            const h1 = document.querySelector('h1');
            return {
                title: document.title,
                heading: h1 ? h1.textContent.trim() : '',
                hasProjectList: !!document.querySelector('.project-list-container'),
                hasAllProjects: Array.from(document.querySelectorAll('h1')).some(el => /all projects/i.test(el.textContent || '')),
                hasOpenButton: Array.from(document.querySelectorAll('button')).some(el => /^open$/i.test((el.innerText || '').trim())),
                hasGuestButton: !!document.querySelector('.guest-button'),
                hasAuthBox: !!document.querySelector('.auth-box'),
                url: location.href,
                bodyText: (document.body && document.body.innerText || '').slice(0, 500)
            };
        }).catch(() => ({}));

        log('❌', '[FEHLER]', 'Editor (.cm-content) konnte nach 30s nicht geladen werden!', colors.red);
        log('❌', '[FEHLER]', 'Editor (.cm-content) konnte nach 35s nicht geladen werden!', colors.red);

        if (pageState.hasProjectList || pageState.hasAllProjects || pageState.hasOpenButton) {
            console.log(`\n${colors.yellow}Die Seite zeigt die Projektliste ("${pageState.heading}") statt den Editor.`);
            console.log(`Mögliche Ursachen:`);
            console.log(`  • Die Raum-ID '${roomId}' ist ungültig oder abgelaufen.`);
            console.log(`  • Das Projekt wurde gelöscht oder die Gast-Session hat keinen Zugriff.`);
            console.log(`\n${colors.cyan}Lösung: Öffne ${targetUrl} im normalen Browser,`);
            console.log(`kopiere die aktuelle URL und starte erneut mit der neuen Raum-ID.${colors.reset}\n`);
        } else if (!isVisible) {
            console.log(`\n${colors.yellow}Diagnose-Tipp:${colors.reset}`);
            console.log(`Starte das Skript mit ${colors.green}node sync.js --room=${roomId} --visible${colors.reset}`);
            console.log(`um im geöffneten Browserfenster zu sehen, woran TeXlyre hängen bleibt.\n`);
        }
        await browser.close();
        process.exit(1);
    }

    if (!projectEmpty) {
        try {
            await page.waitForFunction(() => {
                const cm = document.querySelector('.cm-content');
                return cm && cm.cmTile && cm.cmTile.view && cm.cmTile.view.state && cm.cmTile.view.state.doc;
            }, { timeout: 35000 });
        } catch (e) {
            log('⚠️', '[EDITOR]', 'CodeMirror Tile View benötigte länger zum Laden, fahre fort...', colors.yellow);
        }
    }

    // --- Projekt-ID ermitteln und Hilfsbibliothek injizieren ---
    const detectedProjectId = await page.evaluate(() => {
        const m = location.hash.match(/yjs:([^&?#]+)/);
        return m ? m[1] : null;
    });
    const projectId = detectedProjectId || roomId;
    if (!projectId) {
        log('❌', '[PROJEKT]', 'Projekt-/Raum-ID konnte nicht ermittelt werden.', colors.red);
        await browser.close();
        process.exit(1);
    }

    async function ensurePageLibrary() {
        const present = await page.evaluate(() => !!window.__TLX).catch(() => false);
        if (present) return true;
        try {
            await page.evaluate(installPageLibrary, projectId);
            return true;
        } catch (e) {
            log('⚠️', '[BIBLIOTHEK]', `Konnte Browser-Hilfsfunktionen nicht injizieren: ${e.message}`, colors.yellow);
            return false;
        }
    }

    await ensurePageLibrary();

    // Prüfen, ob die Projekt-Datenbank erreichbar ist
    try {
        await page.evaluate(() => window.__TLX.listFiles());
    } catch (e) {
        log('❌', '[DATENBANK]', `Projekt-Datenbank nicht lesbar: ${e.message}`, colors.red);
        log('💡', '[TIPP]', 'Stimmt die Raum-ID? Öffne das Projekt einmal mit --visible im Browser.', colors.cyan);
        await browser.close();
        process.exit(1);
    }

    // =========================================================================
    // INITIALER ABGLEICH: TeXlyre-Projekt -> lokaler Ordner
    // =========================================================================
    log('📂', '[ORDNER-SYNC]', 'Lese Dateiliste aus TeXlyre...', colors.cyan);

    /** Holt die Liste der synchronisierbaren Dateien. */
    async function fetchRemoteList() {
        const all = await page.evaluate(() => window.__TLX.listFiles());
        return all.filter(f =>
            f.type === 'file' &&
            !f.isDeleted &&
            !f.excludeFromSync &&
            isSyncableTexlyrePath(f.path)
        );
    }

    // Sicherheitskopien abweichender lokaler Dateien beim Start.
    // Liegt unter output/ und wird daher selbst nie synchronisiert.
    const backupDir = path.join(__dirname, 'output', '_backup_' + new Date().toISOString().replace(/[:.]/g, '-'));
    const backedUp = [];

    function backupLocalFile(texPath, localPath) {
        try {
            const dest = path.join(backupDir, texPath.replace(/^\/+/, '').split('/').join(path.sep));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(localPath, dest);
            backedUp.push(texPath.replace(/^\//, ''));
        } catch (e) {
            log('⚠️', '[BACKUP]', `Sicherungskopie von ${texPath} fehlgeschlagen: ${e.message}`, colors.yellow);
        }
    }

    /**
     * Schreibt eine Remote-Datei auf die Festplatte.
     * Bei isInitial=true gilt TeXlyre als Quelle der Wahrheit; eine
     * abweichende lokale Fassung wird vorher gesichert.
     */
    async function pullRemoteFile(meta, isInitial) {
        const data = await page.evaluate((p) => window.__TLX.readFile(p), meta.path);
        if (!data) return false;

        const localPath = texlyrePathToLocal(meta.path);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });

        if (data.kind === 'binary') {
            const buf = Buffer.from(data.b64, 'base64');
            if (fs.existsSync(localPath)) {
                try {
                    if (fs.readFileSync(localPath).equals(buf)) return false;
                } catch (e) {}
                if (isInitial) backupLocalFile(meta.path, localPath);
            }
            fs.writeFileSync(localPath, buf);
            return true;
        }

        const remoteText = data.text || '';
        // Zeilenenden der bestehenden lokalen Datei respektieren
        let contentToWrite = remoteText;
        if (fs.existsSync(localPath)) {
            try {
                const currentDisk = fs.readFileSync(localPath, 'utf8');
                if (normalizeDoc(currentDisk) === normalizeDoc(remoteText)) {
                    lastSynced.set(meta.path, remoteText);
                    return false;
                }
                if (isInitial) backupLocalFile(meta.path, localPath);
                contentToWrite = currentDisk.includes('\r\n')
                    ? remoteText.replace(/\r?\n/g, '\r\n')
                    : remoteText.replace(/\r\n/g, '\n');
            } catch (e) {}
        }

        fs.writeFileSync(localPath, contentToWrite, 'utf8');
        lastSynced.set(meta.path, remoteText);
        return true;
    }

    const initialList = await fetchRemoteList();

    if (initialList.length === 0) {
        log('⚠️', '[ORDNER-SYNC]', 'Keine synchronisierbaren Dateien im TeXlyre-Projekt gefunden.', colors.yellow);
    }

    let pulledCount = 0;
    for (const meta of initialList) {
        try {
            const written = await pullRemoteFile(meta, true);
            remoteMeta.set(meta.path, { lastModified: meta.lastModified, size: meta.size });
            if (written) pulledCount++;
            if (!lastSynced.has(meta.path)) {
                const localPath = texlyrePathToLocal(meta.path);
                if (!meta.isBinary && fs.existsSync(localPath)) {
                    lastSynced.set(meta.path, fs.readFileSync(localPath, 'utf8'));
                }
            }
        } catch (err) {
            log('⚠️', '[ORDNER-SYNC]', `${meta.path}: ${err.message}`, colors.yellow);
        }
    }

    const liveDocs = initialList.filter(f => !f.isBinary);
    const staticFiles = initialList.filter(f => f.isBinary);

    // =========================================================================
    // TERMINAL-DASHBOARD
    // =========================================================================
    console.log(`
${colors.green}╔═══════════════════════════════════════════════════════════════╗
║                🟢 LIVE-SYNC ERFOLGREICH GESTARTET             ║
╚═══════════════════════════════════════════════════════════════╝${colors.reset}
${colors.bright}• Raum / Projekt:${colors.reset}  ${projectId}
${colors.bright}• Lokaler Ordner:${colors.reset}  ${__dirname}
${colors.bright}• Sync-Modus:${colors.reset}      ${singleFile ? `Einzeldatei (${singleFile})` : 'Ganzer Ordner (alle Projektdateien)'}
${colors.bright}• Dateien:${colors.reset}         ${initialList.length} synchronisiert${pulledCount > 0 ? ` (${pulledCount} beim Start aktualisiert)` : ''}
`);

    if (liveDocs.length > 0) {
        console.log(`${colors.bright}• Live-Dokumente:${colors.reset}  ${liveDocs.map(f => f.path.replace(/^\//, '')).join(', ')} ${colors.dim}(bidirektional)${colors.reset}`);
    }
    if (staticFiles.length > 0) {
        console.log(`${colors.bright}• Binärdateien:${colors.reset}   ${staticFiles.map(f => f.path.replace(/^\//, '')).join(', ')} ${colors.dim}(nur TeXlyre -> lokal)${colors.reset}`);
    }
    if (backedUp.length > 0) {
        console.log(`
${colors.yellow}⚠️  Beim Start galt die TeXlyre-Fassung als maßgeblich. Abweichende lokale
    Versionen wurden vorher gesichert in:${colors.reset}
    ${colors.dim}${path.relative(__dirname, backupDir)}${colors.reset}
    ${colors.dim}Betroffen: ${backedUp.join(', ')}${colors.reset}`);
    }

    console.log(`
${colors.dim}Tipp: Zum Beenden drücke Strg + C im Terminal.${colors.reset}
─────────────────────────────────────────────────────────────────
`);

    // =========================================================================
    // 1. RICHTUNG: REMOTE (TeXlyre) -> LOKAL
    //    a) Aktives Dokument: Tastenanschlag für Tastenanschlag (CodeMirror)
    //    b) Alle übrigen Dateien: Poll auf das TeXlyre-Dateisystem
    // =========================================================================
    let lastRemoteLogTime = 0;
    const localDebounceTimers = new Map();  // texPath -> Timer eines anstehenden Uploads
    const uploadsInFlight = new Set();      // texPath, deren Upload gerade läuft

    /**
     * Schreibt Remote-Text für einen konkreten Pfad auf die Platte.
     *
     * trusted=true bedeutet: der Inhalt stammt aus dem gespeicherten
     * TeXlyre-Dateisystem (Poll). trusted=false heißt: er kommt live aus dem
     * Editor und kann während eines Dokumentwechsels kurzzeitig leer sein –
     * ein solcher Stand darf eine gefüllte lokale Datei niemals leeren.
     */
    function writeRemoteTextToDisk(texPath, remoteContent, quiet, trusted) {
        if (!isSyncableTexlyrePath(texPath)) return;

        const normRemote = normalizeDoc(remoteContent);

        // Datei wird gerade per 'new' angelegt: Zwischenstände ignorieren,
        // bis TeXlyre den hochgeladenen Inhalt GESPEICHERT hat (trusted).
        // Der Live-Stand aus dem Editor allein reicht nicht – sonst könnte ein
        // danach noch leerer Datensatz die lokale Datei leeren.
        if (creatingPaths.has(texPath)) {
            if (!trusted || normalizeDoc(creatingPaths.get(texPath)) !== normRemote) return;
            creatingPaths.delete(texPath);
        }

        if (!trusted && normRemote.length === 0) {
            const lp = texlyrePathToLocal(texPath);
            try {
                if (fs.existsSync(lp) && fs.readFileSync(lp, 'utf8').trim().length > 0) return;
            } catch (e) {}
        }

        const localPath = texlyrePathToLocal(texPath);

        // (Auch leere Dateien lokal anlegen, solange sie noch nie abgeglichen wurden.)
        if (lastSynced.has(texPath) && normalizeDoc(lastSynced.get(texPath)) === normRemote) {
            lastSynced.set(texPath, remoteContent);
            return;
        }

        // Schreibschutz: der Nutzer hat gerade selbst lokal getippt bzw. ein
        // Upload dieser Datei steht noch aus oder läuft gerade
        const localTs = lastLocalSave.get(texPath) || 0;
        if (Date.now() - localTs < 1500) return;
        if (localDebounceTimers.has(texPath) || uploadsInFlight.has(texPath)) return;

        const fileMissing = !fs.existsSync(localPath);

        if (!fileMissing) {
            try {
                if (normalizeDoc(fs.readFileSync(localPath, 'utf8')) === normRemote) {
                    lastSynced.set(texPath, remoteContent);
                    return;
                }
            } catch (e) {}
        }

        try {
            let contentToWrite = remoteContent;
            if (!fileMissing) {
                try {
                    const currentDisk = fs.readFileSync(localPath, 'utf8');
                    // Lokale Fassung enthält Änderungen, die nie in TeXlyre
                    // angekommen sind (z. B. Datei kam erst nach dem Start dazu,
                    // wurde neu verknüpft oder ein Upload schlug fehl): TeXlyre
                    // gewinnt, aber die lokale Fassung wird vorher gesichert.
                    if (normalizeDoc(currentDisk) !== normalizeDoc(lastSynced.get(texPath)) &&
                        normalizeDoc(currentDisk).length > 0) {
                        backupLocalFile(texPath, localPath);
                        log('🛟', '[BACKUP]', `Lokale Fassung von '${docLabel(texPath)}' wich von TeXlyre ab und wurde gesichert in ${path.relative(__dirname, backupDir)}`, colors.yellow);
                    }
                    contentToWrite = currentDisk.includes('\r\n')
                        ? remoteContent.replace(/\r?\n/g, '\r\n')
                        : remoteContent.replace(/\r\n/g, '\n');
                } catch (e) {}
            }
            fs.mkdirSync(path.dirname(localPath), { recursive: true });
            fs.writeFileSync(localPath, contentToWrite, 'utf8');
            lastSynced.set(texPath, remoteContent);

            if (fileMissing) {
                log('📄', '[DATEI NEU]', `'${texPath.replace(/^\//, '')}' aus TeXlyre erstellt.`, colors.green);
            } else if (!quiet) {
                const now = Date.now();
                if (now - lastRemoteLogTime > 400) {
                    log('📥', '[Remote]', `${texPath.replace(/^\//, '')} (${formatSize(remoteContent.length)})`, colors.magenta);
                    lastRemoteLogTime = now;
                }
            }
        } catch (err) {
            log('❌', '[SCHREIBFEHLER]', `${texPath}: ${err.message}`, colors.red);
        }
    }

    // a) Schneller Pfad für das aktive Dokument
    await page.exposeFunction('__pushActiveDocToDisk', (texPath, remoteContent) => {
        if (!texPath || remoteContent == null) return;
        writeRemoteTextToDisk(texPath, remoteContent, false, false);
    });

    await page.evaluate((intervalMs) => {
        function checkAndPush() {
            if (!window.__TLX) return;
            // Nur das Dokument, an das der Editor wirklich gebunden ist – nicht
            // der Header, der beim Wechsel schon auf die neue Datei zeigt,
            // während der Editor noch den alten Text enthält.
            const activePath = window.__TLX.boundPath();
            if (!activePath) return;
            const currentText = window.__TLX.editorText();
            if (currentText === null) return;

            // Während eines Dokumentwechsels ist der Editor kurzzeitig leer.
            // Diesen Zwischenzustand niemals als "Inhalt gelöscht" melden.
            if (currentText.trim().length === 0) return;

            const last = window.__TLX.lastPushed[activePath];
            const normCurrent = currentText.replace(/\r\n/g, '\n').trimEnd();
            const normLast = (last || '').replace(/\r\n/g, '\n').trimEnd();
            if (last !== undefined && normCurrent === normLast) return;

            window.__TLX.lastPushed[activePath] = currentText;
            if (window.__pushActiveDocToDisk) {
                window.__pushActiveDocToDisk(activePath, currentText);
            }
            if (window.__scheduleCompile) window.__scheduleCompile();
        }

        // Listener an den Editor hängen (wird bei Dokumentwechsel neu gesetzt)
        function attachListeners() {
            const cm = document.querySelector('.cm-content');
            if (!cm || cm.__tlxBound) return;
            cm.__tlxBound = true;
            cm.addEventListener('input', checkAndPush, { passive: true });
            cm.addEventListener('keyup', checkAndPush, { passive: true });
            try {
                new MutationObserver(checkAndPush).observe(cm, {
                    childList: true, subtree: true, characterData: true
                });
            } catch (e) {}
        }

        attachListeners();
        setInterval(attachListeners, 1000);
        setInterval(checkAndPush, intervalMs);

        // Automatischer Compiler-Trigger bei Änderungen
        let compileDebounce = null;
        window.__scheduleCompile = function () {
            clearTimeout(compileDebounce);
            compileDebounce = setTimeout(() => {
                if (window.__TLX && !window.__TLX.isCompiling()) {
                    // Teildateien (ohne \documentclass, per \input eingebunden)
                    // kompilieren allein nie – das erzeugte nur Schein-Fehler.
                    const text = window.__TLX.editorText();
                    if (text !== null && !/\\documentclass/.test(text)) return;
                    window.__TLX.triggerCompile();
                }
            }, 1200);
        };

        setTimeout(() => { if (window.__scheduleCompile) window.__scheduleCompile(); }, 2000);

        // Periodische Überprüfung auf Kompilierfehler
        setInterval(() => {
            if (window.__TLX && window.__TLX.isCompiling()) return;

            const errorStats = document.querySelector('.error-stats');
            const errorStatsText = errorStats ? errorStats.innerText.trim() : '';
            const hasErrorStats = errorStatsText.includes('❌') && !errorStatsText.includes('❌ 0');

            const errorItems = Array.from(document.querySelectorAll('.error-item')).map(item => {
                const loc = item.querySelector('.error-location') ? item.querySelector('.error-location').innerText.replace(/\n/g, ' ') : '';
                const msg = item.querySelector('.latex-error-message') ? item.querySelector('.latex-error-message').innerText : '';
                return `${loc}: ${msg}`.trim();
            }).filter(t => t.length > 5 && !t.includes('Fatal error occurred'));

            const rawSnippet = document.querySelector('.raw-log-panel') ? document.querySelector('.raw-log-panel').innerText : '';
            const rawLines = rawSnippet.split('\n')
                .filter(l => l.startsWith('!') || l.match(/^l\.\d+/))
                .filter(l => !l.includes('Fatal error occurred'))
                .map(l => l.trim());

            const cmDiags = Array.from(document.querySelectorAll('.cm-diagnostic-error, .cm-diagnostic'))
                .map(el => el.innerText.trim())
                .filter(Boolean);

            if (hasErrorStats && errorItems.length === 0 && rawLines.length === 0) {
                try { errorStats.click(); } catch (e) {}
            }

            const allErrors = [];
            if (errorItems.length > 0) allErrors.push(...errorItems);
            if (rawLines.length > 0) allErrors.push(...rawLines);
            if (allErrors.length === 0 && cmDiags.length > 0) allErrors.push(...cmDiags);
            if (allErrors.length === 0 && hasErrorStats) allErrors.push(errorStatsText.replace(/\n/g, ' '));

            // Die angezeigten Fehler gehören zum zuletzt kompilierten Dokument
            const compiledDoc = window.__TLX ? window.__TLX.compileTarget() : null;

            if (allErrors.length > 0) {
                if (window.__pushCompilerError) window.__pushCompilerError([...new Set(allErrors)].join('\n'), compiledDoc);
            } else if (errorStatsText.includes('❌ 0') || (!hasErrorStats && !document.querySelector('.error-list, .split-log-view .error-item'))) {
                if (window.__pushCompilerClean) window.__pushCompilerClean(compiledDoc);
            }
        }, 1200);
    }, pollMs);

    // b) Poll für alle übrigen Projektdateien
    setInterval(async () => {
        try {
            await ensurePageLibrary();
            const list = await fetchRemoteList();
            const seen = new Set();

            for (const meta of list) {
                seen.add(meta.path);
                const prev = remoteMeta.get(meta.path);
                const changed = !prev || prev.lastModified !== meta.lastModified || prev.size !== meta.size;
                remoteMeta.set(meta.path, { lastModified: meta.lastModified, size: meta.size });
                if (!changed) continue;

                // Lokale Tipp-Sperre respektieren
                const localTs = lastLocalSave.get(meta.path) || 0;
                if (Date.now() - localTs < 1500) continue;

                if (meta.isBinary) {
                    const written = await pullRemoteFile(meta, false);
                    if (written) log('📥', '[Remote]', `${meta.path.replace(/^\//, '')} (${formatSize(meta.size)})`, colors.magenta);
                } else {
                    const data = await page.evaluate((p) => window.__TLX.readFile(p), meta.path);
                    if (data && data.kind === 'text') {
                        writeRemoteTextToDisk(meta.path, data.text, false, true);
                    }
                }
            }

            // In TeXlyre gelöschte Dateien.
            // Während TeXlyre einen Datensatz neu schreibt, kann eine Datei für
            // einen Poll-Durchlauf "verschwinden". Deshalb erst nach mehreren
            // aufeinanderfolgenden Fehlanzeigen von einer echten Löschung ausgehen.
            for (const knownPath of Array.from(remoteMeta.keys())) {
                if (seen.has(knownPath)) {
                    missingStreak.delete(knownPath);
                    continue;
                }
                const streak = (missingStreak.get(knownPath) || 0) + 1;
                missingStreak.set(knownPath, streak);
                if (streak < MISSING_THRESHOLD) continue;

                missingStreak.delete(knownPath);
                remoteMeta.delete(knownPath);
                lastSynced.delete(knownPath);
                const localPath = texlyrePathToLocal(knownPath);
                if (!fs.existsSync(localPath)) continue;
                if (deleteRemoved) {
                    try {
                        fs.unlinkSync(localPath);
                        log('🗑️', '[GELÖSCHT]', `'${knownPath.replace(/^\//, '')}' lokal entfernt (in TeXlyre gelöscht).`, colors.yellow);
                    } catch (e) {}
                } else {
                    warnOnce('del:' + knownPath, 'ℹ️', '[HINWEIS]',
                        `'${knownPath.replace(/^\//, '')}' wurde in TeXlyre gelöscht. Die lokale Datei bleibt erhalten (Option: --delete-removed).`,
                        colors.yellow);
                }
            }
        } catch (err) {
            // Netzwerk-/Navigationsfehler stillschweigend übergehen, aber nicht abstürzen
            if (!/Target closed|Session closed|detached/i.test(err.message)) {
                log('⚠️', '[REMOTE-POLL]', err.message, colors.yellow);
            }
        }
    }, remotePollMs);

    // =========================================================================
    // 2. RICHTUNG: LOKAL -> REMOTE (TeXlyre)
    // =========================================================================

    /**
     * Lädt eine lokale Textdatei in das passende TeXlyre-Dokument hoch.
     * Wechselt dafür falls nötig das im Editor geöffnete Dokument.
     */
    async function uploadLocalFile(texPath) {
        const localPath = texlyrePathToLocal(texPath);
        if (!fs.existsSync(localPath)) return;

        // Zu welchem TeXlyre-Eintrag gehört diese Datei?
        const list = await fetchRemoteList();
        const target = list.find(f => f.path === texPath);

        if (target && target.isBinary) {
            warnOnce('binary:' + texPath, '💡', '[BINÄRDATEI]',
                `'${texPath.replace(/^\//, '')}' ist eine Binärdatei (z. B. Bild). Sie wird nur von TeXlyre nach lokal übertragen – lade geänderte Bilder bitte in TeXlyre hoch.`,
                colors.cyan);
            return;
        }

        const newLocalContent = fs.readFileSync(localPath, 'utf8');
        // Exakter Echo-Schutz: Inhalt stimmt bereits mit dem letzten Abgleich überein
        if (normalizeDoc(newLocalContent) === normalizeDoc(lastSynced.get(texPath))) return;

        if (!target) {
            warnOnce('missing:' + texPath, '💡', '[NEUE DATEI]',
                `'${texPath.replace(/^\//, '')}' existiert lokal, aber nicht in TeXlyre. Tippe ${colors.bright}new ${texPath.replace(/^\//, '')}${colors.reset}${colors.cyan}, um sie in TeXlyre anzulegen.`,
                colors.cyan);
            return;
        }

        if (!target.documentId) {
            warnOnce('static:' + texPath, '💡', '[STATISCHE DATEI]',
                `'${texPath.replace(/^\//, '')}' ist in TeXlyre nicht als Live-Dokument verknüpft. Klicke dort auf "Link Document", damit lokale Änderungen hochgeladen werden.`,
                colors.cyan);
            return;
        }

        // Richtiges Dokument im Editor öffnen
        const active = await page.evaluate(() => window.__TLX.activePath());
        if (active !== texPath) {
            const sel = await page.evaluate((p) => window.__TLX.selectFile(p), texPath);
            if (!sel.ok) {
                log('⚠️', '[UPLOAD]', `Dokument '${texPath.replace(/^\//, '')}' konnte in TeXlyre nicht geöffnet werden.`, colors.yellow);
                return 'retry';
            }
            log('🔀', '[DOKUMENT]', `Wechsle Editor auf '${texPath.replace(/^\//, '')}'...`, colors.dim);
        }

        // Auf eine vollständig hergestellte Yjs-Bindung warten (siehe
        // editorReadyFor): erst dann darf geschrieben werden.
        try {
            await page.waitForFunction(
                (p) => window.__TLX && window.__TLX.editorReadyFor(p),
                { timeout: 15000, polling: 200 },
                texPath
            );
        } catch (e) {
            log('⚠️', '[UPLOAD]', `'${texPath.replace(/^\//, '')}' war nicht rechtzeitig bereit – neuer Versuch folgt.`, colors.yellow);
            return 'retry';
        }

        lastLocalSave.set(texPath, Date.now());
        lastSynced.set(texPath, newLocalContent);

        const result = await page.evaluate(
            (p, text) => window.__TLX.writeToEditor(p, text),
            texPath, newLocalContent
        );

        if (result.ok) {
            log('📤', '[Lokal]', `${texPath.replace(/^\//, '')} (${formatSize(newLocalContent.length)})`, colors.cyan);
            return 'ok';
        } else if (result.reason === 'wrong-document') {
            // Sicherheitsnetz: lieber nichts schreiben als ins falsche Dokument
            log('⛔', '[SCHUTZ]', `Upload abgebrochen – im Editor ist '${result.active || 'unbekannt'}' offen, erwartet wurde '${texPath}'.`, colors.yellow);
            lastSynced.delete(texPath);
        } else if (result.reason === 'editor-not-in-sync') {
            // Yjs-Bindung war noch nicht fertig – Schreiben würde den Text verdoppeln
            log('⛔', '[SCHUTZ]', `Upload abgebrochen – '${texPath.replace(/^\//, '')}' war im Editor noch nicht fertig geladen.`, colors.yellow);
            lastSynced.delete(texPath);
        } else {
            log('⚠️', '[UPLOAD]', `Editor nicht bereit (${result.reason}).`, colors.yellow);
            lastSynced.delete(texPath);
        }
        return 'retry';
    }

    /** Fehlgeschlagene Uploads werden wiederholt – es gibt nicht immer ein "nächstes Speichern". */
    const uploadAttempts = new Map();      // texPath -> bisherige Fehlversuche
    const MAX_UPLOAD_ATTEMPTS = 6;

    function scheduleUpload(texPath, delayMs) {
        clearTimeout(localDebounceTimers.get(texPath));
        localDebounceTimers.set(texPath, setTimeout(() => {
            localDebounceTimers.delete(texPath);
            uploadQueue = uploadQueue
                .then(async () => {
                    uploadsInFlight.add(texPath);
                    try {
                        return await uploadLocalFile(texPath);
                    } finally {
                        uploadsInFlight.delete(texPath);
                    }
                })
                .then((status) => {
                    if (status !== 'retry') {
                        uploadAttempts.delete(texPath);
                        return;
                    }
                    const attempts = (uploadAttempts.get(texPath) || 0) + 1;
                    uploadAttempts.set(texPath, attempts);
                    if (attempts < MAX_UPLOAD_ATTEMPTS) {
                        scheduleUpload(texPath, 1500 * attempts);
                    } else {
                        uploadAttempts.delete(texPath);
                        log('❌', '[UPLOAD-FEHLER]', `'${docLabel(texPath)}' konnte nach ${attempts} Versuchen nicht übertragen werden. Die lokale Datei bleibt unverändert – speichere sie erneut, um es nochmal zu versuchen.`, colors.red);
                    }
                })
                .catch(err => log('❌', '[UPLOAD-FEHLER]', `${texPath}: ${err.message}`, colors.red));
        }, delayMs));
    }

    function onLocalChange(relPath) {
        if (isScriptOwned(relPath)) return;

        const texPath = localPathToTexlyre(relPath);
        if (!isSyncableTexlyrePath(texPath)) return;

        // Echte lokale Änderung (nicht das Echo eines Remote-Schreibvorgangs)?
        // Dann sofort sperren, damit TeXlyre sie nicht überschreibt, bevor der
        // Upload überhaupt dran war.
        try {
            const disk = fs.readFileSync(texlyrePathToLocal(texPath), 'utf8');
            if (normalizeDoc(disk) !== normalizeDoc(lastSynced.get(texPath))) {
                lastLocalSave.set(texPath, Date.now());
            }
        } catch (e) {}

        uploadAttempts.delete(texPath);
        scheduleUpload(texPath, debounceMs);
    }

    try {
        fs.watch(__dirname, { recursive: true }, (eventType, filename) => {
            if (!filename) return;
            onLocalChange(filename.toString());
        });
    } catch (err) {
        // Fallback ohne rekursives Watching (falls die Plattform es nicht unterstützt)
        log('⚠️', '[WATCHER]', `Rekursives Überwachen nicht möglich (${err.message}), überwache nur den Hauptordner.`, colors.yellow);
        fs.watch(__dirname, (eventType, filename) => {
            if (!filename) return;
            onLocalChange(filename.toString());
        });
    }

    // =========================================================================
    // 3. HEARTBEAT / VERBINDUNGS-CHECK
    // =========================================================================
    setInterval(async () => {
        try {
            // Ohne geöffnetes Dokument (z. B. leeres Projekt) gibt es keinen Editor
            const alive = await page.evaluate(() => !!window.__TLX &&
                (!!document.querySelector('.cm-content') || !document.querySelector('.file-node')));
            if (!alive) {
                log('⚠️', '[VERBINDUNGS-WARNUNG]', 'Editor im Browser vorübergehend nicht gefunden.', colors.yellow);
                await ensurePageLibrary();
            }
        } catch (e) {
            log('⚠️', '[HEARTBEAT]', 'Browser reagiert verzögert...', colors.yellow);
        }
    }, 15000);

    // =========================================================================
    // 4. INTERAKTIVE BEFEHLE (STDIN)
    // =========================================================================
    const readline = require('readline');
    let rl = null;
    let suppressRlCloseNotice = false;
    let pendingLineAnswer = null;      // Antwort-Callback für den Nummern-Dialog ohne TTY

    let isPrintRunning = false;
    let isNewRunning = false;
    let lastPrintedDoc = null;

    console.log(`${colors.cyan}💡 Tipp: Tippe ${colors.bright}print${colors.reset}${colors.cyan} + Enter, um ein Dokument auszuwählen, zu kompilieren und als PDF herunterzuladen.${colors.reset}`);
    console.log(`${colors.dim}   (Der Live-Sync läuft dabei normal weiter. 'files' zeigt alle synchronisierten Dateien.)${colors.reset}\n`);

    /** Liest bei Bedarf eine Zeile von stdin (nur für den Fallback ohne TTY). */
    function askLine(prompt) {
        process.stdout.write(prompt);
        return new Promise(resolve => { pendingLineAnswer = resolve; });
    }

    /**
     * Auswahlmenü im Terminal: Pfeiltasten + Enter, oder direkt die Nummer.
     * Liefert den Index des gewählten Eintrags oder -1 bei Abbruch.
     */
    async function chooseFromMenu(title, labels, hints, preselect) {
        const n = labels.length;
        const canUseRawMode = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

        // --- Fallback ohne echtes Terminal (z. B. Pipe): Nummer eintippen ---
        if (!canUseRawMode) {
            console.log(`\n${colors.cyan}${colors.bright}${title}${colors.reset}`);
            labels.forEach((label, i) => {
                const mark = i === preselect ? `${colors.green}❯${colors.reset}` : ' ';
                console.log(` ${mark} ${colors.bright}${i + 1})${colors.reset} ${label}${hints[i] ? '  ' + hints[i] : ''}`);
            });
            const answer = (await askLine(`${colors.cyan}Nummer eingeben (Enter = ${preselect + 1}, 0 = Abbrechen): ${colors.reset}`)).trim();
            if (answer === '') return preselect;
            const num = parseInt(answer, 10);
            if (num >= 1 && num <= n) return num - 1;
            return -1;
        }

        // --- Interaktives Menü mit Pfeiltasten ---
        // Die Befehlszeile (readline) muss währenddessen ruhen, sonst landen
        // die Tastendrücke zusätzlich als "Befehl" im normalen Eingabekanal.
        suppressRlCloseNotice = true;
        rl.close();

        holdOutput = true;
        let index = preselect;
        let digits = '';

        const renderItem = (i) => {
            const selected = i === index;
            const pointer = selected ? `${colors.green}${colors.bright}❯` : ' ';
            const label = selected ? `${colors.green}${colors.bright}${labels[i]}` : labels[i];
            return ` ${pointer} ${i + 1})${colors.reset} ${label}${colors.reset}${hints[i] ? '  ' + hints[i] : ''}`;
        };
        const render = (first) => {
            if (!first) process.stdout.write(`\x1b[${n}A`);
            for (let i = 0; i < n; i++) process.stdout.write(`\r\x1b[2K${renderItem(i)}\n`);
        };

        process.stdout.write(`\n${colors.cyan}${colors.bright}${title}${colors.reset}\n`);
        process.stdout.write(`${colors.dim}   ↑/↓ wählen · Enter bestätigen · 1–${n} direkt wählen · Esc abbrechen${colors.reset}\n`);
        render(true);

        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();

        const result = await new Promise(resolve => {
            const finish = (value) => {
                process.stdin.removeListener('keypress', onKey);
                resolve(value);
            };
            function onKey(str, key) {
                key = key || {};
                if (key.ctrl && key.name === 'c') {
                    finish({ index: -1, interrupt: true });
                    return;
                }
                if (key.name === 'escape' || key.name === 'q') { finish({ index: -1 }); return; }
                if (key.name === 'return' || key.name === 'enter') { finish({ index }); return; }
                if (key.name === 'up' || key.name === 'k') {
                    index = (index - 1 + n) % n;
                    digits = '';
                    render(false);
                    return;
                }
                if (key.name === 'down' || key.name === 'j') {
                    index = (index + 1) % n;
                    digits = '';
                    render(false);
                    return;
                }
                if (str && /^[0-9]$/.test(str)) {
                    digits += str;
                    let num = parseInt(digits, 10);
                    if (num < 1 || num > n) {
                        digits = str;
                        num = parseInt(digits, 10);
                    }
                    if (num >= 1 && num <= n) {
                        index = num - 1;
                        render(false);
                        // Eindeutig? (z. B. "3" bei 5 Einträgen) -> sofort übernehmen.
                        // Bei 12 Einträgen wartet "1" noch auf eine zweite Ziffer oder Enter.
                        if (num * 10 > n) finish({ index });
                    } else {
                        digits = '';
                    }
                }
            }
            process.stdin.on('keypress', onKey);
        });

        process.stdin.setRawMode(false);
        if (result.index >= 0) {
            process.stdout.write(`${colors.green}✔ Ausgewählt: ${colors.bright}${labels[result.index]}${colors.reset}\n\n`);
        } else {
            process.stdout.write(`${colors.yellow}✖ Abgebrochen.${colors.reset}\n\n`);
        }
        releaseOutput();
        openCommandInterface();

        if (result.interrupt) process.emit('SIGINT');
        return result.index;
    }

    /** Alle kompilierbaren .tex-Dokumente, main.tex zuerst, sonst alphabetisch. */
    async function listPrintableDocs() {
        const list = await fetchRemoteList();
        return list
            .filter(f => !f.isBinary && f.path.toLowerCase().endsWith('.tex'))
            .map(f => f.path)
            .sort((a, b) => {
                const am = a.toLowerCase() === '/main.tex' ? 0 : 1;
                const bm = b.toLowerCase() === '/main.tex' ? 0 : 1;
                return am - bm || a.localeCompare(b);
            });
    }

    /** Hat die (lokal gespiegelte) Datei ein \documentclass, ist also eigenständig kompilierbar? */
    function isStandaloneDoc(texPath) {
        try {
            return /\\documentclass/.test(fs.readFileSync(texlyrePathToLocal(texPath), 'utf8'));
        } catch (e) {
            return true;   // im Zweifel nicht als Teildatei markieren
        }
    }

    /**
     * Bestimmt, welches Dokument kompiliert werden soll.
     * TeXlyre kompiliert immer das gerade geöffnete Dokument – ohne feste
     * Auswahl bekäme man also je nach Editor-Zustand ein anderes PDF.
     *
     *   print            -> Auswahlmenü (bei nur einem Dokument direkt dieses)
     *   print 2          -> 2. Eintrag der Liste
     *   print kapitel1   -> kapitel1.tex
     */
    async function resolvePrintTarget(argName) {
        const docs = await listPrintableDocs();
        if (docs.length === 0) return null;

        if (argName) {
            if (/^\d+$/.test(argName)) {
                const num = parseInt(argName, 10);
                if (num >= 1 && num <= docs.length) return docs[num - 1];
                log('⚠️', '[PDF]', `Es gibt kein Dokument Nr. ${num} (1–${docs.length}). Tippe 'print' für die Auswahl.`, colors.yellow);
                return null;
            }
            let wanted = '/' + argName.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!wanted.toLowerCase().endsWith('.tex')) wanted += '.tex';
            const hit = docs.find(p => p.toLowerCase() === wanted.toLowerCase());
            if (hit) return hit;
            log('⚠️', '[PDF]', `'${argName}' ist keine .tex-Datei im Projekt. Tippe 'print' für die Auswahl.`, colors.yellow);
            return null;
        }

        if (docs.length === 1) return docs[0];

        const active = await page.evaluate(() => window.__TLX.activePath()).catch(() => null);
        let preselect = docs.indexOf(lastPrintedDoc);
        if (preselect < 0) preselect = docs.findIndex(p => p.toLowerCase() === '/main.tex');
        if (preselect < 0) preselect = docs.findIndex(isStandaloneDoc);
        if (preselect < 0) preselect = 0;

        const hints = docs.map(p => {
            const parts = [];
            if (p === active) parts.push(`${colors.cyan}● im Editor geöffnet${colors.reset}`);
            if (p === lastPrintedDoc) parts.push(`${colors.dim}zuletzt gedruckt${colors.reset}`);
            if (errorsByDoc.has(p)) parts.push(`${colors.red}❌ hat LaTeX-Fehler${colors.reset}`);
            if (!isStandaloneDoc(p)) parts.push(`${colors.yellow}kein \\documentclass (Teildatei?)${colors.reset}`);
            return parts.join(`${colors.dim} · ${colors.reset}`);
        });

        const index = await chooseFromMenu('🖨️  Welches Dokument soll kompiliert werden?', docs.map(docLabel), hints, preselect);
        return index >= 0 ? docs[index] : undefined;   // undefined = vom Nutzer abgebrochen
    }

    /** Das PDF eines Dokuments heißt in TeXlyre wie das Dokument (main.tex -> main.pdf). */
    function pdfBelongsTo(pdfPath, texPath) {
        const pdfBase = pdfPath.split('/').pop().replace(/\.pdf$/i, '').toLowerCase();
        const texBase = texPath.split('/').pop().replace(/\.tex$/i, '').toLowerCase();
        return pdfBase === texBase;
    }

    /**
     * Kompiliert und lädt das PDF direkt aus dem TeXlyre-Dateisystem
     * (/.texlyre_src/__output/<name>.pdf) herunter.
     */
    async function doPrint(argName) {
        const target = await resolvePrintTarget(argName);
        if (target === undefined) return;
        if (!target) {
            if (!argName) log('❌', '[PDF]', 'Kein kompilierbares Dokument gefunden.', colors.red);
            return;
        }
        lastPrintedDoc = target;
        const label = docLabel(target);

        log('🖨️', '[PDF]', `Kompiliere '${label}' und lade das PDF herunter...`, colors.cyan);

        // Dokumentwechsel + Kompilierstart über dieselbe Warteschlange wie die
        // Uploads, damit kein gleichzeitiger Upload den Editor dazwischen
        // auf ein anderes Dokument umschaltet.
        let beforePdfs = null;
        const started = await new Promise((resolve) => {
            uploadQueue = uploadQueue.then(async () => {
                // Zieldokument im Editor öffnen, damit TeXlyre auch wirklich dieses kompiliert
                const active = await page.evaluate(() => window.__TLX.activePath());
                if (active !== target) {
                    log('🔀', '[DOKUMENT]', `Wechsle Editor auf '${label}'...`, colors.dim);
                    await page.evaluate((p) => window.__TLX.selectFile(p), target);
                    try {
                        await page.waitForFunction(
                            (p) => window.__TLX && window.__TLX.editorReadyFor(p),
                            { timeout: 15000, polling: 200 },
                            target
                        );
                    } catch (e) {
                        log('⚠️', '[PDF]', `Dokument '${label}' war nicht rechtzeitig bereit.`, colors.yellow);
                        resolve(false);
                        return;
                    }
                }

                const before = await page.evaluate(() => window.__TLX.listOutputs());
                beforePdfs = new Map(before.filter(f => f.path.endsWith('.pdf')).map(f => [f.path, f.lastModified]));

                const triggered = await page.evaluate(() => window.__TLX.triggerCompile());
                if (!triggered) {
                    log('⚠️', '[PDF]', 'Kompilier-Button konnte nicht gefunden werden (kompiliert TeXlyre gerade?).', colors.yellow);
                    resolve(false);
                    return;
                }
                currentCompileDoc = target;
                resolve(true);
            }).catch((err) => {
                log('❌', '[PDF FEHLER]', `${label}: ${err.message}`, colors.red);
                resolve(false);
            });
        });
        if (!started) return;

        log('⏳', '[PDF]', `Kompiliere '${label}'... bitte warten.`, colors.dim);

        // Auf ein NEUES bzw. aktualisiertes PDF warten (max. 90 s).
        // Sobald die Engine fertig ist, wird nur noch kurz nachgefasst –
        // so blockiert ein fehlgeschlagener Lauf nicht die volle Wartezeit.
        const maxWait = 90000;
        const graceAfterCompile = 8000;
        const startTime = Date.now();
        let freshPdf = null;
        let compileEndedAt = 0;

        // Kurz warten, damit die Kompilierung überhaupt startet
        await new Promise(r => setTimeout(r, 1500));

        while (Date.now() - startTime < maxWait) {
            const busy = await page.evaluate(() => window.__TLX.isCompiling());
            const outputs = await page.evaluate(() => window.__TLX.listOutputs());
            const pdfs = outputs.filter(f => f.path.endsWith('.pdf'));

            const updated = pdfs.filter(f => {
                const prev = beforePdfs.get(f.path);
                return prev === undefined || f.lastModified > prev;
            });

            if (updated.length > 0 && !busy) {
                // Bevorzugt das PDF, das zum Zieldokument gehört – eine
                // zwischenzeitliche Auto-Kompilierung eines anderen Dokuments
                // darf nicht als Ergebnis untergeschoben werden.
                const own = updated.filter(f => pdfBelongsTo(f.path, target));
                const candidates = own.length > 0 ? own : updated;
                candidates.sort((a, b) => b.lastModified - a.lastModified);
                freshPdf = candidates[0];
                break;
            }

            if (!busy) {
                if (compileEndedAt === 0) compileEndedAt = Date.now();
                else if (Date.now() - compileEndedAt > graceAfterCompile) break;
            } else {
                compileEndedAt = 0;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        const pdfOutputDir = path.join(__dirname, 'output');
        const targetBase = target.split('/').pop().replace(/\.tex$/i, '');

        if (!freshPdf) {
            // Kein neues PDF – die Kompilierung ist vermutlich fehlgeschlagen.
            const outputs = await page.evaluate(() => window.__TLX.listOutputs());

            log('❌', '[PDF]', `Die Kompilierung von '${label}' hat kein neues PDF erzeugt.`, colors.red);
            const docError = errorsByDoc.get(target);
            if (docError) {
                out(`${colors.red}${colors.bright}   Fehler in '${label}':${colors.reset}`);
                out(`${colors.red}${docError.split('\n').map(l => '   ' + l).join('\n')}${colors.reset}`);
            } else {
                out(`${colors.dim}   (Keine konkrete Fehlermeldung für '${label}' erfasst – siehe output/${targetBase}.log)${colors.reset}`);
            }
            if (!isStandaloneDoc(target)) {
                log('💡', '[PDF TIPP]', `'${label}' enthält kein \\documentclass – vermutlich eine Teildatei, die über \\input in ein Hauptdokument eingebunden wird. Kompiliere stattdessen das Hauptdokument.`, colors.cyan);
            } else {
                log('💡', '[PDF TIPP]', `Behebe den Fehler in '${label}' (siehe texlyre-errors.log) und versuche es erneut.`, colors.cyan);
            }

            // Log trotzdem sichern – es enthält die vollständige Fehlerbeschreibung
            const failedLog = outputs.find(f => f.path.endsWith('.log') && f.path.split('/').pop().replace(/\.log$/i, '').toLowerCase() === targetBase.toLowerCase());
            if (failedLog) {
                try {
                    const logB64 = await page.evaluate((p) => window.__TLX.readOutput(p), failedLog.path);
                    if (logB64) {
                        fs.mkdirSync(pdfOutputDir, { recursive: true });
                        fs.writeFileSync(path.join(pdfOutputDir, `${targetBase}.log`), Buffer.from(logB64, 'base64'));
                    }
                } catch (e) {}
            }

            // Nur auf eine ältere Fassung DESSELBEN Dokuments zurückfallen –
            // niemals das PDF eines anderen Dokuments ausliefern.
            const ownPdfs = outputs.filter(f => f.path.endsWith('.pdf') && pdfBelongsTo(f.path, target));
            if (ownPdfs.length === 0) {
                log('ℹ️', '[PDF]', `Es gibt noch keine erfolgreich kompilierte Fassung von '${label}'.`, colors.dim);
                return;
            }

            ownPdfs.sort((a, b) => b.lastModified - a.lastModified);
            freshPdf = ownPdfs[0];
            log('⚠️', '[PDF]', `Lade stattdessen die zuletzt erfolgreich kompilierte Fassung von '${label}' (${new Date(freshPdf.lastModified).toLocaleTimeString()}).`, colors.yellow);
        }

        fs.mkdirSync(pdfOutputDir, { recursive: true });

        const b64 = await page.evaluate((p) => window.__TLX.readOutput(p), freshPdf.path);
        if (!b64) {
            log('❌', '[PDF]', `PDF '${freshPdf.path}' konnte nicht gelesen werden.`, colors.red);
            return;
        }

        // Unter dem Namen des gewählten Dokuments ablegen, damit klar ist,
        // welches Dokument in der Datei steckt.
        const pdfFileName = `${targetBase}.pdf`;
        const pdfFilePath = path.join(pdfOutputDir, pdfFileName);
        fs.writeFileSync(pdfFilePath, Buffer.from(b64, 'base64'));
        const fileSize = fs.statSync(pdfFilePath).size;
        log('✅', '[PDF FERTIG]', `${path.join('output', pdfFileName)} (${(fileSize / 1024).toFixed(1)} KB) ← ${label}`, colors.green);

        if (openPdfAfterPrint) {
            if (openPdfInBrowser(pdfFilePath, browserExecutable)) {
                log('🌐', '[PDF]', `Öffne '${pdfFileName}' in einem neuen Browserfenster...`, colors.dim);
            } else {
                log('⚠️', '[PDF]', `PDF konnte nicht automatisch geöffnet werden – du findest es unter ${path.join('output', pdfFileName)}.`, colors.yellow);
            }
        }

        // Passendes Log mitnehmen (hilfreich für die Fehlersuche)
        const logPath = freshPdf.path.replace(/\.pdf$/, '.log');
        try {
            const logB64 = await page.evaluate((p) => window.__TLX.readOutput(p), logPath);
            if (logB64) {
                fs.writeFileSync(path.join(pdfOutputDir, `${targetBase}.log`), Buffer.from(logB64, 'base64'));
            }
        } catch (e) {}
    }

    // -------------------------------------------------------------------------
    // DATEIEN IN TEXLYRE ANLEGEN (Befehl: new)
    // -------------------------------------------------------------------------

    /** Lokale Dateien (rekursiv), die zum Projekt gehören, aber nicht in TeXlyre existieren. */
    async function listLocalOnlyFiles() {
        const remote = new Set((await page.evaluate(() => window.__TLX.listFiles()))
            .filter(f => !f.isDeleted)
            .map(f => f.path.toLowerCase()));
        const found = [];
        const walk = (dir) => {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const entry of entries) {
                const abs = path.join(dir, entry.name);
                const rel = path.relative(__dirname, abs);
                if (isScriptOwned(rel)) continue;
                if (entry.isDirectory()) {
                    walk(abs);
                } else if (entry.isFile()) {
                    const texPath = localPathToTexlyre(rel);
                    if (isSyncableTexlyrePath(texPath) && !remote.has(texPath.toLowerCase())) found.push(texPath);
                }
            }
        };
        walk(__dirname);
        return found.sort((a, b) => a.localeCompare(b));
    }

    /** "kapitel\intro.tex" / "./kapitel/intro.tex" -> "/kapitel/intro.tex" (oder null, wenn ungültig) */
    function normalizeNewPath(input) {
        const rel = (input || '').trim()
            .replace(/^["']|["']$/g, '')
            .replace(/\\/g, '/')
            .replace(/^(\.\/)+/, '')
            .replace(/^\/+/, '');
        if (!rel) return null;
        const segments = rel.split('/');
        if (segments.some(s => s === '' || s === '.' || s === '..' || /[<>:"|?*]/.test(s))) return null;
        return '/' + rel;
    }

    /**
     * Legt eine Datei in TeXlyre an. Existiert sie lokal bereits, wird ihr
     * Inhalt übernommen; sonst wird sie zusätzlich lokal (leer) angelegt.
     * Textdateien werden als Live-Dokument verknüpft (bidirektional).
     */
    async function createInTexlyre(texPath) {
        const label = docLabel(texPath);
        if (!isSyncableTexlyrePath(texPath)) {
            log('⚠️', '[NEU]', `'${label}' gehört zum Sync-Skript bzw. ist vom Sync ausgeschlossen und wird nicht in TeXlyre angelegt.`, colors.yellow);
            return;
        }

        const localPath = texlyrePathToLocal(texPath);
        const existedLocally = fs.existsSync(localPath);
        if (existedLocally && !fs.statSync(localPath).isFile()) {
            log('⚠️', '[NEU]', `'${label}' ist lokal ein Ordner, keine Datei.`, colors.yellow);
            return;
        }
        const buf = existedLocally ? fs.readFileSync(localPath) : Buffer.alloc(0);
        const text = buf.toString('utf8');

        log('🆕', '[NEU]', `Lege '${label}' in TeXlyre an${existedLocally ? ` (mit dem lokalen Inhalt, ${formatSize(buf.length)})` : ''}...`, colors.cyan);

        // Über die Upload-Warteschlange, damit kein Upload dazwischen den Editor umschaltet
        await new Promise((resolve) => {
            uploadQueue = uploadQueue.then(async () => {
                creatingPaths.set(texPath, text);
                let keepGuard = false;
                try {
                    const result = await page.evaluate((p, b64) => window.__TLX.createFile(p, b64), texPath, buf.toString('base64'));

                    if (!result.ok) {
                        const reasons = {
                            'exists': `'${label}' existiert in TeXlyre bereits.`,
                            'no-api': 'Die Datei-Funktionen von TeXlyre wurden nicht gefunden (ist der Dateibaum sichtbar?).',
                            'parent-is-file': `'${docLabel(result.path)}' ist eine Datei, kein Ordner.`,
                            'not-created': `TeXlyre hat '${label}' nicht angelegt.`
                        };
                        log('❌', '[NEU]', reasons[result.reason] || `Anlegen fehlgeschlagen (${result.reason}).`, colors.red);
                        return;
                    }

                    if (!existedLocally) {
                        fs.mkdirSync(path.dirname(localPath), { recursive: true });
                        fs.writeFileSync(localPath, '');
                    }

                    if (result.isBinary) {
                        log('✅', '[NEU]', `'${label}' als Binärdatei in TeXlyre angelegt (Sync: nur TeXlyre -> lokal).`, colors.green);
                        return;
                    }

                    if (!result.linked) {
                        // Ohne Verknüpfung behält TeXlyre den hochgeladenen Inhalt
                        keepGuard = true;
                        lastSynced.set(texPath, text);
                        log('⚠️', '[NEU]', `'${label}' wurde angelegt, aber nicht als Live-Dokument verknüpft. Klicke in TeXlyre im Dateibaum auf "Link Document", damit lokale Änderungen hochgeladen werden.`, colors.yellow);
                        return;
                    }

                    // TeXlyre öffnet das neue Dokument nach dem Verknüpfen selbst.
                    // Inhalt jetzt über den Editor schreiben (geht live an alle Mitautoren).
                    if (normalizeDoc(text).length > 0) {
                        const ready = async () => page.waitForFunction(
                            (p) => window.__TLX && window.__TLX.editorReadyFor(p),
                            { timeout: 8000, polling: 200 },
                            texPath
                        ).then(() => true).catch(() => false);

                        let isReady = await ready();
                        if (!isReady) {
                            await page.evaluate((p) => window.__TLX.selectFile(p), texPath);
                            isReady = await ready();
                        }
                        const write = isReady
                            ? await page.evaluate((p, t) => window.__TLX.writeToEditor(p, t), texPath, text)
                            : { ok: false, reason: 'not-ready' };
                        if (!write.ok) {
                            log('⚠️', '[NEU]', `'${label}' ist angelegt und verknüpft, aber der lokale Inhalt konnte nicht übertragen werden (${write.reason}). Speichere die Datei in VS Code einmal neu, dann wird er hochgeladen.`, colors.yellow);
                            lastSynced.set(texPath, '');
                            return;
                        }
                        lastLocalSave.set(texPath, Date.now());

                        // Sofort in die verknüpfte Datei speichern lassen und abwarten,
                        // bis der gespeicherte Stand dem lokalen Inhalt entspricht.
                        let saved = false;
                        for (let i = 0; i < 20 && !saved; i++) {
                            if (i % 5 === 0 && result.documentId) {
                                await page.evaluate((id) => window.__TLX.saveLinkedDocument(id), result.documentId).catch(() => {});
                            }
                            await new Promise(r => setTimeout(r, 500));
                            const rec = await page.evaluate((p) => window.__TLX.readFile(p), texPath).catch(() => null);
                            saved = !!(rec && rec.kind === 'text' && normalizeDoc(rec.text) === normalizeDoc(text));
                        }
                        // Falls TeXlyre noch nicht gespeichert hat, bleibt die Sperre aktiv,
                        // bis der Remote-Poll den richtigen Stand sieht.
                        keepGuard = !saved;
                    }
                    lastSynced.set(texPath, text);
                    log('✅', '[NEU]', `'${label}' in TeXlyre angelegt und als Live-Dokument verknüpft (bidirektional).`, colors.green);
                } catch (err) {
                    log('❌', '[NEU]', `${label}: ${err.message}`, colors.red);
                } finally {
                    if (!keepGuard) creatingPaths.delete(texPath);
                    resolve();
                }
            });
        });
    }

    async function doNew(argPath) {
        if (argPath) {
            const texPath = normalizeNewPath(argPath);
            if (!texPath) {
                log('⚠️', '[NEU]', `'${argPath}' ist kein gültiger Dateiname.`, colors.yellow);
                return;
            }
            await createInTexlyre(texPath);
            return;
        }

        // Ohne Namen: lokale Dateien anbieten, die es in TeXlyre noch nicht gibt
        const candidates = await listLocalOnlyFiles();
        const ENTER_NAME = '✏️  Neuen Dateinamen eingeben...';
        const labels = [...candidates.map(docLabel), ENTER_NAME];
        const hints = [...candidates.map(() => `${colors.dim}nur lokal${colors.reset}`), ''];
        const index = await chooseFromMenu('🆕 Welche Datei soll in TeXlyre angelegt werden?', labels, hints, 0);
        if (index < 0) return;

        if (index < candidates.length) {
            await createInTexlyre(candidates[index]);
            return;
        }
        const name = (await askLine(`${colors.cyan}Dateiname (z. B. kapitel1.tex oder kapitel/intro.tex, leer = Abbrechen): ${colors.reset}`)).trim();
        if (!name) return;
        await doNew(name);
    }

    async function handleCommandLine(input) {
        const raw = (input || '').trim();

        // Antwort auf eine offene Rückfrage (Nummern-Dialog ohne TTY)
        if (pendingLineAnswer) {
            const answer = pendingLineAnswer;
            pendingLineAnswer = null;
            answer(raw);
            return;
        }

        const [verb, ...rest] = raw.split(/\s+/);
        const cmd = (verb || '').toLowerCase();
        const cmdArg = rest.join(' ').trim();

        if (cmd === 'new' || cmd === 'neu' || cmd === 'touch') {
            if (isNewRunning || isPrintRunning) {
                log('⏳', '[NEU]', 'Es läuft gerade ein anderer Befehl, bitte kurz warten...', colors.yellow);
                return;
            }
            isNewRunning = true;
            try {
                await doNew(cmdArg);
            } catch (err) {
                log('❌', '[NEU]', err.message, colors.red);
            } finally {
                isNewRunning = false;
            }

        } else if (cmd === 'print' || cmd === 'pdf' || cmd === 'p') {
            if (isPrintRunning || isNewRunning) {
                log('⏳', '[PDF]', 'PDF-Kompilierung läuft bereits, bitte warten...', colors.yellow);
                return;
            }
            isPrintRunning = true;
            try {
                await doPrint(cmdArg);
            } catch (err) {
                log('❌', '[PDF FEHLER]', err.message, colors.red);
            } finally {
                isPrintRunning = false;
            }

        } else if (cmd === 'files' || cmd === 'f' || cmd === 'ls') {
            try {
                const list = await fetchRemoteList();
                const active = await page.evaluate(() => window.__TLX.activePath());
                console.log(`\n${colors.cyan}${colors.bright}Synchronisierte Dateien:${colors.reset}`);
                for (const f of list) {
                    const mark = f.path === active ? `${colors.green}●${colors.reset}` : ' ';
                    const kind = f.isBinary
                        ? `${colors.yellow}nur TeXlyre -> lokal (Binärdatei)${colors.reset}`
                        : f.documentId
                            ? `${colors.green}bidirektional${colors.reset}`
                            : `${colors.yellow}nur TeXlyre -> lokal (nicht verknüpft – "Link Document")${colors.reset}`;
                    console.log(`  ${mark} ${f.path.replace(/^\//, '').padEnd(28)} ${formatSize(f.size).padStart(9)}  ${kind}`);
                }
                console.log(`${colors.dim}  ● = aktuell im TeXlyre-Editor geöffnet${colors.reset}\n`);
            } catch (err) {
                log('❌', '[FILES]', err.message, colors.red);
            }

        } else if (cmd === 'help' || cmd === 'h' || cmd === '?') {
            console.log(`\n${colors.cyan}${colors.bright}Verfügbare Befehle:${colors.reset}`);
            console.log(`  ${colors.green}print${colors.reset} / ${colors.green}pdf${colors.reset} / ${colors.green}p${colors.reset}   – Dokument auswählen (↑/↓ oder Nummer), kompilieren und nach output/ herunterladen`);
            console.log(`  ${colors.green}print <datei>${colors.reset}      – Ein bestimmtes Dokument kompilieren (z. B. ${colors.green}print Document_2.tex${colors.reset})`);
            console.log(`  ${colors.green}print <nr>${colors.reset}         – Dokument Nr. <nr> aus der Auswahlliste kompilieren (z. B. ${colors.green}print 2${colors.reset})`);
            console.log(`  ${colors.green}new <datei>${colors.reset}        – Datei in TeXlyre anlegen (z. B. ${colors.green}new kapitel1.tex${colors.reset} oder ${colors.green}new kapitel/intro.tex${colors.reset})`);
            console.log(`  ${colors.green}new${colors.reset}                – Auswahl lokaler Dateien, die es in TeXlyre noch nicht gibt`);
            console.log(`  ${colors.green}files${colors.reset} / ${colors.green}f${colors.reset}   / ${colors.green}ls${colors.reset}  – Alle synchronisierten Dateien auflisten`);
            console.log(`  ${colors.green}help${colors.reset}  / ${colors.green}h${colors.reset}   / ${colors.green}?${colors.reset}   – Diese Hilfe anzeigen`);
            console.log(`  ${colors.green}Strg+C${colors.reset}             – Live-Sync beenden\n`);

        } else if (cmd.length > 0) {
            log('❓', '[BEFEHL]', `Unbekannter Befehl: "${cmd}". Tippe "help" für verfügbare Befehle.`, colors.yellow);
        }
    }

    function openCommandInterface() {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        rl.on('line', handleCommandLine);

        // Verhindert, dass ein geschlossenes stdin (z. B. bei Pipe oder IDE-Terminal)
        // den Sync-Prozess beendet.
        rl.on('close', () => {
            if (suppressRlCloseNotice) {
                // Absichtlich geschlossen (Auswahlmenü übernimmt die Tastatur)
                suppressRlCloseNotice = false;
                return;
            }
            log('ℹ️', '[STDIN]', 'Eingabe-Kanal geschlossen – Live-Sync läuft weiter. Zum Beenden: Strg+C.', colors.dim);
        });
    }

    openCommandInterface();

    // Sauber beenden bei Strg + C
    process.on('SIGINT', async () => {
        console.log(`\n${colors.yellow}🛑 Live-Sync wird beendet... Schließe Browser.${colors.reset}`);
        try {
            await browser.close();
        } catch (e) {}
        console.log(`${colors.green}✓ Auf Wiedersehen!${colors.reset}`);
        process.exit(0);
    });
}

// --- GLOBALE ABSICHERUNG GEGEN STILLE ABSTÜRZE ---
// Verhindert, dass unbehandelte Promise-Fehler (z. B. wenn der Browser
// unerwartet getrennt wird, während ein page.evaluate() läuft) den
// gesamten Prozess beenden.
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/Target closed|Session closed|detached|Protocol error/i.test(msg)) {
        // Typischer Browser-Disconnect – der 'disconnected'-Handler kümmert sich
        return;
    }
    log('⚠️', '[WARNUNG]', `Unbehandelte Rejection: ${msg}`, colors.yellow);
});

process.on('uncaughtException', (err) => {
    if (/Target closed|Session closed|detached|Protocol error|EPIPE/i.test(err.message)) {
        return;
    }
    log('❌', '[FATALER FEHLER]', err.message, colors.red);
    process.exit(1);
});

runLiveSync().catch((err) => {
    log('❌', '[FATALER FEHLER]', err.message, colors.red);
    process.exit(1);
});
