# BeatBlade

Selbst gehostetes VR-/MR-Rhythmusspiel für den Browser (Meta Quest 3/3S/Pro, andere WebXR-Headsets).
Zwei Spielmodi: **Schnitt** – Blöcke im Takt mit zwei Lichtschwertern in Pfeilrichtung zerschneiden, rot links,
blau rechts – und **Orbit** – Kugeln an den Händen, Notenkugeln auf einer freien Fläche berühren und Rails folgen.
Eigenes Design, keine fremden Assets. Levels werden **automatisch aus der Musik erzeugt**.

Man lädt von jedem Gerät (Handy, PC, Tablet, auch aus der Brille) Musik hoch, der Server analysiert im
Hintergrund, und der Song erscheint live in der Bibliothek – auch in der Brille, ohne Neuladen.

## Starten

```bash
cp .env.example .env        # Werte anpassen (AUTH_MODE, PUBLIC_URL …)
docker compose up -d        # Image ghcr.io/l8tenever/beatblade:latest (oder lokal bauen: docker compose build)
```

Danach unter `http://<host>:3000/beatblade/` (bzw. hinter dem Reverse-Proxy). **WebXR braucht HTTPS** –
für die Brille also über den Reverse-Proxy/Cloudflare aufrufen.

Beim ersten Start werden die mitgelieferten Songs (siehe Credits) importiert und analysiert – nach
etwa einer Minute sind sie spielbar.

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `BASE_PATH` | `/beatblade` | Unterpfad (muss beim Image-Build gleich sein, `--build-arg BASE_PATH=…`) |
| `AUTH_MODE` | `open` | `open`, `password` (gemeinsames Passwort, HttpOnly-Cookie) oder `cloudflare` (Cloudflare Access davor, App-Login aus) |
| `APP_PASSWORD`, `SESSION_SECRET` | – | nur für `password` |
| `MAX_UPLOAD_MB` | `50` | max. Dateigröße |
| `UPLOADS_PER_MINUTE` | `20` | Rate-Limit pro IP |
| `CONCURRENCY` | CPU-Kerne − 1 | parallele Analysen (Worker-Threads) |
| `PUBLIC_URL` | aus Request | Adresse für den QR-Code im Headset |
| `IMPORT_SEEDS` | `true` | mitgelieferte Songs importieren |
| `DATA_DIR` | `/data` | SQLite, Audio, Analysen, Levels (Volume) |
| `YTDLP_PATH` | `yt-dlp` | Programm für den YouTube-Import (im Image enthalten, aktualisiert sich beim Start) |
| `YT_MAX_MINUTES` | `15` | maximale Länge eines YouTube-Videos |

### Reverse-Proxy / Cloudflare

- Der Container lauscht auf Port 3000; alles liegt unter `BASE_PATH` (Web-App und `BASE_PATH/api`).
- Cloudflare Tunnel: Ingress-Regel für den Hostnamen mit Pfad `^/beatblade` auf `http://<host>:3000`.
- Server-Sent Events (`/api/events`) brauchen ungepuffertes Weiterleiten (Header `X-Accel-Buffering: no` ist gesetzt; bei nginx `proxy_buffering off`).
- Bei `AUTH_MODE=cloudflare` eine Access-Application für `host/beatblade` anlegen.

## Bedienung

