# TeXlyre Live-Sync Setup

Dieses Projekt ermöglicht es dir, **in deinem bevorzugten lokalen Editor (z. B. VS Code inkl. Antigravity KI, Cursor, TeXstudio, Vim etc.) an LaTeX-Dateien zu arbeiten**, während deine Kollegen gleichzeitig **im Webbrowser über [TeXlyre](https://texlyre.org/texlyre)** am selben Dokument schreiben. 

Ein Live-Sync-Skript synchronisiert alle Änderungen in Echtzeit über das WebRTC-Netzwerk von TeXlyre hin und her (Tastenanschlag für Tastenanschlag, wie in Google Docs).

> **Ordner-Sync:** Das Skript spiegelt **alle Dateien deines TeXlyre-Projekts** mit ihrem richtigen Namen in diesen Ordner – also `main.tex`, `kapitel1.tex`, `anhang.tex` usw. Jede lokale Datei wird gezielt in das passende TeXlyre-Dokument geschrieben. Legst du in TeXlyre ein zweites Dokument an, erscheint es automatisch als eigene lokale Datei. Ausgenommen sind nur die Dateien, die zum Skript selbst gehören (siehe [Ausnahmeliste](#-welche-dateien-werden-synchronisiert)).

---

### ℹ️ Vorkonfiguration & Hinweis für andere Editoren

> **Für VS Code optimiert:** Das Setup ist standardmäßig optimal auf **VS Code** (sowie Derivate wie Cursor oder VSCodium) abgestimmt. Durch die beiliegende Konfigurationsdatei `.vscode/settings.json` speichert VS Code getippte Änderungen automatisch nach einer kurzen Pause (300 ms) auf die Festplatte, von wo das Skript sie sofort überträgt.
>
> **Nutzung in anderen Umgebungen (z. B. TeXstudio, Sublime Text, Neovim, JetBrains):** Das Skript funktioniert grundsätzlich mit **jedem beliebigen Editor**, da es direkt die lokale Datei auf der Festplatte überwacht. In anderen Umgebungen wird jedoch **ein automatisches Speichern (Auto-Save on Delay / Focus Loss) sowie das automatische Neuladen extern geänderter Dateien sehr empfohlen**, um das flüssige Echtzeit-Gefühl zu erhalten. Andernfalls erfolgt die Synchronisation jeweils erst beim manuellen Speichern mit `Strg + S`.

---

## 🏁 Schnellstart-Anleitung (Schritt für Schritt)

### Schritt 1: Raum-ID in TeXlyre ermitteln
1. Öffne deinen Webbrowser und gehe auf: **[https://texlyre.org/texlyre](https://texlyre.org/texlyre)**.
2. Melde dich an oder klicke auf **„Try as Guest“** (Gast-Sitzung starten).
3. Öffne oder erstelle dein gewünschtes LaTeX-Projekt.
4. Schau in die Adresszeile deines Browsers:
   * Die Webadresse lautet z. B.: `https://texlyre.org/texlyre/#yjs:e8092eef-926b-421b-8562-2a6683678bac`
   * Der Text hinter `#yjs:` ist deine **Raum-ID** (z. B. `e8092eef-926b-421b-8562-2a6683678bac`).
   * *(Diesen Link kannst du auch deinen Kollegen schicken, damit sie im Browser mitschreiben).*

---

### Schritt 2: Einmalige Vorbereitung (Abhängigkeiten)
Öffne ein Terminal (z. B. direkt in VS Code mit `Strg + ö` oder in deiner Standard-Konsole / PowerShell) und führe einmalig aus:
```bash
npm install
```
*(Installiert die notwendige Puppeteer-Bibliothek für den Chromium-Hintergrund-Sync).*

---

### Schritt 3: Live-Sync starten
Starte den Sync mit deiner Raum-ID aus Schritt 1:

```bash
npm start -- --room=DEINE_RAUM_ID
```
*(Ersetze `DEINE_RAUM_ID` durch deine echte ID aus Schritt 1).*

#### 💡 Tipp zur Sichtprüfung (`--visible`):
Wenn du sehen möchtest, wie sich der Browser im Hintergrund verbindet und das Dokument öffnet, füge `--visible` an:
```bash
npm start -- --room=DEINE_RAUM_ID --visible
```

---

### Schritt 4: Schreiben & Zusammenarbeiten

Sobald im Terminal das grüne Dashboard erscheint:
* **Du tippst lokal:** In VS Code speichert der Editor dank `.vscode/settings.json` automatisch nach dem Tippen (in anderen Editoren greift das konfigurierte Auto-Save oder ein kurzes `Strg + S`). Das Skript erkennt, **zu welchem TeXlyre-Dokument** die geänderte Datei gehört, schaltet den Web-Editor bei Bedarf automatisch darauf um und überträgt die Änderung live an alle Mitautoren.
* **Kollegen tippen in TeXlyre:** Das Skript empfängt die Änderungen und aktualisiert die passende lokale Datei auf der Festplatte – bei mehreren Dokumenten also `main.tex`, `kapitel1.tex` usw. jeweils einzeln.
* **Mit KI (z. B. Antigravity) arbeiten:** Du kannst Antigravity in VS Code ganz normal bitten, Absätze zu formulieren, Tabellen zu bauen oder Gleichungen einzufügen. Sobald die Datei geändert wird, sind die Ergebnisse im selben Moment live für alle Mitautoren in TeXlyre sichtbar!

---

## 📁 Welche Dateien werden synchronisiert?

Synchronisiert wird **alles, was im TeXlyre-Projekt liegt** – mit dem jeweils richtigen Dateinamen, auch in Unterordnern.

**Nicht** synchronisiert werden die Dateien, die zum Sync-Skript selbst gehören:

| Ordner | Dateien |
| :--- | :--- |
| `node_modules/`, `.git/`, `.vscode/`, `.idea/`, `.texlyre_profile*/` (auch Kopien wie `.texlyre_profile_backup/`), `output/` | `sync.js`, `headless-sync.js`, `package.json`, `package-lock.json`, `README.md`, `.gitignore` sowie alle `*.zip` und `*.log` |

Ebenfalls ausgenommen sind die TeXlyre-internen Ordner `/.texlyre_cache/` und `/.texlyre_src/` (LaTeX-Paket-Cache und Compiler-Zwischenprodukte).

Weitere Dateien kannst du mit `--ignore=` ausschließen:
```bash
node sync.js --room=DEINE_ID --ignore=notizen.tex,entwurf.tex
```

### Zwei Arten von Dateien in TeXlyre

TeXlyre unterscheidet zwischen **verknüpften Live-Dokumenten** und **statischen Dateien**:

| Art | Erkennbar an | Sync-Richtung |
| :--- | :--- | :--- |
| **Live-Dokument** | Punkt-Symbol (•) im TeXlyre-Dateibaum | ⬌ **bidirektional** (Echtzeit in beide Richtungen) |
| **Statische Datei** | kein Punkt-Symbol | ➡️ nur **TeXlyre → lokal** |

Möchtest du eine statische Datei auch lokal bearbeiten können, klicke in TeXlyre im Dateibaum neben der Datei auf **„Link Document“**. Danach ist sie bidirektional. Der Befehl `files` im Terminal zeigt dir jederzeit, welche Datei welchen Status hat.

> **Binärdateien** (Bilder, PDFs) werden von TeXlyre nach lokal übertragen. Geänderte Bilder lädst du bitte direkt in TeXlyre hoch.

### Neue Dateien direkt aus dem Terminal anlegen

Du musst TeXlyre dafür nicht öffnen. Tippe im laufenden Sync:

```
new kapitel1.tex
new kapitel/intro.tex        (fehlende Ordner werden mit angelegt)
new                          (Auswahlmenü aller lokalen Dateien, die es in TeXlyre noch nicht gibt)
```

> **Kurzformen:** Statt `new` funktionieren auch `neu` und `touch`.

* **Textdateien** (`.tex`, `.bib`, `.sty` …) werden in TeXlyre angelegt und automatisch als **Live-Dokument verknüpft**. Sie sind damit sofort bidirektional und für alle Mitautoren sichtbar.
* **Gibt es die Datei lokal schon** (z. B. in VS Code angelegt), wird ihr Inhalt übernommen. Sonst wird sie zusätzlich lokal als leere Datei angelegt, und du kannst sie direkt in VS Code öffnen.
* **Bilder und andere Binärdateien** werden hochgeladen und laufen danach nur noch von TeXlyre nach lokal.
* Speicherst du eine neue Datei in VS Code, bevor es sie in TeXlyre gibt, zeigt das Terminal den passenden `new`-Befehl an.

```
🆕 [NEU] Lege 'kapitel1.tex' in TeXlyre an (mit dem lokalen Inhalt, 1.2 KB)...
✅ [NEU] 'kapitel1.tex' in TeXlyre angelegt und als Live-Dokument verknüpft (bidirektional).
```

---

## 📊 Terminal-Dashboard & Verbindungs-Kontrollen

Beim Start durchläuft das Skript mehrere automatische Verbindungskontrollen:

| Schritt | Status | Bedeutung |
| :--- | :--- | :--- |
| **1/4** | 📡 `[ONLINE]` | Prüft die Erreichbarkeit der TeXlyre-Server über das Internet. |
| **2/4** | 🚀 `[BROWSER]` | Startet die Chromium-Instanz mit persistentem Profil (`.texlyre_profile`). |
| **3/4** | 🌐 `[NAV]` | Öffnet den kollaborativen WebRTC-Raum. |
| **4/4** | 🔐 `[AUTH]` | Erkennt Login-Dialoge und schaltet die Gast-Session automatisch frei. |
| **Bereit** | 🟢 `[EDITOR BEREIT]` | CodeMirror 6 wurde gefunden und die bidirektionale Verbindung steht. |

### Während des Betriebs:
* 📥 `[Remote] 1.2 KB`: Änderungen von Mitautoren empfangen -> Lokale Datei aktualisiert (gedrosselt & kompakt).
* 📤 `[Lokal] 1.2 KB`: Lokale Änderungen an TeXlyre übertragen -> Für Mitautoren live.
* ❌ `[LATEX FEHLER] in '<dokument>'`: Prägnanter Fehlerfilter. Zeigt fehlerhafte Zeilen und Fehlermeldungen live im Terminal, jeweils mit dem betroffenen Dokument, und schreibt sie in `texlyre-errors.log`.
* 🟢 `[LATEX OK] '<dokument>'`: Bestätigt, sobald die Fehler in diesem Dokument behoben sind und die Kompilierung sauber durchläuft.
* ✨ `[DESIGN]`: Versteckt störende Autornamen-Badges über dem Text, behält jedoch die leuchtende Umrandung der Mitnutzer-Cursor bei.

---

## 🖨️ PDF kompilieren & herunterladen (Interaktiver Befehl)

Während der Live-Sync läuft, kannst du jederzeit **im selben Terminal** einen kurzen Befehl eintippen, um das aktuelle Dokument zu kompilieren und das fertige PDF lokal herunterzuladen – **ohne** den Sync zu unterbrechen:

```
print
```

> **Kurzformen:** Statt `print` funktioniert auch `pdf` oder einfach nur `p`.

Hat das Projekt mehrere `.tex`-Dateien, erscheint ein **Auswahlmenü**:

```
🖨️  Welches Dokument soll kompiliert werden?
   ↑/↓ wählen · Enter bestätigen · 1–3 direkt wählen · Esc abbrechen
 ❯ 1) main.tex          ● im Editor geöffnet
   2) Document_2.tex
   3) new_2file.tex     kein \documentclass (Teildatei?)
```

* **Pfeiltasten ↑/↓** und **Enter**, oder einfach die **Nummer** drücken (`1`, `2`, `3` …).
* **Esc** (oder `q`) bricht ab.
* Vorausgewählt ist das zuletzt gedruckte Dokument, sonst `main.tex`.
* Hinweise neben den Einträgen: `● im Editor geöffnet`, `❌ hat LaTeX-Fehler`, `kein \documentclass` (eine Teildatei, die nur über `\input` eingebunden wird und allein nicht kompiliert).

Danach:
1. Öffnet das Skript das gewählte Dokument in TeXlyre, denn TeXlyre kompiliert immer das gerade geöffnete Dokument.
2. Es löst die Kompilierung aus und wartet, bis sie abgeschlossen ist.
3. Es legt das PDF **unter dem Namen des gewählten Dokuments** zusammen mit dem LaTeX-Log in `output/` ab.
4. Es öffnet das PDF automatisch in einem **neuen Fenster deines Browsers** (Chrome, Edge oder Brave mit deinem normalen Profil). Ohne einen solchen Browser öffnet sich der Standard-PDF-Betrachter des Systems. Abschalten lässt sich das mit `--no-open` beim Start.

```
🖨️ [PDF] Kompiliere 'Document_2.tex' und lade das PDF herunter...
⏳ [PDF] Kompiliere 'Document_2.tex'... bitte warten.
✅ [PDF FERTIG] output\Document_2.pdf (145.6 KB) ← Document_2.tex
🌐 [PDF] Öffne 'Document_2.pdf' in einem neuen Browserfenster...
```

### Ohne Menü direkt ein Dokument kompilieren
```
print Document_2.tex     (oder: print Document_2)
print 2                  (Nr. 2 aus der Auswahlliste)
```

### Wenn die Kompilierung fehlschlägt
Das Skript bricht dann zügig ab und zeigt den LaTeX-Fehler **mit dem Namen des betroffenen Dokuments** an. Ersatzweise lädt es die zuletzt erfolgreich kompilierte Fassung **desselben** Dokuments herunter, nie das PDF eines anderen:

```
❌ [PDF] Die Kompilierung von 'new_2file.tex' hat kein neues PDF erzeugt.
   Fehler in 'new_2file.tex':
   ! LaTeX Error: Missing \begin{document}.
💡 [PDF TIPP] 'new_2file.tex' enthält kein \documentclass – vermutlich eine Teildatei ...
```

Auch die laufenden Fehlermeldungen im Terminal und in `texlyre-errors.log` nennen jeweils das Dokument:

```
❌ [LATEX FEHLER] in 'Document_2.tex'
! Undefined control sequence.
🟢 [LATEX OK] 'Document_2.tex' kompiliert wieder fehlerfrei.
```

> **Tipp:** Tippe `help` im Terminal, um alle verfügbaren interaktiven Befehle aufzulisten.

---

## ⚙️ Befehlsübersicht

| Befehl | Beschreibung |
| :--- | :--- |
| `npm start -- --room=<ID>` | Startet den Live-Sync im Hintergrund (Headless). |
| `npm run sync:visible -- --room=<ID>` | Startet den Sync mit sichtbarem Browserfenster. |
| `node sync.js --url=<URL>` | Startet den Sync direkt mit vollständiger URL. |
| `node sync.js --file=kapitel1.tex` | Synchronisiert **nur** diese eine Datei statt des ganzen Ordners. |
| `node sync.js --ignore=a.tex,b.tex` | Schließt zusätzliche Dateien vom Sync aus. |
| `node sync.js --delete-removed` | Löscht lokale Dateien, wenn sie in TeXlyre gelöscht wurden. |
| `node sync.js --no-open` | Öffnet das PDF nach `print` nicht automatisch im Browser. |
| `node sync.js --remote-poll=<ms>` | Abstand der Prüfung auf Änderungen in anderen Dateien (Standard: 1000). |
| `node sync.js --help` | Zeigt alle verfügbaren Parameter und Hilfen an. |
| `Strg + C` | Beendet den Live-Sync sauber und schließt den Browser. |

**Interaktive Befehle** *(während der Sync läuft, im selben Terminal eingeben)*:

| Befehl | Beschreibung |
| :--- | :--- |
| `print` / `pdf` / `p` | Öffnet das Auswahlmenü (↑/↓ oder Nummer), kompiliert das gewählte Dokument und lädt das PDF in `output/` herunter. |
| `print <datei>` | Kompiliert gezielt ein bestimmtes Dokument (z. B. `print Document_2.tex`). |
| `print <nr>` | Kompiliert Dokument Nr. `<nr>` aus der Auswahlliste (z. B. `print 2`). |
| `new <datei>` / `neu` / `touch` | Legt die Datei in TeXlyre an und verknüpft sie als Live-Dokument (Ordner werden mit angelegt). |
| `new` | Auswahlmenü der lokalen Dateien, die es in TeXlyre noch nicht gibt (oder neuen Namen eingeben). |
| `files` / `f` / `ls` | Listet alle synchronisierten Dateien samt Sync-Richtung auf und markiert das aktuell geöffnete Dokument. |
| `help` / `h` / `?` | Zeigt die verfügbaren interaktiven Befehle an. |

---

## ❓ Häufige Fragen & Fehlerbehebung


### Ich habe in TeXlyre ein zweites Dokument angelegt – was passiert?
Es erscheint beim nächsten Abgleich automatisch als eigene Datei in diesem Ordner (mit dem Namen aus TeXlyre). Beide Dokumente lassen sich unabhängig voneinander lokal bearbeiten; das Skript ordnet jede Änderung dem richtigen Dokument zu und schaltet den Web-Editor im Hintergrund um. Im Terminal siehst du das an der Zeile `🔀 [DOKUMENT] Wechsle Editor auf '...'`.

### Was passiert beim Start, wenn lokal und in TeXlyre unterschiedliche Stände liegen?
Beim Start gilt **TeXlyre als maßgeblich** (dort können Mitautoren gearbeitet haben, während dein Sync aus war). Damit nichts verloren geht, legt das Skript vorher eine Sicherungskopie deiner abweichenden lokalen Fassung an:

```
⚠️  Beim Start galt die TeXlyre-Fassung als maßgeblich. Abweichende lokale
    Versionen wurden vorher gesichert in:
    output\_backup_2026-09-21T00-57-13-406Z
```

Der Ordner `output/` wird selbst nie synchronisiert – die Sicherung landet also nicht versehentlich in TeXlyre.

### Im Terminal steht „Upload abgebrochen“ – ist etwas kaputt?
Nein, das ist das Sicherheitsnetz. Das Skript schreibt nur dann in ein Dokument, wenn im Web-Editor nachweislich das richtige und vollständig geladene Dokument geöffnet ist. Andernfalls verwirft es den Upload lieber, statt Text in die falsche Datei zu schreiben oder ihn zu verdoppeln. Deine nächste Speicherung überträgt die Änderung erneut.

### Ich sehe im Terminal einen Fehler beim Laden des Editors?
Starte das Skript einmal mit dem Parameter `--visible`:
```bash
node sync.js --room=DEINE_RAUM_ID --visible
```
Dadurch öffnet sich das Chromium-Fenster und du kannst sehen, ob TeXlyre eventuell nach einem Login fragt oder eine Bestätigung erwartet. Nach einmaliger Anmeldung wird der Zustand im Ordner `.texlyre_profile` gespeichert.


Fixes needed: 
Editor erkennt nicht und läd nicht dokumente hoch die neu sind, wechselt nicht zwischen dokumenten: muss sicher eingebaut werden und auch möglich sein in verschiedenen dokumenten zu schreiben und alles wird sauber übernommen. außerdem das in texlyre gespeicherte hat immer priorität wenn ein dokument neu gelinkt wird und es unterschiede hat. dann wird aber eine sicherheitskopie abgelegt in extra ordner