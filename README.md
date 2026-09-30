# Planer-Server

Gemeinsamer Echtzeit-Server für **Netzwerkplaner** und **Stromplaner**. Jede App hat eigene Sitzungen; mehrere Personen bearbeiten denselben Plan gleichzeitig.

Grundlage: Variante B aus der Analyse „Multi-Session-Server“. Der Server hält den Stand jeder Sitzung und eine fortlaufende Versionsnummer (`seq`). Clients schicken kleine Operationen (Feld setzen, Element einfügen/entfernen …), der Server wendet sie in seiner Reihenfolge an und verteilt sie. Bei gleichzeitigen Änderungen am selben Feld gewinnt die letzte, die überschriebene Person bekommt einen Hinweis. Für den Netzwerkplaner führt der Server zusätzlich **Absichten** aus (Gerät anlegen, verbinden, IP vergeben, löschen) und lehnt Änderungen ab, die harte Regeln verletzen (Port doppelt belegt, Verbindung auf gelöschtes Gerät, fehlendes VLAN).

## Starten mit Docker

```bash
git submodule update --init      # Netzwerkplaner-Code für Absichten und Prüfungen
docker compose up -d --build
```

Der Server lauscht auf Port **3001** (wie der bisherige Stromplaner-Sync-Server), Daten liegen in `./data`.

| Variable | Standard | Zweck |
|---|---|---|
| `PORT` | 3001 | Port für HTTP und WebSocket |
| `DATA_DIR` | `/data` | Sitzungen, Snapshots, Sicherungen, Stromplaner-Pläne |
| `AUTH_TOKEN` | leer | Wenn gesetzt, gilt er für alle Anfragen (`Authorization: Bearer …`) und im WebSocket-`hello` |

Ohne TLS gedacht für das eigene LAN. Aus dem Internet erreichbar nur hinter einem Reverse-Proxy mit HTTPS (dann `wss://`).

## Schnittstellen

| Weg | Zweck |
|---|---|
| `GET /health` | Lebenszeichen, Protokollversion, bekannte Apps |
| `GET /api/sessions?app=netzwerkplaner` | Sitzungen einer App |
| `POST /api/sessions` | `{ app, name, code?, appVersion, doc }` legt eine Sitzung an |
| `GET /api/sessions/:id/doc` | aktueller Stand (Header `X-Session-Code`) |
| `DELETE /api/sessions/:id` | Sitzung löschen (Header `X-Session-Code`) |
| `WS /ws` | Echtzeit-Protokoll, siehe `src/hub.js` |
| `GET/PUT/DELETE /api/plans[/:id]` | bisheriger Stromplaner-Sync, unverändert kompatibel |

## Einbinden in eine App

`client/sync-client.js` (mit `client/ops.js`) ist für alle Apps gleich:

```js
import { createSyncClient } from "./sync-client.js";
import { diff } from "./ops.js";

const sync = createSyncClient({
  url: "ws://192.168.1.10:3001/ws", app: "stromplaner", appVersion: "1.1.0",
  session: id, code: "ABC123", name: "Anna",
  onDoc: (doc) => setPlan(doc),            // lokaler Stand inkl. eigener, noch unbestätigter Änderungen
  onHinweis: (h) => zeigeHinweis(h),       // überschrieben / verworfen / abgelehnt
  onUsers: (users) => setOnline(users),
});
// bei jeder Änderung:
sync.submit(diff(vorher, nachher));
```

Gleiche App-Version ist Pflicht. Tritt eine neuere Version einer leeren Sitzung bei, übernimmt die Sitzung diese Version und der Client bekommt `onMigrieren(doc)`, um den Plan anzupassen.

## Entwicklung

```bash
npm install
NETZWERKPLANER_DIR=../netzwerkplaner npm test   # Server mit mehreren Test-Clients
npm run dev
```

`src/ops.js` und `client/ops.js` sind Kopien von `src/shared/ops.js` aus dem Netzwerkplaner.