- **Bibliothek** (`/beatblade/`): Upload per Drag & Drop oder Dateiauswahl (MP3, M4A, OGG, FLAC, WAV;
  Erkennung per Magic Bytes), Fortschritt pro Datei, danach Live-Status *In Warteschlange → Dekodieren →
  Analysieren → Level generieren → Fertig*. Tags/Cover werden ausgelesen und sind editierbar,
  Duplikate (SHA-256) werden erkannt. **SoundCloud durchsuchen**: Suchbegriff eingeben, Treffer mit Cover, Artist und
  Länge, *Hinzufügen* lädt den Track (Go+-Tracks gehen nicht). **Eigene Songs:** einmal das SoundCloud-Profil eintragen,
  dann *Meine Likes* / *Meine Tracks* oder einen Playlist-Link anzeigen und einzeln oder *Alle hinzufügen*.
  **In VR:** Lobby → *＋ Songs hinzufügen*: Suche per Bildschirm-Tastatur, Likes/Tracks, Fortschritt direkt in der Brille. **YouTube- oder SoundCloud-Link einfügen** lädt nur die Tonspur (MP3, mit Titel/Artist und
  Vorschaubild als Cover) und importiert sie wie einen Upload; Fortschritt live in der Liste. Downloads laufen
  nacheinander. Nur Inhalte laden, die du nutzen darfst – YouTube erlaubt Downloads laut Nutzungsbedingungen nicht.
  Verlangt YouTube eine Anmeldung („Bot-Prüfung“, typisch bei Servern im Rechenzentrum): unter *YouTube-Cookies*
  eine `cookies.txt` (Netscape-Format, z. B. per Browser-Erweiterung von youtube.com exportiert) hochladen;
  sie liegt nur als `<DATA_DIR>/youtube-cookies.txt` auf dem Server. Am besten ein Zweit-Konto verwenden. Suchen, sortieren, filtern, neu generieren, neu analysieren,
  ausblenden, löschen, Job-Log.
- **Debug-Ansicht** (`debug.html?song=ID`): Wellenform, Beats/Takte, Onsets je Band, Abschnitte,
  Energie, Noten/Bomben/Wände und Lichtshow als Zeitleiste, mit Abspielen, Metronom- und Noten-Klick.
  Umschalter **Modus Schnitt/Orbit**: Orbit zeigt Höhe und Seite jeder Kugel, Rails als Linien je Hand,
  Gold/Grün, Wände/Ducken und die Orbit-Werte (Rails, schnellste Handbewegung, Probleme).
- **Spielen** (`play.html`): *VR starten* oder *MR starten* (Passthrough, nur Blöcke und dezente Effekte).
  Man landet in einer kleinen **Lobby**, alles in Reichweite, ohne sich zu bewegen: in der Mitte die
  Song-Auswahl (mit Bestwert je Song) und das Song-Detail (**Modus Schnitt/Orbit**, Schwierigkeit, Variante,
  Modifikatoren Schneller / Keine Wände / Keine Bomben, *Starten*; der zuletzt gewählte Modus gilt für alle Songs), links die **Bestenliste** zum gewählten Song, rechts die
  **Einstellungen** in Gruppen (Spiel, Aussehen, Audio, Komfort, Mehr). Im Hintergrund läuft eine zufällige
  Map. Menüs per Laserpointer (Abzug/Pinch = Klick), Thumbstick blättert. *Upload vom Handy* (unter „Mehr“)
  zeigt einen QR-Code. Pause: B/Y-Taste oder Brille absetzen/Systemmenü, Weiterspielen mit 3-s-Countdown;
  die Bahn richtet sich bei Start und Weiterspielen nach Kopf und Blickrichtung aus.
- **Desktop-Debugmodus**: Autoplay schneidet alle Noten bzw. berührt alle Kugeln (Taste `A` schaltet auf
  Maus-Steuerung der rechten Hand), `O` wechselt den Modus, `Esc` = Pause. `play.html?mode=orbit` wählt Orbit vor.

## Spielmodus Orbit

Statt Schwertern sitzen **Kugeln an den Händen**. Notenkugeln fliegen auf eine Trefferfläche vor dir zu und
liegen dort frei im Raum (nicht in einem Raster); du berührst sie im Takt mit der Kugel der passenden Hand.

- **Normale Kugeln** (rot/blau): nur mit der Hand ihrer Farbe.
- **Gold**: groß, in der Mitte – mit **beiden Händen** gleichzeitig berühren (Drop-Starts und starke Akzente).
  **Gold-Rails** (breite goldene Bahn, ab Normal, selten an energiereichen Stellen): beide Hände links und rechts
  daneben mitführen; bringen doppelte Rail-Punkte.
