# SchichtScan 1.1 – Polypoint-Screenshot zu Apple Kalender

SchichtScan ist eine statische, installierbare Web-App für das iPhone. Sie liest die **Polypoint-Mobilansicht** aus Screenshots, zeigt die erkannten Dienste zur Kontrolle an und erzeugt eine `.ics`-Datei für Apple Kalender.

## Kein gekaufter Server nötig

Die Anwendung hat kein Backend und keine Datenbank. Für die Installation als iPhone-Web-App braucht sie lediglich einmalig eine HTTPS-Adresse. Dafür genügt beispielsweise **GitHub Pages** in einem öffentlichen, kostenlosen Repository. Nach dem ersten vollständigen Laden wird das gesamte App-Paket einschließlich OCR-Modell auf dem iPhone zwischengespeichert und kann offline gestartet werden.

Die ausgewählten Screenshots werden nicht hochgeladen. OCR, Parser und ICS-Erstellung laufen im Browser. Eine Content-Security-Policy blockiert Verbindungen zu fremden Domains.

## Neu in Version 1.1

Unterstützte Standarddienste:

| Standardzeit | Code |
|---|---|
| 06:30–15:00 | F6 |
| 08:00–16:30 | F4 |
| 11:30–20:00 | Z1 |
| 14:30–23:00 | S2 |
| 22:30–07:00 | N2 |
| 16:36–06:54 | R+ |

Weitere Verbesserungen:

- Die obere Standardzeit bestimmt den Schichtcode, auch wenn das farbige Symbol von OCR falsch gelesen wird.
- Die darunterstehenden Arbeitsblöcke bestimmen standardmäßig den tatsächlichen Beginn und das tatsächliche Ende. Beispiel: `F6 06:30–15:00` mit Blöcken bis `17:00` wird als Termin bis 17:00 exportiert.
- Pausenblöcke bleiben in der Terminbeschreibung erhalten.
- Datierte N2-Blöcke über Mitternacht und Monatsgrenzen werden verarbeitet.
- `Frei – Wunsch` und leere Tage werden standardmäßig nicht als Kalendertermine exportiert.
- Überlappende Screenshots werden zusammengeführt; die vollständigere Erkennung gewinnt.
- F4, F6, Z1, S2, N2 und R+ sind vorkonfiguriert. Weitere Zeiten lassen sich in der App ergänzen.

## Empfohlene Installation über GitHub Pages

1. Auf GitHub ein neues **öffentliches** Repository anlegen, beispielsweise `schichtscan`.
2. Den Inhalt dieses Ordners in die oberste Ebene des Repositorys hochladen. `index.html` muss direkt im Repository liegen.
3. Unter **Settings → Pages** als Quelle **GitHub Actions** auswählen.
4. Der mitgelieferte Workflow `.github/workflows/pages.yml` veröffentlicht die App nach dem Push auf `main` automatisch.
5. Die angezeigte `https://…github.io/…`-Adresse in Safari auf dem iPhone öffnen.
6. Warten, bis in der App **„Offline-Paket ist bereit“** steht.
7. In Safari **Teilen → Zu Home-Bildschirm hinzufügen** wählen und **„Als Web-App öffnen“** aktivieren, falls angeboten.
8. Optional den Flugmodus einschalten und einen Test durchführen. OCR und ICS-Erstellung müssen weiterhin funktionieren.

Das öffentliche Repository enthält nur den App-Code und das OCR-Modell. Es enthält keine Dienstplan-Screenshots und keine erzeugten Kalenderdaten.

## Alternative mit vorhandenem Webserver oder NAS

Den gesamten Ordner unverändert über HTTPS bereitstellen. Es gibt keinen Build-Schritt und kein Backend.

### Docker

```bash
docker compose up -d --build
```

Danach läuft der Container auf Port `8080`. Für die iPhone-Installation sollte ein vorhandener HTTPS-Reverse-Proxy davorliegen.

## Lokaler Test auf Mac oder PC

```bash
python3 -m http.server 8080
```

Dann `http://localhost:8080` öffnen. Dieser Modus eignet sich zum Testen am Rechner. Für die dauerhafte iPhone-Installation und den Offline-Start ist die HTTPS-Variante vorgesehen.

## Bedienung

1. Einen oder mehrere Screenshots auswählen.
2. **Dienstplan erkennen** antippen.
3. Datum, tatsächliche Zeit, Titel und Pausenblöcke prüfen.
4. Bei Bedarf einzelne Termine bearbeiten oder vom Export ausschließen.
5. **ICS teilen / öffnen** wählen.
6. Die Datei in Apple Kalender öffnen und den Import bestätigen.

Unter **Kalender- und Erkennungseinstellungen** kann die Option für Detailzeiten deaktiviert werden. Dann verwendet der Export ausschließlich die obere Standardzeit.

## Tests

```bash
npm test
```

Die Test-Suite deckt variable F6-/Z1-Endzeiten, F4, S2, N2, R+, Nachtwechsel, Monatswechsel, Frei-Wunsch-Tage, überlappende Screenshots und ICS-Ausgabe ab.

## Bekannte Grenzen

- OCR kann Fehler machen. Deshalb bleibt die Vorschau vor dem Export editierbar.
- Unbekannte Schichtzeiten benötigen eine zusätzliche Zuordnung unter **Schichtcodes nach Uhrzeit**.
- Diese Version ist auf die gezeigte Polypoint-Mobilansicht optimiert. Die anders aussehende Klinik-/Desktopansicht folgt separat.
