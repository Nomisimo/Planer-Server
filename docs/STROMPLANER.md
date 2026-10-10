# Stromplaner an den Planer-Server anbinden

Diese Anleitung beschreibt alles, was der Stromplaner braucht, um seinen bisherigen Datei-Sync (`server/` im Stromplaner-Repo, `GET/PUT /api/plans`) durch den Live-Mehrbenutzerbetrieb des Planer-Servers zu ersetzen. Der Netzwerkplaner nutzt dasselbe Protokoll seit 0.7.0-beta.1. Wo es hilft, verweist die Anleitung auf seine Umsetzung (`src/renderer/sync.js`, `src/renderer/SitzungDialog.jsx` im Netzwerkplaner-Repo).

Begleit-Issue im Stromplaner: [MrPancaketwtch/Stromplaner#23](https://github.com/MrPancaketwtch/Stromplaner/issues/23).

## Inhalt

1. [Das Prinzip in fünf Sätzen](#1-das-prinzip-in-fünf-sätzen)
2. [Ablauf in der App](#2-ablauf-in-der-app)
3. [Verbindung, Adresse, Token](#3-verbindung-adresse-token)
4. [HTTP-Schnittstelle](#4-http-schnittstelle)
5. [WebSocket-Protokoll](#5-websocket-protokoll)
6. [Datenmodell und Operationen](#6-datenmodell-und-operationen)
7. [Sync-Client](#7-sync-client)
8. [Versionen](#8-versionen)
9. [Feldsperre, Verlauf, Sitzungsende](#9-feldsperre-verlauf-sitzungsende)
10. [Umbau des Sync-Kerns im Stromplaner, Schritt für Schritt](#10-umbau-des-sync-kerns-im-stromplaner-schritt-für-schritt)
11. [Eigene Server-Logik für den Stromplaner (optional)](#11-eigene-server-logik-für-den-stromplaner-optional)
12. [Legacy `/api/plans` und Übergang](#12-legacy-apiplans-und-übergang)
13. [Testen](#13-testen)
14. [Stolpersteine aus dem Netzwerkplaner](#14-stolpersteine-aus-dem-netzwerkplaner)

---

## 1. Das Prinzip in fünf Sätzen

- Der Server hält für jede **Sitzung** den aktuellen Plan (`doc`) und eine fortlaufende Nummer `seq`. Jede App (`netzwerkplaner`, `stromplaner`) hat ihre eigenen Sitzungen.
- Clients schicken keine ganzen Dateien, sondern **Operationen** („setze `instances/#a1/name` auf X“). Objekte in Arrays werden über ihre `id` adressiert, nicht über den Index.
- Der Server wendet Transaktionen **in seiner Reihenfolge** an. Ändern zwei Personen gleichzeitig dasselbe Feld, gewinnt die spätere (Last-Writer-Wins), und die spätere bekommt einen Hinweis, wessen Wert sie ersetzt hat.
- Der Client arbeitet **optimistisch**: Eigene Änderungen wirken sofort, kommen fremde dazwischen, setzt der Client die eigenen auf den neuen Stand auf (Rebase). Das erledigt `client/sync-client.js`.
- Ohne Sitzung ändert sich am Stromplaner nichts. Die Sitzung ist ein zusätzlicher Modus.

## 2. Ablauf in der App

```
Sitzungsfenster öffnen
 ├─ Server + Token eintragen ──► GET /api/sessions?app=stromplaner   (Liste)
 ├─ „Sitzung starten“ ─────────► POST /api/sessions { app, name, code?, appVersion, doc }
 │                               └─► createSyncClient({ session: id, … })
 └─ „Beitreten“ ───────────────► (Code prüfen: GET /api/sessions/:id/verlauf?limit=1 mit X-Session-Code)
                                 └─► createSyncClient({ session: id, code, … })

In der Sitzung
 ├─ jede Änderung:       ops = diff(vorher, nachher)  →  sync.submit(ops)
 ├─ onDoc(doc):          Plan im Zustand ersetzen (ohne neue Ops zu erzeugen)
 ├─ onUsers / onSperren: Online-Liste, Feldsperren anzeigen
 ├─ onHinweis:           überschrieben / verworfen / abgelehnt / gesperrt
 ├─ Undo/Redo:           nur eigene Transaktionen, als invert(ops) neu einreichen
 └─ Verlassen:           sync.close()  oder  await sync.beenden()  (für alle)
```

## 3. Verbindung, Adresse, Token

| | |
|---|---|
| Standard-Port | `3001` (im Docker-Container; auf dem Host frei wählbar, z. B. `"3002:3001"`) |
| HTTP | `http://<host>:<port>` |
| WebSocket | `ws://<host>:<port>/ws` |
| Hinter Reverse-Proxy mit HTTPS | `https://planer.example.de` und `wss://planer.example.de/ws`; am Proxy WebSocket-Upgrade für `/ws` einschalten |
| Token | Umgebungsvariable `AUTH_TOKEN` am Server. Leer = offen. Gesetzt: HTTP mit `Authorization: Bearer <token>`, WebSocket im `hello` als `token`. `/health` ist immer offen |

Der Token ist derselbe Mechanismus wie im bisherigen Stromplaner-Sync-Server. Die vorhandenen Einstellungen `sp_sync_server` / `sp_sync_token` können weiterverwendet werden.

**Adresse aus der Eingabe bilden** (so macht es der Netzwerkplaner, bewährt):

- `192.168.1.10` → `http://192.168.1.10:3001`
- `192.168.1.10:3002` → `http://192.168.1.10:3002`
- `https://planer.example.de` → so wie eingegeben, WebSocket dann `wss://…/ws`
- WebSocket-URL = HTTP-Basis mit `http` → `ws` ersetzt, plus `/ws`

## 4. HTTP-Schnittstelle

Alle Antworten sind JSON. Fehler kommen als `{ "error": "…" }` mit passendem Status.

| Methode und Pfad | Zweck | Antwort |
|---|---|---|
| `GET /health` | Lebenszeichen | `{ ok: true, proto: 1, apps: ["netzwerkplaner", "stromplaner"] }` |
| `GET /api/apps` | bekannte Apps | `[{ id, name }]` |
| `GET /api/sessions?app=stromplaner` | Sitzungen einer App | `[Sitzungsinfo]` (siehe unten) |
| `POST /api/sessions` | Sitzung anlegen. Body `{ app: "stromplaner", name, code?, appVersion, doc }` | `201` + Sitzungsinfo |
| `GET /api/sessions/:id/doc` | aktueller Stand (z. B. „Kopie speichern“), Header `X-Session-Code` | `{ seq, doc }` |
| `GET /api/sessions/:id/verlauf?vor=<seq>&limit=<n>` | Verlauf aller Nutzer, neueste zuerst, max. 500, Header `X-Session-Code` | `[Verlaufseintrag]` |
| `DELETE /api/sessions/:id` | Sitzung von außen beenden, Header `X-Session-Code`. Nur wenn seit `LEER_BEENDBAR_STUNDEN` (Standard 72) niemand verbunden war | `200 { ok: true }`, sonst `409` mit Grund |
| `GET/PUT/DELETE /api/plans[/:id]` | Legacy-Sync, siehe [Abschnitt 12](#12-legacy-apiplans-und-übergang) | wie bisher |

**Sitzungsinfo**

```json
{
  "id": "u3Kx…", "app": "stromplaner", "name": "Halle A", "appVersion": "1.2.0",
  "seq": 42, "users": 2, "codeNoetig": true,
  "erstellt": "2026-10-06T08:00:00.000Z", "geaendert": "2026-10-06T09:12:00.000Z",
  "leerSeit": null, "beendbar": false
}
```

`leerSeit` ist gesetzt, solange niemand verbunden ist. `beendbar` sagt, ob `DELETE` gerade erlaubt ist (dann in der Liste einen Knopf „Beenden“ zeigen).

**Code-Fehler**: Bei falschem Sitzungscode `403 { error: "code-falsch" }`. Nach 10 Fehlversuchen je Adresse `403 { error: "gesperrt" }` für eine Minute.

**Verlaufseintrag**

```json
{ "seq": 17, "zeit": 1791200000000, "user": "k2j…", "name": "Anna", "absicht": null, "anzahl": 3,
  "texte": ["Verteiler „UV Bühne“ › Name geändert: \"UV1\" → \"UV Bühne\"", "…"] }
```

Die lesbaren Texte baut der Server aus den Operationen. Für schöne Bezeichnungen hat das Stromplaner-Modul Labels (`instances` → „Verteiler“, `loads` → „Verbraucher“ usw., siehe `src/apps/index.js`). Fehlende Labels können dort ergänzt werden.

## 5. WebSocket-Protokoll

JSON-Nachrichten, ein Objekt pro Frame, Feld `type` unterscheidet sie. Die erste Nachricht des Clients muss `hello` sein (sonst trennt der Server nach 10 s).

### Client → Server

| `type` | Felder | Bedeutung |
|---|---|---|
| `hello` | `proto: 1, app, appVersion, session, code?, name, clientId, token?, lastSeq?` | Anmelden. `clientId` bleibt über Reconnects gleich. `lastSeq` = zuletzt bestätigter Stand, damit der Server nur Fehlendes schickt |
| `tx` | `txId, baseSeq, ops` | Transaktion: alle Ops oder keine |
| `tx` | `txId, baseSeq, intent: { name, args }` | Absicht, die der Server ausrechnet (nur wenn das App-Modul sie kennt, siehe [Abschnitt 11](#11-eigene-server-logik-für-den-stromplaner-optional)) |
| `sperre` | `path` | „Ich tippe in diesem Feld“ (alle paar Sekunden erneuern, verfällt nach 120 s) |
| `freigabe` | `path?` | Sperre aufheben (ohne `path`: alle eigenen) |
| `presence` | `data` | flüchtige Info (z. B. gewählter Tab), geht an alle anderen |
| `verlauf` | `vor?, limit?` | Verlauf anfordern |
| `beenden` | | Sitzung für alle beenden |
| `ping` | | Antwort `pong` |

### Server → Client

| `type` | Felder | Bedeutung |
|---|---|---|
| `welcome` | `session, seq, doc` **oder** `ops, you, users, sperren, migrieren` | Angemeldet. `ops` statt `doc`, wenn `lastSeq` nachgeholt werden konnte |
| `ack` | `txId, seq, ops, skipped, conflicts, result` | Eigene Transaktion übernommen. `ops` = tatsächlich angewendete Ops |
| `reject` | `txId, reason, detail, path?` | Eigene Transaktion abgelehnt, nichts wurde geändert |
| `applied` | `seq, user, name, txId, ops` | Transaktion eines anderen |
| `users` | `users: [{ id, name, farbe, presence }]` | Online-Liste |
| `sperren` | `sperren: [{ key, path, user, name }]` | aktuelle Feldsperren |
| `sperre-abgelehnt` | `path, von` | Feld ist schon von jemand anderem gesperrt |
| `presence` | `user, data` | flüchtige Info eines anderen |
| `verlauf` | `eintraege` | Antwort auf `verlauf` |
| `error` | `reason, detail` | Fehler, danach schließt der Server die Verbindung |

**`reject.reason`**: `gesperrt` (jemand tippt in dem Feld), `invariante` (App-Regel verletzt, `detail` = Liste), `ungueltig`, `unbekannte-absicht`, `absicht-fehler`, `abgelehnt` (Absicht meldet `fehler`), `serverfehler`.

**`error.reason`**: `protokoll`, `token`, `unbekannt` (Sitzung oder App falsch), `code-falsch`, `gesperrt` (zu viele Fehlversuche), `version`, `timeout`, `ungueltig`, `sitzung-geloescht` (`detail.von` = wer beendet hat).

**Schließcodes**: `4000` Sitzung beendet, `4001` Fehler (siehe `error`), `4002` dieselbe `clientId` hat sich neu angemeldet.

**Heartbeat**: Der Server pingt alle 10 s (WebSocket-Ping), wer zweimal nicht antwortet, fliegt. Browser und `ws` antworten automatisch.

## 6. Datenmodell und Operationen

`client/ops.js` erzeugt und wendet Operationen an. Der Stromplaner muss keine Ops von Hand bauen: `diff(vorher, nachher)` liefert sie.

### Pfade

Ein Pfad ist ein Array. Text = Objektschlüssel, `{ id }` = Element in einem Array aus Objekten mit `id`:

```js
["instances", { id: "a1" }, "name"]
["loads", { id: "l7" }, "phases"]
["meta", "production"]
```

### Operationen

| Op | Form | Bedeutung |
|---|---|---|
| `set` | `{ op, path, value, old? }` | Feld setzen (`old` fehlt = Feld war neu) |
| `del` | `{ op, path, old }` | Feld entfernen |
| `ins` | `{ op, path, value, after }` | Objekt in ID-Array einfügen, nach `after` (`null` = vorn) |
| `rem` | `{ op, path, id, old, after }` | Objekt aus ID-Array entfernen |
| `order` | `{ op, path, ids, old }` | Reihenfolge eines ID-Arrays |
| `add` / `drop` | `{ op, path, value }` | Wert in Mengen-Array aufnehmen/entfernen |

`old` dient nur Undo und Konflikthinweisen. Der Server wendet `set` auch an, wenn `old` nicht mehr stimmt (Last-Writer-Wins).

### Was das für die Plan-Struktur heißt

- **ID-Arrays**: Ein Array wird nur dann elementweise abgeglichen, wenn **jedes** Element ein Objekt mit eindeutiger `id` ist. Sonst ersetzt `diff` das ganze Array mit einem `set`. Dann überschreiben sich gleichzeitige Änderungen an verschiedenen Elementen gegenseitig. Alles, was zwei Personen gleichzeitig bearbeiten könnten, braucht also eine stabile `id` (Verteiler, Verbraucher, Platzierungen, Kabel- und Spannungsrechnungen, Anmerkungen, Prüfergebnisse falls als Array).
- **Mengen-Arrays**: Arrays aus Texten oder Zahlen unter den Schlüsseln in `SET_FIELDS` (`ops.js`, derzeit `vlans`, `ziele`, `protokolle`, `ids`) werden als Menge behandelt, gleichzeitiges Hinzufügen geht nicht verloren. Braucht der Stromplaner weitere Mengenfelder, den Namen dort ergänzen (Server und beide Apps nutzen dieselbe Datei).
- **Objekte als Map** (`inspResults: { [schluessel]: … }`) funktionieren direkt: Jeder Schlüssel ist ein eigener Pfad.
- **`undefined`** kommt nicht in Ops vor. Felder ohne Wert weglassen.
- **IDs vergibt der Client** (z. B. `crypto.randomUUID()` oder das bestehende `uid()`), nicht der Server.

### Was der Server mit einer Transaktion macht

1. Ops, die nichts ändern (gleicher Wert), werden still entfernt. So erzeugen Automatiken, die auf mehreren Rechnern dasselbe schreiben, keine Konflikte.
2. Ops anwenden. Ziel nicht mehr vorhanden (z. B. Verbraucher inzwischen gelöscht): Op landet in `skipped`, der Rest gilt. Der Client meldet das als Hinweis `verworfen`.
3. Fremde Feldsperre auf einem Pfad der Transaktion: `reject` mit `gesperrt`.
4. App-Regeln (`pruefe` im App-Modul) gegen den neuen Stand. Für den Stromplaner derzeit keine.
5. Konflikte bestimmen: Wurde ein Feld (oder ein Vorfahr) seit `baseSeq` von jemand anderem geändert, steht es in `conflicts` (`{ path, von, seq }`). Die Änderung gilt trotzdem.
6. Erst ins Log schreiben, dann übernehmen, `ack` an den Absender, `applied` an alle anderen.

## 7. Sync-Client

`client/sync-client.js` und `client/ops.js` sind reines ESM ohne Abhängigkeiten und laufen in Electron, im Browser und in Node. Für den Stromplaner beide Dateien kopieren und oben vermerken, dass sie im Planer-Server gepflegt werden (der Netzwerkplaner macht es genauso).

```js
import { createSyncClient, vergleicheVersion } from "./sync-client.js";
import { diff, invert } from "./ops.js";

const sync = createSyncClient({
  url: "ws://192.168.1.10:3001/ws",
  app: "stromplaner",
  appVersion: APP_VERSION,          // muss zur Sitzung passen, siehe Abschnitt 8
  session: info.id,
  code,                              // Sitzungscode oder ""
  name: "Anna",
  token,                             // AUTH_TOKEN oder ""
  // WebSocket,                      // nur in Node nötig (Paket ws)
  onDoc: (doc, info) => {},          // lokaler Stand inkl. eigener unbestätigter Änderungen
  onUsers: (users, you) => {},       // you nur beim ersten Mal
  onSperren: (sperren) => {},
  onPresence: (userId, data) => {},
  onHinweis: (h) => {},              // siehe unten
  onStatus: (status, detail) => {},  // siehe unten
  onMigrieren: (doc) => ops,         // siehe Abschnitt 8
});
```

| Methode / Eigenschaft | Zweck |
|---|---|
| `sync.submit(ops)` | Ops einreichen (wirken sofort lokal) |
| `await sync.intent(name, args)` | Absicht ausführen lassen (nur mit App-Modul) |
| `sync.sperre(path)` / `sync.freigabe(path?)` | Feldsperre |
| `sync.presence(data)` | flüchtige Info |
| `await sync.verlauf({ vor, limit })` | Verlauf |
| `sync.kopie()` | `{ doc, seq, veraltet, ausstehend }` zum Speichern |
| `sync.close()` | selbst verlassen (ohne Meldung) |
| `await sync.beenden()` | Sitzung für alle beenden. Wirft nach 5 s, wenn der Server das noch nicht kann |
| `sync.doc`, `sync.seq`, `sync.ausstehend`, `sync.online`, `sync.sperren`, `sync.clientId` | Zustand |

**`onStatus(status, detail)`**

| `status` | Bedeutung |
|---|---|
| `verbinden` / `neu-verbinden` | Verbindungsaufbau, nach Abbruch automatisch mit Backoff bis 15 s |
| `online` | angemeldet, `detail.pending` = ausstehende eigene Transaktionen |
| `offline` | Verbindung weg, Änderungen sammeln sich lokal und werden beim Reconnect eingespielt |
| `fehler` | Server meldete `error`, `detail = { reason, detail }` |
| `beendet` | endgültig vorbei. `detail.warVerbunden = false`: Beitritt gescheitert, Plan nicht ersetzen. `true`: laufende Sitzung beendet, Stand als veraltete Kopie behalten. `detail.reason/detail` wie bei `fehler` |

**`onHinweis(h)`**: `h.art` ist `ueberschrieben` (`h.konflikte[0].von` hat dasselbe Feld kurz vorher geändert), `verworfen` (Ziel gelöscht), `abgelehnt` (`h.reason`, `h.detail`) oder `gesperrt` (`h.von` tippt gerade dort).

## 8. Versionen

- Alle in einer Sitzung brauchen **dieselbe App-Version** (`appVersion`, z. B. aus `package.json`).
- Ist niemand verbunden, darf eine **neuere** App beitreten. Die Sitzung übernimmt dann deren Version, und der Client ruft `onMigrieren(doc)` auf. Dort den Plan mit der normalen Lade-Migration auf den neuen Stand bringen und `diff(doc, migriert)` zurückgeben. Der Client reicht das als Transaktion ein.
- Eine **ältere** App darf nie beitreten, auch nicht in eine leere Sitzung (sie kennt die neueren Daten nicht).
- In der Sitzungsliste lässt sich das vorab prüfen und „Beitreten“ ausgrauen. Der Netzwerkplaner macht das mit `vergleicheVersion` aus dem Sync-Client:

```js
const beitrittMoeglich = (s, version) => {
  if (!s.appVersion || s.appVersion === version) return { ok: true };
  if (vergleicheVersion(version, s.appVersion) < 0) return { ok: false, grund: "Sitzung ist neuer, bitte App aktualisieren" };
  if (s.users) return { ok: false, grund: "Sitzung läuft mit anderer Version und hat Teilnehmer" };
  return { ok: true, umstellen: true };   // vorher nachfragen
};
```

`vergleicheVersion` versteht SemVer mit Vorabversionen (`1.2.0-beta.3 < 1.2.0-beta.10 < 1.2.0`).

## 9. Feldsperre, Verlauf, Sitzungsende

- **Feldsperre**: Beim Tippen in ein Eingabefeld `sync.sperre(pfad)` (bei jeder Änderung erneuern), beim Verlassen des Felds `sync.freigabe()`. Pro Person gilt eine Sperre. Fremde Sperren aus `onSperren` als Hinweis zeigen und das Feld schreibgeschützt machen. Der Netzwerkplaner sperrt automatisch, wenn eine Änderung genau einen `set`-Pfad betrifft und der Fokus in einem `INPUT`/`TEXTAREA` steht (`senden()` in `src/renderer/sync.js`).
- **Verlauf**: `await sync.verlauf({ limit: 200 })` im Sitzungsfenster, neueste zuerst, nur während einer aktiven Sitzung abrufbar.
- **Sitzungsende**: Mit „Verlassen“ fragen: nur selbst gehen (`sync.close()`) oder für alle beenden (`await sync.beenden()`). Die anderen bekommen `beendet` mit `warVerbunden: true` und `detail.von`. Sie behalten ihren Stand als veraltete Kopie und sollen speichern.
- **Leere Sitzungen**: Nach 72 h ohne Teilnehmer (`beendbar: true` in der Liste) per `DELETE /api/sessions/:id` beenden, ohne beizutreten.

## 10. Umbau des Sync-Kerns im Stromplaner, Schritt für Schritt

### 10.1 Plan als ein Objekt mit `mutate`

Heute liegen die Daten in einzelnen `useState` (`meta`, `mainConns`, `boxTypes`, `loads`, `instances`, `placements`, `inspMeta`, `inspResults`, `cableCalcs`, `voltCalcs`, `schaltbildLayout`). Für die Sitzung braucht es **eine** Stelle, die bei jeder Änderung den alten und den neuen Gesamtstand kennt.

```js
// usePlan(): ein Objekt im Format des Autosaves (_format: "stromplaner", _version: 4, …)
const [plan, setPlan] = useState(leererPlan);
const planRef = useRef(plan);

const mutate = useCallback((fn) => {
  const vorher = planRef.current;
  const nachher = structuredClone(vorher);
  fn(nachher);                                   // Änderung wie bisher, nur auf dem Entwurf
  const ops = diff(vorher, nachher);
  if (!ops.length) return;
  planRef.current = nachher;
  setPlan(nachher);
  verlaufPush(ops);                              // eigenes Undo, siehe 10.4
  sitzung?.senden(ops);                          // nur in einer Sitzung
}, []);
```

Die bestehenden Setter lassen sich schrittweise darauf umstellen, z. B. `setLoads(x)` → `mutate((p) => { p.loads = x; })`. Wichtig ist nur, dass **jede** Änderung am Plan durch `mutate` läuft.

### 10.2 Fremde Änderungen übernehmen, ohne Echo

`onDoc(doc)` liefert den neuen lokalen Stand. Ihn **direkt** setzen (`planRef.current = doc; setPlan(doc)`), nicht über `mutate`, sonst entstehen neue Ops. Beim Übernehmen keine Migration und kein Sortieren ausführen (siehe 10.3).

### 10.3 Was nicht geteilt wird

- **Ansichtsdaten** pro Person (Zoom, eingeklappte Bereiche, gewählter Tab, Filter) gehören nicht in Ops. Der Netzwerkplaner filtert sie beim Senden heraus und behält beim Empfang die eigenen Werte (`LOKAL` und `mitLokalerAnsicht` in `src/renderer/sync.js`). Besser noch: solche Daten gar nicht im Plan-Objekt halten.
- **Sortierung** (`alphaSort` beim Laden/Speichern) erzeugt Umsortier-Ops bei jedem Speichern. Sortierung nur in der Anzeige vornehmen, nicht im gespeicherten Plan.
- **Abgeleitete Werte** (Summen, berechnete Ströme), die jeder Client selbst ausrechnen kann, möglichst nicht speichern. Wenn doch: Gleiche Werte stören nicht (der Server filtert gleiche Schreibvorgänge), unterschiedliche erzeugen Konflikthinweise.

### 10.4 Undo/Redo nur für eigene Änderungen

Jeder Undo-Schritt ist eine Liste eigener Ops. Rückgängig = `invert(ops)` gegen den **aktuellen** Stand anwenden und einreichen. Dabei `set`/`del` überspringen, deren aktueller Wert nicht mehr `old` entspricht (jemand anderes hat das Feld inzwischen geändert), und die Zahl der übersprungenen melden. Tipp-Schritte zusammenfassen (gleicher Pfad innerhalb ~1,5 s oder solange dasselbe Eingabefeld den Fokus hat), sonst gibt es einen Undo-Schritt pro Taste. Vorlage: `schritt()` und `mutate()` in `src/renderer/App.jsx` des Netzwerkplaners.

### 10.5 Stabile IDs nachrüsten

Siehe [Abschnitt 6](#was-das-für-die-plan-struktur-heißt). Beim Laden alter Pläne fehlende `id` vergeben (Migration mit Versionssprung, `_version: 5`). Ohne IDs funktioniert der Sync auch, aber Arrays werden dann als Ganzes überschrieben.

### 10.6 Sitzungsfenster

- Server, Token, eigener Name (lokal merken).
- Liste `GET /api/sessions?app=stromplaner` mit Online-Zahl, Version, „seit … niemand online“, Schloss bei `codeNoetig`.
- „Sitzung starten“ aus dem aktuellen Plan, optional mit Code.
- „Beitreten“: Code im Fenster abfragen (**nicht** mit `prompt()`, das wirft in Electron), vorab per `GET /api/sessions/:id/verlauf?limit=1` mit `X-Session-Code` prüfen, dann bestätigen lassen, dass der aktuelle Plan ersetzt wird.
- In der Sitzung: Status, Online-Liste mit Farben, Sperren, Verlauf, „Kopie speichern“, „Verlassen“ mit der Wahl aus [Abschnitt 9](#9-feldsperre-verlauf-sitzungsende).
- Vor „Öffnen“, „Neu“ usw. fragen, ob die Sitzung verlassen werden soll.

### 10.7 Hinweise und Fehler

`onHinweis` und `onStatus` als kurze Meldungen zeigen. Texte, die der Netzwerkplaner nutzt, stehen in `GRUND` und `onHinweis` in `src/renderer/sync.js`.

### 10.8 Danach aufräumen

`server/` im Stromplaner-Repo entfernen und Bescheid geben, dann fliegen die Legacy-Endpunkte im Planer-Server raus.

## 11. Eigene Server-Logik für den Stromplaner (optional)

Der Stromplaner läuft heute mit dem **generischen** Modul: nur Ops, Last-Writer-Wins, keine Regeln. Das reicht für den Anfang. Wenn der Server mehr prüfen oder rechnen soll, bekommt der Stromplaner ein eigenes Modul wie der Netzwerkplaner (`src/apps/netzwerkplaner.js`):

```js
// src/apps/stromplaner.js
export const stromplaner = {
  id: "stromplaner", name: "Stromplaner",
  labels: { instances: "Verteiler", loads: "Verbraucher", /* … */ },
  intents: {
    // Absicht: rechnet auf dem Serverstand, z. B. freien Abgang wählen und Verbraucher anschließen.
    // Gibt { fehler } zurück, um abzulehnen; sonst Ergebnis für den Client (z. B. { id }).
    verbraucherAnschliessen: (plan, { loadId, instanceId }) => { /* plan direkt ändern */ return { ok: true }; },
  },
  // Harte Regeln: nur neu entstandene Verstöße melden, Altlasten blockieren niemanden.
  pruefe: (vorher, nachher) => [],
};
```

Absichten lohnen sich, wenn zwei Personen gleichzeitig dieselbe knappe Ressource vergeben könnten (z. B. denselben Abgang oder dieselbe Phase). Damit Server und App gleich rechnen, kommt der Code aus dem App-Repo: Der Netzwerkplaner ist dafür als Git-Submodul eingebunden (`netzwerkplaner/`, Alias `@netzwerkplaner` in `scripts/build.js`). Für den Stromplaner ginge das genauso.

## 12. Legacy `/api/plans` und Übergang

Bis der Umbau fertig ist, bietet der Planer-Server die bisherigen Endpunkte unverändert an, mit demselben Token:

| | |
|---|---|
| `GET /api/plans` | `[{ id, name, date, instances }]` (`name` = `meta.production`, `id` = `_syncId` oder Dateiname) |
| `GET /api/plans/:id` | Plan-JSON |
| `PUT /api/plans/:id` | Plan-JSON speichern |
| `DELETE /api/plans/:id` | löschen |

Daten liegen in `DATA_DIR/stromplaner/plans/*.json`. Der Stromplaner funktioniert also heute schon, wenn man in den Einstellungen den Planer-Server statt des alten Servers einträgt. Die Endpunkte werden entfernt, sobald der Stromplaner nur noch Sitzungen nutzt.

## 13. Testen

```bash
git clone --recurse-submodules https://github.com/Nomisimo/Planer-Server
cd Planer-Server && npm ci
npm test                                   # Server-Tests mit mehreren Clients
node scripts/build.js && PORT=3001 DATA_DIR=./data node dist/server.js
```

`test/server.test.js` zeigt das Zusammenspiel mehrerer Clients in Node, inklusive Stromplaner-Sitzung, Reconnect, Konflikten, Sperren und Sitzungsende. Ein zweiter Teilnehmer für Tests in der App lässt sich mit dem Sync-Client in Node simulieren:

```js
import WebSocket from "ws";
import { createSyncClient } from "./client/sync-client.js";
const b = createSyncClient({ url: "ws://127.0.0.1:3001/ws", WebSocket, app: "stromplaner",
  appVersion: "1.2.0", session: "<id>", name: "Testperson", onDoc: (d) => console.log("seq", b.seq) });
```

Für schnelle Tests des 72-h-Beendens den Server mit `LEER_BEENDBAR_STUNDEN=0.001` starten.

## 14. Stolpersteine aus dem Netzwerkplaner

- **`prompt()` gibt es in Electron nicht.** Es wirft „prompt() is not supported“. Eingaben (Sitzungscode usw.) im Fenster selbst abfragen.
- **HTTP aus dem Hauptprozess.** Der Netzwerkplaner stellt HTTP-Anfragen an den Server über den Electron-Hauptprozess (`net.fetch` per IPC). Das umgeht CORS-Besonderheiten von Reverse-Proxys, folgt Umleitungen `http` → `https` und liefert echte Fehlermeldungen statt „Failed to fetch“ (`server-fetch` in `src/main/main.js`).
- **HTTP/3 abschalten.** Reverse-Proxys bieten oft HTTP/3 an, ohne dass UDP 443 durchkommt. Electron scheitert dann mit `ERR_QUIC_PROTOCOL_ERROR`. Abhilfe: `app.commandLine.appendSwitch('disable-quic')` vor dem Start.
- **`ERR_SSL_UNRECOGNIZED_NAME_ALERT`** heißt: Der Proxy hat für den Namen kein Zertifikat oder der Name zeigt im LAN woandershin. Das ist kein App-Fehler.
- **`ws://` von einer HTTPS-Seite** blockiert der Browser (gilt für die spätere Handy-Webapp): dort `wss://` über den Proxy nutzen.
- **Beim Beitreten nichts ersetzen, bevor `welcome` kam.** Scheitert der Beitritt (`beendet` mit `warVerbunden: false`), bleibt der lokale Plan unverändert.