- **Grün**: Läufe in ruhigen, melodischen Passagen – **eine Hand nach Wahl**: die Hand, die die erste grüne Kugel
  berührt, gilt für den ganzen Lauf (der Ring der restlichen Kugeln zeigt dann ihre Farbe).
- **Rails**: leuchtende Bahnen auf gehaltenen Klängen (Pads, Gesang); die Hand folgt der Kurve, die Höhe folgt der
  Tonhöhe. Eine Rail zählt, wenn man mindestens **80 %** der Zeit an ihr bleibt; der gespielte Teil verschwindet.
  Die Rail färbt sich nach dem gehaltenen Anteil: voll in Handfarbe = sauber gefolgt, grau = verloren.
- **Hindernisse**: dieselben Wände (und Wand-Skins) wie bei Schnitt – ausweichen oder ducken.
- **Wertung**: Perfekt / Gut / Schlecht nach dem Abstand beim Berühren (als Schrift über der Kugel, ebenso
  *Verpasst* und *Rail ✓ / Rail verloren*; im Komfortmodus nur die Fehler), Verpasst senkt die Prozent; Prozent und
  Sterne wie bei Schnitt. Alle Werte oben in `apps/web/src/game/orbit/orbitscore.ts`, Darstellung in
  `apps/web/src/game/orbit/orbit.ts`.
- Linkshänder-Spiegelung, Spielergröße, *Schneller*, *Keine Wände*, Pause/Countdown, MR und Autoplay gelten auch hier.
- **Highscores** sind nach Modus getrennt (bestehende Einträge gehören zu Schnitt).

Die Level werden aus derselben Analyse automatisch erzeugt (`packages/core/src/mapping/orbit/`): gleiche
Zeit-Auswahl wie Schnitt (`mapping/timing.ts`), Hände nach Kick bzw. Snare/Hi-Hat und Abwechseln bei schnellen
Folgen, Bewegungsmuster je 2-Takt-Phrase (Bogen, Welle, Kreis, Lift, Pendel, Stufen; Wiederholungen gespiegelt),
Rails aus den Analyse-Werten `sustain`/`pitch`, Gold/Grün, Wände; danach Validierung (Handgeschwindigkeit,
Überkreuzen, Abstand gleichzeitiger Kugeln, Kugeln in Wänden, Bereich, Rails, Dichte) mit Spielbarkeits-Score.
Alle Stellschrauben: `packages/core/src/mapping/orbit/tuning.ts`. Orbit-Levels haben eine eigene Version
(`ORBIT_MAPPING_VERSION`): Änderungen erzeugen nur die Orbit-Levels neu, Schnitt bleibt unberührt.

## Wertung

Kein Game Over: jeder Song läuft bis zum Ende. Die Genauigkeit startet pro Song bei 100 %; Treffer heben
sie an (max. 100 %), verpasste Blöcke, Fehlschläge (falsche Richtung/Farbe), Bomben und Zeit in Wänden
senken sie. Am Ende: Prozent + Sterne (5 ★ = 100 %, 4 ★ ab 90 %, 3 ★ ab 75 %, 2 ★ ab 50 %, 1 ★ ab 25 %).
Alle Werte als Konstanten oben in `apps/web/src/game/score.ts`. Highscores werden nach Prozent sortiert.

**Pfeile: Pflicht/egal** – bei *Pflicht* zählt eine falsche Schlagrichtung als Fehler, bei *egal* jeder saubere
Schnitt. **Verfehlt = stumm** (Standard aus) – sobald ein Block verfehlt ist (vorbeigeflogen oder Fehlschlag), setzt die Musik kurz aus; getroffene Blöcke lösen nie einen Aussetzer aus (Werte oben in
`apps/web/src/audio/player.ts`). Weil der Song als fertige Mischung vorliegt, verstummt kurz alles, nicht nur ein
einzelnes Instrument.

