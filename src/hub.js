// Sitzungen und Echtzeit-Protokoll (WebSocket, JSON).
//
// C→S  hello    { app, appVersion, session, code, name, clientId, lastSeq?, token? }
// S→C  welcome  { session, seq, doc | ops, you, users, migrieren? }
// C→S  tx       { txId, baseSeq, ops }  oder  { txId, baseSeq, intent: { name, args } }
// S→C  ack      { txId, seq, ops, skipped, conflicts, result }
// S→C  reject   { txId, reason, detail }
// S→*  applied  { seq, user, txId, ops }
// C↔S  presence { data }  →  S→* presence { user, data }   (flüchtig, ohne seq)
// S→*  users    { users }
// C→S  sperre   { path }  Feld wird gerade bearbeitet (erneuern beim Tippen), freigabe { path? }
// S→*  sperren  { sperren: [{ key, path, user, name }] }
// C→S  verlauf  { vor?, limit? }  →  S→C verlauf { eintraege }   (Verlauf aller Nutzer)
// C→S  beenden  {}  Sitzung für alle beenden → S→* error { reason: "sitzung-geloescht", detail: { von } }
// S→C  error    { reason, detail }   danach wird die Verbindung geschlossen
import crypto from "node:crypto";
import { apply, diff, pathKey, valueAt } from "./ops.js";
import { appModul } from "./apps/index.js";
import { vergleicheVersion } from "../client/sync-client.js";

export { vergleicheVersion };

export const PROTO = 1;
const RECENT = 1000;          // so viele Transaktionen reichen für Reconnect ohne Snapshot
const SNAPSHOT_ALLE = 200;    // Transaktionen
const SNAPSHOT_RUHE = 10_000; // ms nach der letzten Änderung
const SPERRE_MS = 120_000;   // Feldsperre verfällt ohne Erneuerung
const LEER_BEENDBAR_MS = 72 * 3600_000; // so lange ohne Teilnehmer, dann darf man die Sitzung von außen beenden
const VERLAUF_TEXTE = 8;     // so viele Einzelbeschreibungen je Verlaufseintrag
const FARBEN = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324", "#469990", "#800000"];

const clone = (x) => JSON.parse(JSON.stringify(x));
const hash = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");
const gleich = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export const neueId = () => crypto.randomBytes(9).toString("base64url");

// Schlüssel eines Ops für Last-Writer-Wins (ins/rem adressieren das Element selbst)
const opKey = (o) => (o.op === "ins" ? pathKey([...o.path, { id: o.value.id }]) : o.op === "rem" ? pathKey([...o.path, { id: o.id }]) : pathKey(o.path));
// Ändert ein Op nichts am aktuellen Stand? Automatiken (Icons nachtragen, Positionen sichern) laufen auf
// jedem Client; schreiben zwei dasselbe, soll das weder als Konflikt noch als verworfen gemeldet werden.
const gleich2 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const istNoop = (doc, o) => {
  if (o.op === "set") return gleich2(valueAt(doc, o.path), o.value);
  if (o.op === "ins") { const a = valueAt(doc, o.path); return Array.isArray(a) && a.some((x) => x?.id === o.value.id && gleich2(x, o.value)); }
  if (o.op === "add") { const a = valueAt(doc, o.path); return Array.isArray(a) && a.includes(o.value); }
  return false;
};

const vorfahren = (key) => { const t = key.split("/"); return t.map((_, i) => t.slice(0, i + 1).join("/")); };
// Überschneiden sich zwei Pfade (gleich, oder einer liegt im anderen)?
const ueberlappt = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

