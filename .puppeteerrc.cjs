/**
 * Puppeteer Konfiguration
 * Verhindert den fehleranfälligen und langsamen automatischen Download von Chromium
 * bei 'npm install', da sync.js automatisch vorhandene System-Browser (Chrome / Edge) nutzt.
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
    skipDownload: true
};