## Eigene Inhalte (Blöcke, Schwerter, Farben, Maps, Wände, Orbit-Kugeln)

Alles, was man auswählen kann, liegt als Ordner mit einer `info.json` in `content/`:

```
content/
  blocks/<name>/info.json    Block-Skins      style: neon-cube | crystal | retro-pixel | pumpkin | gift   oder  model: datei.glb
  sabers/<name>/info.json    Schwerter        style: classic | katana | neon-stab        oder  model: datei.glb (z. B. frostklinge, glutklinge)
  colors/<name>/info.json    Farbsets         left: "#rrggbb", right: "#rrggbb"
  maps/<name>/info.json      Maps             style: neon-runway | space | synthwave | halloween | christmas | underwater
                                              | neon-city | volcano; wallSkin: <Wand-Ordner>; optional blockSkin, colorSet
  walls/<name>/info.json     Wand-Skins       style: neon-glass | energy | stone-metal | ice | mist
  orbs/<name>/info.json      Orbit-Handkugeln style: glow | ring | crystal | blackhole   oder  model: datei.glb
  orbnotes/<name>/info.json  Orbit-Noten      style: neon | crystal | ring | pumpkin | ornament | blackhole   oder  model: datei.glb
                                              Rail-Aussehen: railWidth (m, 0,008–0,06), railOpacity (0,2–1), railGlow (true/false)
```

Gemeinsame Felder: `name`, `description`, `order` (Reihenfolge, klein = vorne), optional `preview` (Bild im
selben Ordner). Ordnernamen nur aus `a-z`, `0-9`, `-` und `_`.

**Neuen Inhalt hinzufügen, ohne neu zu bauen:** Ordner im Daten-Volume unter `<DATA_DIR>/content/<kategorie>/<name>/`
anlegen (im Docker-Container also `/data/content/...`) und den Container neu starten. Gleicher Ordnername wie ein
mitgelieferter Eintrag ersetzt diesen. Kaputte `info.json` werden übersprungen und im Log gemeldet.

Beispiel – eigener Block aus einem 3D-Modell:

```json
{ "name": "Mein Block", "description": "Selbst gebaut", "model": "block.glb", "preview": "vorschau.png" }
```

- **Block-Modell:** die erste Geometrie im `.glb` wird zentriert und auf Blockgröße skaliert, Vorderseite = +Z
  (dort sitzt der Pfeil). Die Farbe kommt pro Block, das Modell sollte also hell/weiß sein.
- **Schwert-Modell:** die längste Achse wird zur Klinge, das Griffende liegt in der Hand; `bladeLength`
  (0,5–1,4 m) ändert nur das Aussehen – die Treffer-Zone bleibt immer 1 m, das Spielgefühl ist gleich.
- **Schwert mit eigenem Leuchtrand** (wie Frostklinge und Glutklinge): Materialnamen im `.glb` steuern das Leuchten –
  `glow…` = Leuchtrand/Muster in der Handfarbe, `glowcore…` = heller Kern, `glowsoft…` = weiches Glühen (additiv,
  Vertex-Farben als Verlauf, wird mit der Combo stärker); alle anderen Materialien bleiben, wie modelliert. Modell entlang
  −Z (Spitze), Griffende bei +0,14 m, 1 m Klinge, Gesamtlänge 1,2 m. Die beiden mitgelieferten Schwerter werden
  prozedural gebaut: `apps/web/tools/swords/swords.ts` (Formen als Zahlenlisten: Klingen-Umriss, Leuchtstriche,
  Parierstange, Rauten, Griff) – neues Schwert = neuen Eintrag dort anlegen und
  `node tools/swords/build.mjs` (in `apps/web`, braucht Playwright) laufen lassen; das schreibt `schwert.glb` und
  `preview.jpg` nach `content/sabers/<name>/`, dazu eine `info.json` mit `"model": "schwert.glb"` anlegen.
  Kantige Tron-Schwerter mit Aussparungen, Leuchtschlitzen und Leuchtblöcken (Gitterklinge, Neonsäbel) entstehen in
  `apps/web/tools/swords/tron.ts`; nur einzelne bauen: `node tools/swords/build.mjs <bild-ordner> gitterklinge,neonsaebel`.
  **Länge:** `bladeLength` (0,5–1,4 m) ändert nur die sichtbare Länge; die Treffer-Zone bleibt für alle Schwerter 1 m
  (Gitterklinge 0,85 m, Neonsäbel 1,15 m sichtbar), damit sich das Treffen nicht je Schwert anders anfühlt.
