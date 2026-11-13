// Test-Hilfe: zeigt, was TeXlyre für die angegebenen Pfade gespeichert hat (Dateisystem in IndexedDB),
// und vergleicht optional mit der lokalen Datei.
// Aufruf: node sync-tools/stored.js <Projektordner> /pfad/a.tex [/pfad/b.tex ...]
const fs = require('fs');
const path = require('path');
const puppeteer = require(path.join(__dirname, '..', 'node_modules', 'puppeteer'));

const norm = (s) => (s || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');

(async () => {
    const [dir, ...paths] = process.argv.slice(2);
    const port = fs.readFileSync(path.join(dir, '.texlyre_profile', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    const page = (await browser.pages()).find(p => /texlyre/.test(p.url()));
    let allOk = true;
    for (const p of paths) {
        const rec = await page.evaluate(async (tp) => {
            const all = await window.__TLX.listFiles();
            const meta = all.find(f => f.path === tp && !f.isDeleted) || null;
            const r = await window.__TLX.readFile(tp);
            return { meta: meta && { linked: !!meta.documentId, size: meta.size }, text: r && r.kind === 'text' ? r.text : null };
        }, p);
        const localPath = path.join(dir, ...p.split('/').filter(Boolean));
        const local = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : null;
        const same = rec.text !== null && local !== null && norm(rec.text) === norm(local);
        if (!same) allOk = false;
        const first = (rec.text || '').split('\n').find(l => l.trim()) || '';
        console.log(`${same ? 'OK  ' : 'DIFF'} ${p}  TeXlyre: ${rec.text === null ? 'fehlt' : rec.text.length + ' Z.'}${rec.meta ? (rec.meta.linked ? ', verknüpft' : ', nicht verknüpft') : ''}  lokal: ${local === null ? 'fehlt' : local.length + ' Z.'}  | ${first.slice(0, 70)}`);
    }
    browser.disconnect();
    process.exit(allOk ? 0 : 2);
})().catch(e => { console.error(e); process.exit(1); });
