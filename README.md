# Isabella – Bowling in Mixed Reality

Läuft unter **https://isabella.kulbarts.com** (auch alra.kulbarts.com). Image: `ghcr.io/l8tenever/isabella`.

Eigene Website: Kegel in den echten Raum stellen und mit der Hand oder dem
Controller bowlen – auf der Meta Quest im Passthrough, am Android-Handy in AR, sonst in VR oder am
Bildschirm zum Ausprobieren.

## Starten

```sh
docker run -d --name isabella -p 8081:80 ghcr.io/l8tenever/isabella:latest
```

oder mit `compose.example.yaml`. WebXR (Brille/Handy) braucht **HTTPS**, also z. B. hinter einen
Cloudflare-Tunnel oder Reverse-Proxy hängen. Das Image baut GitHub Actions bei jedem Push auf `main`,
(`.github/workflows/docker.yml`).

## Spielen

- **Einrichtung Schritt für Schritt (Brille):** Nach dem Start erscheint eine Tafel vor dir und
  führt nacheinander durch alles: Spieler (Anzahl) → Kegel aufstellen (auf den Boden zielen und
  drücken, das Dreieck mit 10 Kegeln zeigt von dir weg) → „Passt das so?“ → Los geht's. Knöpfe per
  Strahl oder einfach mit dem Zeigefinger antippen.
- **Uhr-Menü am linken Handgelenk:** Während des Spiels gibt es keine feste Leiste mehr. Schau auf
  dein linkes Handgelenk (oder dreh den linken Controller zu dir) – dort erscheint ein kleines
  Menü: Neu aufstellen, Kegel versetzen, Neues Spiel, Spieler, Kugel holen, Beenden.
- **Werfen (Brille):** Die Kugel schwebt rechts vor dir auf Hüfthöhe und leuchtet, sobald du sie
  greifen kannst. Greifen mit der Hand (Daumen + Zeigefinger zusammen, bis 20 cm neben der Kugel)
  oder dem Controller (Grifftaste oder Abzug, auch per Strahl aus der Ferne). Arm schwingen und loslassen:
  Richtung und Tempo kommen aus den letzten ~90 ms der Handbewegung. Nur loslassen ohne Schwung
  legt die Kugel zurück.
- **Handy:** auf den Boden tippen zum Aufstellen, dann nach oben wischen – je schneller, desto
  schneller die Kugel, seitlich wischen lenkt.
- **Bildschirm:** mit der Maus nach oben wischen.
- **Mehrere Spieler mit einem Gerät:** auf der Startseite Namen eintragen (bis 8). Jeder spielt
  einen ganzen Frame, dann ist der Nächste dran – Brille oder Handy einfach weitergeben. Die Tafel
  zeigt alle Spieler, wer dran ist, und am Ende den Sieger. Namen werden gemerkt.
- Gespielt wird in jedem Raum mit etwas freiem Boden – die Kegel stehen dort, wo man sie hinstellt.
- Die Kugel schwebt nach jedem Wurf wieder rechts vor dir.

## Minigolf (`/golf.html`)

- **Dein Raum ist die Bahn:** Boden, Wände und Möbel aus der Quest-Raumeinrichtung (plane-/mesh-
  detection) werden zu festen Physik-Körpern – die Kugel rollt auf dem Tisch, fällt an der Kante
  runter und prallt an Wänden und Möbeln ab. Außerhalb des gescannten Bodens ist sie „aus“
  (+1 Schlag, zurück an die letzte Stelle).
- **Einrichtung Schritt für Schritt:** Spieler → Bahn wählen (gespeicherte Bahn, neue Bahn bauen
  oder Zufallsbahn) → Start setzen → Loch setzen → Hindernisse (Rampe, Looping, Boost, Wand,
  Bumper, Sand; drehen, löschen, zufällig verteilen) → weiteres Loch oder „Fertig, spielen“.
  Ziel ist jeweils Boden oder Möbel. Looping braucht Schwung – Boost davor.
  Bahnen werden gespeichert, relativ zu einem Raum-Anker (stehen beim nächsten Mal wieder da).
- **Uhr-Menü am linken Handgelenk:** Kugel zurück, Loch aufgeben, Neue Runde, Bahn bearbeiten,
  Andere Bahn, Spieler, Beenden.
- **Spielen:** Controller oder Hand nach unten halten = Schläger, durch die Kugel schwingen
  (Schlagstärke aus der Schwunggeschwindigkeit). Handy/Bildschirm: wischen. Maximal 8 Schläge
  pro Loch, „Loch aufgeben“ setzt 8.
- **Mehrere Spieler:** gleiche Spielerliste wie beim Bowling; jeder spielt ein Loch, dann der
  Nächste, dann das nächste Loch. Tafel über dem Loch zeigt alle Schläge.

## Technik

| Datei | Inhalt |
|---|---|
| `public/lara.js` | Start, WebXR, Eingaben (Hände, Controller, Wischen), Werkzeugleiste, Ablauf |
| `public/bowling.js` | Physik (cannon-es): Kugel 6 kg/21,6 cm, Kegel 1,55 kg/38 cm aus 5 Formen, Erkennen umgefallener Kegel |
| `public/score.js` | Bowling-Wertung (Strike, Spare, 10. Frame) und Anzeigetafel für alle Spieler |
| `public/golf.js` | Minigolf: Bauen, Spielen, Schläger, Karten, Spieler |
| `public/golf-course.js` | Minigolf-Physik: Elemente, Kugel, Loch, Sand/Boost, Aus |
| `public/room-scan.js` | Gescannter Raum: Boden, Wände, Möbel als Kisten |
| `public/sound.js` | Klacken, Rollen, Jubel – alles per WebAudio erzeugt |
| `public/vendor/` | three.js, cannon-es (lokal, läuft offline) |

- Physik mit 240 Schritten pro Sekunde (schnelle Kugel tunnelt nicht), Kegel werden vor dem Aufprall
  aufgeweckt, Kugel bekommt Vorwärtsdrall.
- Ein Kegel gilt als gefallen, wenn er mehr als ~37° kippt oder 12 cm vom Platz rutscht. Nach dem
  ersten Wurf eines Frames verschwinden gefallene Kegel, danach wird neu aufgestellt.
- Erkannte Wände der Quest-Raumeinrichtung bremsen die Kugel, der Boden kommt aus `local-floor`.
- Schatten von Kegeln und Kugel fallen auf den echten Boden (Schattenfänger).
- Offline: Service Worker cacht alles je Version.