// Lesbare Beschreibung eines Ops für den Verlauf: IDs werden durch Namen ersetzt
const beschreibe = (o, doc, labels = {}) => {
  const teile = []; let cur = doc;
  const pfad = o.op === "ins" ? [...o.path, { id: o.value.id }] : o.op === "rem" ? [...o.path, { id: o.id }] : o.path;
  const alt = o.op === "rem" ? o.old : o.op === "ins" ? o.value : null;
  for (const seg of pfad) {
    if (seg && typeof seg === "object") {
      const el = Array.isArray(cur) ? cur.find((x) => x?.id === seg.id) : null;
      const n = el || (seg.id === alt?.id ? alt : null);
      teile.push(`„${n?.name || n?.label || n?.vid || seg.id}“`);
      cur = el;
    } else { teile.push(labels[seg] || seg); cur = cur?.[seg]; }
  }
  const was = { set: "geändert", del: "entfernt", ins: "angelegt", rem: "gelöscht", order: "umsortiert", add: "ergänzt", drop: "entfernt" }[o.op];
  const wert = o.op === "set" && (typeof o.value !== "object" || o.value === null) ? `: ${JSON.stringify(o.old ?? "")} → ${JSON.stringify(o.value)}` : o.op === "add" || o.op === "drop" ? ` (${o.value})` : "";
  return `${teile.join(" › ")} ${was}${wert}`;
};

class Sitzung {
  constructor(hub, { meta, seq, doc }) {
    this.hub = hub;
    this.meta = meta;
    this.seq = seq;
    this.doc = doc;
    this.feldSeq = new Map(); // pathKey → { seq, user, name }
    this.recent = [];
    this.clients = new Set();
    this.seitSnapshot = 0;
    this.timer = null;
    this.sperren = new Map(); // pathKey → { path, user, name, bis }
    // Seit wann niemand verbunden ist (für „extern beenden“ nach 72 h). Nach einem Neustart ist niemand da.
    if (!this.meta.leerSeit) this.meta.leerSeit = this.meta.geaendert || this.meta.erstellt;
  }
  get id() { return this.meta.id; }
  get app() { return this.meta.app; }

  info() {
    const users = this.users().length;
    const leerSeit = users ? null : this.meta.leerSeit;
    return { id: this.id, app: this.app, name: this.meta.name, appVersion: this.meta.appVersion, seq: this.seq, users, codeNoetig: !!this.meta.codeHash, geaendert: this.meta.geaendert, erstellt: this.meta.erstellt, leerSeit, beendbar: this.beendbar() };
  }
  // Von außen (ohne Beitritt) beenden darf man nur eine Sitzung, die lange niemand mehr genutzt hat
  beendbar() { return !this.clients.size && Date.now() - Date.parse(this.meta.leerSeit || 0) >= this.hub.leerBeendbarMs; }
  users() { return [...this.clients].map((c) => c.user); }
  senden(msg, ausser) { const s = JSON.stringify(msg); for (const c of this.clients) if (c !== ausser) c.send(s); }

  /* Feldsperren: Wer in einem Feld tippt, sperrt es für die anderen (mit Hinweis in deren App). */
  aktuelleSperren() {
    const jetzt = Date.now();
    for (const [k, l] of this.sperren) if (l.bis < jetzt) this.sperren.delete(k);
    return [...this.sperren].map(([key, l]) => ({ key, path: l.path, user: l.user, name: l.name }));
  }
  sperrenSenden() { this.senden({ type: "sperren", sperren: this.aktuelleSperren() }); }
  sperre(client, path) {
    if (!Array.isArray(path) || !path.length) return;
    const key = pathKey(path);
    const fremd = this.aktuelleSperren().find((l) => l.user !== client.user.id && ueberlappt(l.key, key));
    if (fremd) return client.sendJson({ type: "sperre-abgelehnt", path, von: fremd.name });
    const neu = !this.sperren.has(key) || this.sperren.get(key).user !== client.user.id;
    for (const [k, l] of this.sperren) if (l.user === client.user.id && k !== key) this.sperren.delete(k); // eine Sperre je Person
    this.sperren.set(key, { path, user: client.user.id, name: client.user.name, bis: Date.now() + SPERRE_MS });
    if (neu) this.sperrenSenden();
  }
  freigabe(client, path) {
    let geaendert = false;
    for (const [k, l] of this.sperren) if (l.user === client.user.id && (!path || k === pathKey(path))) { this.sperren.delete(k); geaendert = true; }
    if (geaendert) this.sperrenSenden();
  }
  gesperrtFuer(client, ops) {
    const fremde = this.aktuelleSperren().filter((l) => l.user !== client.user.id);
    if (!fremde.length) return null;
    for (const o of ops) { const k = opKey(o); const l = fremde.find((x) => ueberlappt(x.key, k)); if (l) return l; }
    return null;
  }