- **Map:** `wallSkin` nennt die Wand, die automatisch dazu passt (Einstellung „Wände: Automatisch“).
  Themen-Maps können mit `blockSkin` und `colorSet` eigene Blöcke und Farben mitbringen (Halloween: Kürbisse
  in Orange/Lila, Weihnachten: Geschenke in Rot/Grün); eigene Farben links/rechts gelten weiterhin.
  Mit `orbNoteSkin` bringen sie auch eigene Orbit-Noten mit (Halloween: Kürbisse, Weihnachten: Christbaumkugeln).
- **Orbit-Noten-Modell:** wie beim Block-Modell, wird auf Kugelgröße skaliert; hell/weiß modellieren.
- **Handkugel-Modell:** wird zentriert, auf Kugelgröße skaliert, in der Handfarbe getönt und dreht sich langsam;
  die Treffer-Zone bleibt immer gleich groß. Schlägt das Laden fehl, gilt der eingebaute Stil.
- **Vorschaubild:** `preview` (z. B. `preview.jpg`, quadratisch, 256×256) erscheint im Auswahl-Menü.
- Liste aller Inhalte: `GET /beatblade/api/content`.

## Architektur

```
packages/core   Analyse (STFT, Multi-Band-Onsets, Tempo, Beat-Tracking, Takt, Energie, Struktur) +
                Mapping (Generator, Muster, Parity, Waende/Bomben, Lichtshow, Validierung), Typen, Tuning
apps/server     Fastify-API, Upload, persistente Job-Queue (SQLite), Worker-Threads, ffmpeg, SSE, Seed-Import;
                Levels je Modus: beatmaps/<diff>-<seed>.json (Schnitt), beatmaps/orbit-<diff>-<seed>.json (Orbit),
                API mit ?mode=schnitt|orbit (Level, Bestenliste, Bestwerte, Score speichern)
apps/web        Vite + Three.js: Bibliothek/Upload, Debug-Ansicht, WebXR-Spiel (Lobby, Skins, Maps)
content         auswählbare Inhalte: Blöcke, Schwerter, Farben, Maps, Wände, Orbit-Kugeln (je Ordner eine info.json)
seed-songs      credits.json (CC-BY-Songs, werden beim Build geladen)
```

### Analyse (packages/core/src/analysis)

1. STFT (Hann 2048 / Hop 512, 44,1 kHz Mono) in einem Durchlauf: Spectral Flux in 4 Bändern
   (Sub 20–150, Low-Mid 150–800, High-Mid 800–5000, High 5–16 kHz), Band-Energie, RMS, Schwerpunkt,
   Chroma, MFCC, Anteil 300–3400 Hz (Melodie/Gesang).
2. Onsets je Band: Normalisierung, adaptive Schwelle (gleitender Median × Faktor + Delta), Peak-Picking.
3. Tempo: Tempogramm (gefensterte Autokorrelation), Harmonische, log-Gauss-Prior um 120 BPM; Oktav-Prüfung
   über Kick/Snare-Verteilung und bevorzugten Bereich 70–180 BPM.
4. Beat-Tracking nach Ellis (dynamische Programmierung), Regression für exakte BPM, Begradigung bei
   stabilem Tempo, Phasen-Feinjustierung.
