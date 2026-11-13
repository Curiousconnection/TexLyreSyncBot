// Diagnose: verbindet sich mit dem laufenden Hintergrund-Browser eines Syncs (DevToolsActivePort im Profil)
// und gibt Seitenzustand, IndexedDB-Datenbanken und Dateizahl je Projekt-DB aus.
// Aufruf: node sync-tools/diag.js <Projektordner> [js-ausdruck]
const fs = require('fs');
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer'));

(async () => {
    const dir = process.argv[2];
    const port = fs.readFileSync(path.join(dir, '.texlyre_profile', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    const pages = await browser.pages();
    for (const page of pages) {
        const url = page.url();
        if (!/texlyre/.test(url)) continue;
        const info = await page.evaluate(async (expr) => {
            const out = { url: location.href, title: document.title };
            out.dbs = (await indexedDB.databases()).map(d => d.name + ' v' + d.version);
            out.tlx = !!window.__TLX;
            out.editor = !!document.querySelector('.cm-content');
            out.fileNodes = document.querySelectorAll('.file-node').length;
            const counts = {};
            for (const d of await indexedDB.databases()) {
                if (!/project/.test(d.name)) continue;
                try {
                    const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
                    const stores = [...db.objectStoreNames];
                    const c = {};
                    for (const s of stores) {
                        c[s] = await new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).count(); r.onsuccess = () => res(r.result); r.onerror = () => res('err'); });
                    }
                    counts[d.name] = c;
                    db.close();
                } catch (e) { counts[d.name] = 'err ' + e.message; }
            }
            out.counts = counts;
            if (expr) { try { out.expr = await eval(expr); } catch (e) { out.expr = 'ERR ' + e.message; } }
            return out;
        }, process.argv[3] || '');
        console.log(JSON.stringify(info, null, 1));
    }
    browser.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