  // Eine Transaktion prüfen und anwenden. Alles oder nichts.
  tx(client, { txId, baseSeq = this.seq, ops, intent }) {
    const modul = appModul(this.app);
    const next = clone(this.doc);
    let angewendet, skipped = [], result = null;
    if (intent) {
      const fn = Object.hasOwn(modul.intents, intent.name) ? modul.intents[intent.name] : null;
      if (!fn) return client.sendJson({ type: "reject", txId, reason: "unbekannte-absicht", detail: intent.name });
      try { result = fn(next, intent.args || {}) || {}; }
      catch (e) { return client.sendJson({ type: "reject", txId, reason: "absicht-fehler", detail: e.message }); }
      if (result.fehler) return client.sendJson({ type: "reject", txId, reason: "abgelehnt", detail: result.fehler });
      angewendet = diff(this.doc, next);
    } else {
      if (!Array.isArray(ops)) return client.sendJson({ type: "reject", txId, reason: "ungueltig", detail: "ops fehlt" });
      ops = ops.filter((o) => !istNoop(this.doc, o));
      try { skipped = apply(next, ops); }
      catch (e) { return client.sendJson({ type: "reject", txId, reason: "ungueltig", detail: e.message }); }
      angewendet = ops.filter((o) => !skipped.includes(o));
    }
    const gesperrt = this.gesperrtFuer(client, angewendet);
    if (gesperrt) return client.sendJson({ type: "reject", txId, reason: "gesperrt", detail: `${gesperrt.name} bearbeitet dieses Feld gerade`, path: gesperrt.path });
    const verstoesse = modul.pruefe(this.doc, next);
    if (verstoesse.length) return client.sendJson({ type: "reject", txId, reason: "invariante", detail: verstoesse });

    // Last-Writer-Wins: gilt trotzdem, aber der Überschreibende erfährt, wessen Änderung er ersetzt.
    const conflicts = [];
    for (const o of angewendet) for (const k of vorfahren(opKey(o))) {
      const f = this.feldSeq.get(k);
      if (f && f.seq > baseSeq && f.user !== client.user.id) { conflicts.push({ path: o.path, von: f.name, seq: f.seq }); break; }
    }
    if (!angewendet.length) return client.sendJson({ type: "ack", txId, seq: this.seq, ops: [], skipped, conflicts, result });

    const vorher = this.doc;
    const seq = this.seq + 1;
    const eintrag = { seq, user: client.user.id, name: client.user.name, txId, ops: angewendet, zeit: Date.now() };
    this.hub.store.anhaengen(this.app, this.id, eintrag); // erst sicher ablegen, dann übernehmen
    this.doc = next;
    this.seq = seq;
    for (const o of angewendet) this.feldSeq.set(opKey(o), { seq, user: client.user.id, name: client.user.name });
    this.recent.push(eintrag);
    if (this.recent.length > RECENT) this.recent.shift();
    this.meta.geaendert = new Date().toISOString();
    const texte = angewendet.slice(0, VERLAUF_TEXTE).map((o) => beschreibe(o, o.op === "rem" || o.op === "del" ? vorher : next, modul.labels));
    try { this.hub.store.verlauf(this.app, this.id, { seq, zeit: eintrag.zeit, user: client.user.id, name: client.user.name, absicht: intent?.name || null, anzahl: angewendet.length, texte }); }
    catch (e) { console.error("Verlauf nicht geschrieben:", e.message); }
    this.nachSchreiben();
    client.sendJson({ type: "ack", txId, seq, ops: angewendet, skipped, conflicts, result });
    this.senden({ type: "applied", seq, user: client.user.id, name: client.user.name, txId, ops: angewendet }, client);
  }

  nachSchreiben() {
    this.seitSnapshot += 1;
    clearTimeout(this.timer);
    if (this.seitSnapshot >= SNAPSHOT_ALLE) return this.sichern();
    this.timer = setTimeout(() => this.sichern(), SNAPSHOT_RUHE);
    this.timer.unref?.();
  }
  sichern() {
    clearTimeout(this.timer);
    if (!this.seitSnapshot) return;
    this.hub.store.snapshot(this.app, this.id, this.seq, this.doc);
    this.hub.store.schreibeMeta(this.app, this.id, this.meta);
    this.seitSnapshot = 0;
  }
}

