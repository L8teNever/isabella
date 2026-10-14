# BeatBlade

Selbst gehostetes VR-/MR-Rhythmusspiel für den Browser (Meta Quest 3/3S/Pro, andere WebXR-Headsets).
Blöcke im Takt mit zwei Lichtschwertern in Pfeilrichtung zerschneiden – rot links, blau rechts.
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

### Reverse-Proxy / Cloudflare

- Der Container lauscht auf Port 3000; alles liegt unter `BASE_PATH` (Web-App und `BASE_PATH/api`).
- Cloudflare Tunnel: Ingress-Regel für den Hostnamen mit Pfad `^/beatblade` auf `http://<host>:3000`.
- Server-Sent Events (`/api/events`) brauchen ungepuffertes Weiterleiten (Header `X-Accel-Buffering: no` ist gesetzt; bei nginx `proxy_buffering off`).
- Bei `AUTH_MODE=cloudflare` eine Access-Application für `host/beatblade` anlegen.

## Bedienung

- **Bibliothek** (`/beatblade/`): Upload per Drag & Drop oder Dateiauswahl (MP3, M4A, OGG, FLAC, WAV;
  Erkennung per Magic Bytes), Fortschritt pro Datei, danach Live-Status *In Warteschlange → Dekodieren →
  Analysieren → Level generieren → Fertig*. Tags/Cover werden ausgelesen und sind editierbar,
  Duplikate (SHA-256) werden erkannt. Suchen, sortieren, filtern, neu generieren, neu analysieren,
  ausblenden, löschen, Job-Log.
- **Debug-Ansicht** (`debug.html?song=ID`): Wellenform, Beats/Takte, Onsets je Band, Abschnitte,
  Energie, Noten/Bomben/Wände und Lichtshow als Zeitleiste, mit Abspielen, Metronom- und Noten-Klick.
- **Spielen** (`play.html`): *VR starten* (eigene Neon-Umgebung) oder *MR starten* (Passthrough, nur
  Blöcke und dezente Effekte). Menüs per Laserpointer (Abzug/Pinch = Klick), Thumbstick blättert.
  Song-Detail: Schwierigkeit, Seed, Modifikatoren (Schneller, Keine Wände, Keine Bomben),
  Highscores. Einstellungen: Latenz, Schwert-Offset/-Winkel, Spielergröße, Lautstärke, Lichteffekte,
  Linkshänder, Komfortmodus, FPS-Anzeige, Name, MR: Boden/Richtung setzen. *Upload vom Handy* zeigt einen
  QR-Code. Pause: B/Y-Taste oder Brille absetzen/Systemmenü, Weiterspielen mit 3-s-Countdown.
- **Desktop-Debugmodus**: Autoplay schneidet alle Noten (Taste `A` schaltet auf Maus-Steuerung des
  rechten Schwerts), `Esc` = Pause.

## Wertung

Kein Game Over: jeder Song läuft bis zum Ende. Die Genauigkeit startet pro Song bei 100 %; Treffer heben
sie an (max. 100 %), verpasste Blöcke, Fehlschläge (falsche Richtung/Farbe), Bomben und Zeit in Wänden
senken sie. Am Ende: Prozent + Sterne (5 ★ = 100 %, 4 ★ ab 90 %, 3 ★ ab 75 %, 2 ★ ab 50 %, 1 ★ ab 25 %).
Alle Werte als Konstanten oben in `apps/web/src/game/score.ts`. Highscores werden nach Prozent sortiert.

**Pfeile: Pflicht/egal** – bei *Pflicht* zählt eine falsche Schlagrichtung als Fehler, bei *egal* jeder saubere
Schnitt. **Verfehlt = stumm** (Standard aus) – an jedem verfehlten Block setzt die Musik kurz aus (Werte oben in
`apps/web/src/audio/player.ts`). Weil der Song als fertige Mischung vorliegt, verstummt kurz alles, nicht nur ein
einzelnes Instrument.

## Architektur

```
packages/core   Analyse (STFT, Multi-Band-Onsets, Tempo, Beat-Tracking, Takt, Energie, Struktur) +
                Mapping (Generator, Muster, Parity, Waende/Bomben, Lichtshow, Validierung), Typen, Tuning
apps/server     Fastify-API, Upload, persistente Job-Queue (SQLite), Worker-Threads, ffmpeg, SSE, Seed-Import
apps/web        Vite + Three.js: Bibliothek/Upload, Debug-Ansicht, WebXR-Spiel
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

### Mapping (packages/core/src/mapping)

Raster-Slots (1/1, 1/2, 1/4; Expert+ auch 1/3 und 1/8) mit Salienz aus Kick/Snare/Hi-Hat/Melodie und
metrischer Position → Auswahl pro Takt nach Ziel-Dichte (Schwierigkeit × Abschnitt × Energie, lokale
Dichtegrenze) → Drop-Pause + Doppelnote auf dem Drop → Muster je 2-Takt-Phrase (Stream, Treppe, Doppel,
Windmühle, Kreuz, Slider, Burst, Simple; Wiederholungen gleich/gespiegelt) → Parity-Engine (Vorhand/
Rückhand je Hand) → Positionen (rot links, blau rechts, keine Sichtblocks) → Wände (Breakdown, vor Drops,
Ducken ab Expert+), Bomben (ab Hard, sparsam) → Lichtshow → Validierung (Parity, Kreuzungen, Abstände,
Dichte, Wände, Bomben) mit Spielbarkeits-Score. Gleicher Song + Seed + Schwierigkeit = gleiches Level.

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
pnpm build && pnpm test          # Core-Tests: BPM, Beats, Downbeats, Mapping-Regeln
DATA_DIR=./data SEED_DIR=./seed-songs WEB_DIR=../web/dist PORT=3901 pnpm --filter @beatblade/server start
pnpm --filter @beatblade/web dev # Vite mit Proxy auf :3901
pnpm seed:download               # mitgelieferte Songs laden
```

## Credits

Mitgelieferte Musik: Kevin MacLeod (incompetech.com), Lizenz CC BY 4.0 – Details je Song in
`seed-songs/credits.json` und auf dem Credits-Screen. Für hochgeladene Musik ist die hochladende Person
verantwortlich.