5. Takt/Downbeat: Bass, Bass-Onsets, Akkordwechsel je Beat; 4/4 oder 3/4 (nur wenn eindeutig).
6. Struktur: Takt-Merkmale → Self-Similarity-Matrix → Checkerboard-Novelty + Energiesprünge → Abschnitte
   (auf 4er-Phrasen eingerastet) → Intro/Strophe/Build-up/Drop/Breakdown/Outro, Wiederholungsgruppen.
7. Für Orbit je Beat: `sustain` (Melodie vorhanden und Harmonie stabil = gehaltener Klang, Grundlage der Rails)
   und `pitch` (Tonhöhe des melodischen Anteils, je Song normiert – Form der Rails).

### Mapping (packages/core/src/mapping)

Raster-Slots (1/1, 1/2, 1/4; Expert+ auch 1/3 und 1/8) mit Salienz aus Kick/Snare/Hi-Hat/Melodie und
metrischer Position → Auswahl pro Takt nach Ziel-Dichte (Schwierigkeit × Abschnitt × Energie, lokale
Dichtegrenze) → Drop-Pause + Doppelnote auf dem Drop → Muster je 2-Takt-Phrase (Stream, Treppe, Doppel,
Windmühle, Kreuz, Slider, Burst, Simple; Wiederholungen gleich/gespiegelt) → Parity-Engine (Vorhand/
Rückhand je Hand) → Positionen (rot links, blau rechts, keine Sichtblocks) → Wände (Breakdown, vor Drops,
Ducken ab Expert+), Bomben (ab Hard, sparsam) → Lichtshow → Validierung (Parity, Kreuzungen, Abstände,
Dichte, Wände, Bomben) mit Spielbarkeits-Score. Gleicher Song + Seed + Schwierigkeit = gleiches Level.

**Musik-Treue:** Jede Note liegt auf einem hörbaren Sound – Rasterpunkte ohne echten Onset werden nicht belegt, der
Taktbonus entscheidet nur zwischen ähnlich starken Sounds. Abschnitte mit viel Melodie folgen dem Gesang/Lead
(eigene Onset-Spur, auf 1/2, 1/3, 1/4 gerundet), geswungene Abschnitte bekommen Offbeats auf 2/3, und jede Note wird
auf den echten Anschlag innerhalb ±25 ms eingerastet (bei festem Tempo nur eine systematische Verschiebung).
Messen: `pnpm --filter @beatblade/core build && node packages/core/scripts/timing-report.mjs typ=song.mp3 …`
(Anteil Noten auf einem Sound, Abweichung, Vergleich mit allen Rasterpunkten; `--gen` vergleicht einen anderen Generator-Stand).

Alle Schwellen und Gewichte: `packages/core/src/tuning.ts`. Bei Änderungen am Ergebnis `version.ts`
erhöhen – der Server erzeugt veraltete Analysen/Levels dann im Hintergrund neu.

### Timing

Audio wird vollständig dekodiert (AudioBuffer) und per AudioBufferSourceNode gespielt. Einzige Zeitquelle
ist die Audio-Uhr (`getOutputTimestamp`, sonst `currentTime − outputLatency`), dazu die kalibrierte
Latenz (Metronom-Kalibrierung + manueller Regler). Audio und Levels werden im Headset per Cache API
gespeichert.

## Entwicklung

```bash
pnpm install
pnpm build && pnpm test          # Core-Tests: BPM, Beats, Downbeats, Mapping-Regeln, Schnitt-Fingerabdruck, Orbit
DATA_DIR=./data SEED_DIR=./seed-songs WEB_DIR=../web/dist PORT=3901 pnpm --filter @beatblade/server start
pnpm --filter @beatblade/web dev # Vite mit Proxy auf :3901
pnpm seed:download               # mitgelieferte Songs laden
```

## Credits

Mitgelieferte Musik: Kevin MacLeod (incompetech.com), Lizenz CC BY 4.0 – Details je Song in
`seed-songs/credits.json` und auf dem Credits-Screen. Für hochgeladene Musik ist die hochladende Person
verantwortlich.