export class Hub {
  constructor({ store, authToken = "", leerBeendbarMs = LEER_BEENDBAR_MS }) {
    this.store = store;
    this.authToken = authToken;
    this.leerBeendbarMs = leerBeendbarMs;
    this.sitzungen = new Map();
    this.fehlversuche = new Map(); // ip → { n, bis }
    for (const s of store.ladeAlle(apply)) this.sitzungen.set(s.meta.id, new Sitzung(this, s));
  }

  liste(app) { return [...this.sitzungen.values()].filter((s) => !app || s.app === app).map((s) => s.info()); }

  erstellen({ app, name, code, appVersion, doc }) {
    if (!appModul(app)) throw Object.assign(new Error(`Unbekannte App: ${app}`), { status: 400 });
    if (!doc || typeof doc !== "object") throw Object.assign(new Error("Plan fehlt"), { status: 400 });
    const jetzt = new Date().toISOString();
    const meta = { id: neueId(), app, name: String(name || "Sitzung").slice(0, 120), appVersion: String(appVersion || ""), codeHash: code ? hash(code) : null, erstellt: jetzt, geaendert: jetzt, leerSeit: jetzt };
    this.store.schreibeMeta(app, meta.id, meta);
    this.store.snapshot(app, meta.id, 0, doc);
    const s = new Sitzung(this, { meta, seq: 0, doc });
    this.sitzungen.set(meta.id, s);
    return s.info();
  }

  // Sitzung für alle beenden. Die Verbundenen behalten ihren Stand als veraltete Kopie (in der App).
  loeschen(id, von = null) {
    const s = this.sitzungen.get(id);
    if (!s) return false;
    s.sichern();
    s.senden({ type: "error", reason: "sitzung-geloescht", detail: von ? { von: von.user.name } : null }, von);
    for (const c of s.clients) c.close(4000, "sitzung-geloescht");
    clearTimeout(s.timer);
    this.sitzungen.delete(id);
    this.store.loesche(s.app, id);
    return true;
  }

  // Sitzungscode prüfen, mit Sperre nach zu vielen Fehlversuchen je Adresse
  pruefeCode(s, code, ip) {
    const f = this.fehlversuche.get(ip);
    if (f && f.bis > Date.now()) return "gesperrt";
    if (!s.meta.codeHash || gleich(hash(code || ""), s.meta.codeHash)) { this.fehlversuche.delete(ip); return null; }
    const n = (f?.n || 0) + 1;
    this.fehlversuche.set(ip, { n, bis: n >= 10 ? Date.now() + 60_000 : 0 });
    return "code-falsch";
  }
  pruefeToken(token) { return !this.authToken || gleich(token || "", this.authToken); }

  // Neue WebSocket-Verbindung; erste Nachricht muss hello sein.
  verbinden(ws, ip) {
    const client = {
      ws, ip, user: null, sitzung: null, alive: true,
      send: (s) => { if (ws.readyState === 1) ws.send(s); },
      sendJson: (m) => client.send(JSON.stringify(m)),
      close: (code, why) => ws.close(code, why),
    };
    const fehler = (reason, detail) => { client.sendJson({ type: "error", reason, detail }); ws.close(4001, reason); };
    const helloTimer = setTimeout(() => { if (!client.sitzung) fehler("timeout", "hello fehlt"); }, 10_000);
    ws.on("pong", () => { client.alive = true; });
    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return fehler("ungueltig", "kein JSON"); }
      if (!client.sitzung) {
        if (m.type !== "hello") return fehler("ungueltig", "hello erwartet");
        clearTimeout(helloTimer);
        return this.hello(client, m, fehler);
      }
      const s = client.sitzung;
      try { return this.nachricht(client, s, m); }
      catch (e) {
        // Ein Fehler (z. B. Datenträger voll) darf nie den ganzen Server beenden
        console.error(`Fehler in Sitzung ${s.app}/${s.id}:`, e);
        if (m.type === "tx") client.sendJson({ type: "reject", txId: m.txId, reason: "serverfehler", detail: e.message });
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      const s = client.sitzung;
      if (!s) return;
      s.clients.delete(client);
      if ([...s.clients].some((c) => c.user.id === client.user.id)) return; // durch neue Verbindung ersetzt
      s.freigabe(client);
      s.senden({ type: "users", users: s.users() });
      if (!s.clients.size && this.sitzungen.has(s.id)) {
        s.sichern();
        s.meta.leerSeit = new Date().toISOString();
        this.store.schreibeMeta(s.app, s.id, s.meta);
      }
    });
    return client;
  }


  nachricht(client, s, m) {
    if (m.type === "tx") return s.tx(client, m);
    if (m.type === "presence") { client.user.presence = m.data; return s.senden({ type: "presence", user: client.user.id, data: m.data }, client); }
    if (m.type === "sperre") return s.sperre(client, m.path);
    if (m.type === "freigabe") return s.freigabe(client, m.path);
    if (m.type === "verlauf") return client.sendJson({ type: "verlauf", eintraege: this.store.leseVerlauf(s.app, s.id, m) });
    if (m.type === "ping") return client.sendJson({ type: "pong" });
    if (m.type === "beenden") return this.loeschen(s.id, client);
  }

  hello(client, m, fehler) {
    if (m.proto !== PROTO) return fehler("protokoll", `Server spricht Protokoll ${PROTO}`);
    if (!this.pruefeToken(m.token)) return fehler("token", "Server-Token falsch");
    const s = this.sitzungen.get(m.session);
    if (!s || s.app !== m.app) return fehler("unbekannt", "Sitzung nicht gefunden");
    const cf = this.pruefeCode(s, m.code, client.ip);
    if (cf) return fehler(cf, cf === "gesperrt" ? "Zu viele Fehlversuche, bitte eine Minute warten" : "Sitzungscode falsch");
    // Gleiche App-Version Pflicht. Ist niemand verbunden, übernimmt die Sitzung eine neuere Version;
    // der Client migriert dann den Plan und schickt das Ergebnis als normale Transaktion.
    // Eine ältere App darf eine neuere Sitzung nie übernehmen (sie kennt deren Daten nicht).
    let migrieren = false;
    if (m.appVersion !== s.meta.appVersion) {
      if (s.clients.size || vergleicheVersion(m.appVersion, s.meta.appVersion) < 0) return fehler("version", `Die Sitzung läuft mit Version ${s.meta.appVersion}, du hast ${m.appVersion}`);
      s.meta.appVersion = String(m.appVersion || "");
      this.store.schreibeMeta(s.app, s.id, s.meta);
      migrieren = true;
    }
    const belegt = new Set(s.users().map((u) => u.farbe));
    client.user = { id: String(m.clientId || neueId()).slice(0, 64), name: String(m.name || "Gast").slice(0, 60), farbe: FARBEN.find((f) => !belegt.has(f)) || FARBEN[0], presence: null };
    // Dieselbe clientId zweimal (z. B. alter Tab nach Reconnect): alte Verbindung schließen
    for (const c of s.clients) if (c.user.id === client.user.id) c.close(4002, "ersetzt");
    client.sitzung = s;
    s.clients.add(client);
    s.meta.leerSeit = null;
    const nachhol = typeof m.lastSeq === "number" && m.lastSeq <= s.seq && (m.lastSeq === s.seq || s.recent[0]?.seq <= m.lastSeq + 1)
      ? s.recent.filter((t) => t.seq > m.lastSeq) : null;
    client.sendJson({ type: "welcome", session: s.info(), seq: s.seq, ...(nachhol ? { ops: nachhol } : { doc: s.doc }), you: client.user, users: s.users(), sperren: s.aktuelleSperren(), migrieren });
    s.senden({ type: "users", users: s.users() }, client);
  }

  // Heartbeat: alle 10 s ping, wer zweimal nicht antwortet, fliegt (≈ 30 s)
  heartbeat() {
    const t = setInterval(() => {
      for (const s of this.sitzungen.values()) for (const c of s.clients) {
        if (!c.alive) { c.missed = (c.missed || 0) + 1; if (c.missed >= 2) { c.ws.terminate(); continue; } }
        else c.missed = 0;
        c.alive = false;
        try { c.ws.ping(); } catch { /* geschlossen */ }
      }
    }, 10_000);
    t.unref?.();
    return t;
  }

  alleSichern() { for (const s of this.sitzungen.values()) s.sichern(); }
}
