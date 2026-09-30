import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { starteServer } from "../src/server.js";
import { createSyncClient } from "../client/sync-client.js";
import { diff } from "../src/ops.js";
import { demoProject } from "@netzwerkplaner/demo.js";
import { pruefeInvarianten } from "@netzwerkplaner/invarianten.js";

const clone = (x) => JSON.parse(JSON.stringify(x));
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const bis = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error("Zeitüberschreitung"); await warte(10); } };

const umgebung = async (opts = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "planer-"));
  const srv = await starteServer({ port: 0, dataDir, host: "127.0.0.1", ...opts });
  const base = `http://127.0.0.1:${srv.port}`;
  const req = (p, init = {}) => fetch(base + p, { ...init, headers: { "Content-Type": "application/json", ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}), ...(init.headers || {}) } });
  const clients = [];
  const client = (o) => { const c = createSyncClient({ url: `ws://127.0.0.1:${srv.port}/ws`, WebSocket, appVersion: "0.6.0", token: opts.authToken, ...o }); clients.push(c); return c; };
  const ende = async () => { clients.forEach((c) => c.close()); await srv.stop(); };
  return { srv, dataDir, req, client, ende };
};

// Macht aus einer Änderungsfunktion Operationen, wie es mutate() in der App tun wird
const aendern = (c, fn) => { const next = clone(c.doc); fn(next); c.submit(diff(c.doc, next)); };

test("Sitzungen sind je App getrennt, Stromplaner-Ablage funktioniert wie bisher", async () => {
  const u = await umgebung();
  try {
    await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "netzwerkplaner", name: "Halle A", doc: demoProject(), appVersion: "0.6.0" }) });
    await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "stromplaner", name: "Halle A Strom", doc: { meta: {}, instances: [] }, appVersion: "1.1.0" }) });
    const np = await (await u.req("/api/sessions?app=netzwerkplaner")).json();
    const sp = await (await u.req("/api/sessions?app=stromplaner")).json();
    assert.deepEqual(np.map((s) => s.name), ["Halle A"]);
    assert.deepEqual(sp.map((s) => s.name), ["Halle A Strom"]);
    assert.equal((await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "fremd", doc: {} }) })).status, 400);

    assert.equal((await u.req("/api/plans/abc", { method: "PUT", body: JSON.stringify({ meta: { production: "Show" }, instances: [1, 2] }) })).status, 200);
    assert.deepEqual(await (await u.req("/api/plans")).json(), [{ id: "abc", name: "Show", date: null, instances: 2 }]);
    assert.equal((await u.req("/api/plans/abc", { method: "DELETE" })).status, 200);
  } finally { await u.ende(); }
});

test("Zwei Netzwerkplaner-Clients: Live-Sync, Feld-LWW, Absichten, Invarianten", async () => {
  const u = await umgebung();
  try {
    const s = await (await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "netzwerkplaner", name: "Test", code: "ABC123", doc: clone(demoProject()), appVersion: "0.6.0" }) })).json();
    const hinweiseA = [], hinweiseB = [];
    const A = u.client({ app: "netzwerkplaner", session: s.id, code: "ABC123", name: "Anna", onHinweis: (h) => hinweiseA.push(h) });
    const B = u.client({ app: "netzwerkplaner", session: s.id, code: "ABC123", name: "Ben", onHinweis: (h) => hinweiseB.push(h) });
    await bis(() => A.online && B.online);

    // Verschiedene Felder desselben Ports gleichzeitig: beide bleiben
    const dev = A.doc.geraete.find((g) => g.ports.length > 1);
    aendern(A, (d) => { d.geraete.find((g) => g.id === dev.id).ports[0].ip = "10.0.0.201"; });
    aendern(B, (d) => { d.geraete.find((g) => g.id === dev.id).name = "Umbenannt"; });
    await bis(() => !A.ausstehend && !B.ausstehend && A.seq === 2 && B.seq === 2);
    assert.deepEqual(A.doc, B.doc);
    const g = B.doc.geraete.find((x) => x.id === dev.id);
    assert.equal(g.ports[0].ip, "10.0.0.201");
    assert.equal(g.name, "Umbenannt");

    // Dasselbe Feld gleichzeitig: letzter gewinnt, der Überschreibende bekommt einen Hinweis
    aendern(A, (d) => { d.geraete.find((x) => x.id === dev.id).notizen = "von Anna"; });
    aendern(B, (d) => { d.geraete.find((x) => x.id === dev.id).notizen = "von Ben"; });
    await bis(() => !A.ausstehend && !B.ausstehend && A.seq === B.seq && A.seq === 4);
    assert.deepEqual(A.doc, B.doc);
    assert.ok([...hinweiseA, ...hinweiseB].some((h) => h.art === "ueberschrieben"));

    // Absicht: Server vergibt Port und Namen, beide sehen dieselbe neue ID
    const sw = A.doc.geraete.find((x) => x.isSwitch);
    const r = await A.intent("addDevice", { item: { kind: "typ", key: "pc" }, connectTo: sw.id });
    await bis(() => B.doc.geraete.some((x) => x.id === r.id));
    assert.deepEqual(A.doc, B.doc);

    // A löscht das Gerät, B will es gleichzeitig verkabeln: B wird abgelehnt
    const lösch = A.intent("loescheGeraete", { ids: [r.id] });
    const verb = B.intent("connect", { from: r.id, to: sw.id }).catch((e) => e);
    await lösch;
    const e = await verb;
    assert.ok(e instanceof Error && /gelöscht/.test(e.message), String(e));
    await bis(() => A.seq === B.seq);
    assert.deepEqual(A.doc, B.doc);

    // Harte Invariante: Verbindung auf gelöschten Port wird abgelehnt, lokaler Stand springt zurück
    const vorher = clone(B.doc);
    const c0 = B.doc.verbindungen[0];
    aendern(B, (d) => { d.verbindungen.push({ ...clone(c0), id: "doppelt" }); });
    await bis(() => !B.ausstehend);
    assert.deepEqual(B.doc, vorher);
    assert.ok(hinweiseB.some((h) => h.art === "abgelehnt" && h.reason === "invariante"));
    assert.deepEqual(pruefeInvarianten(A.doc), []);
  } finally { await u.ende(); }
});

test("Falscher Code, falsche Version und Token werden abgewiesen", async () => {
  const u = await umgebung({ authToken: "geheim" });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${u.srv.port}/api/sessions`)).status, 401);
    const s = await (await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "netzwerkplaner", name: "T", code: "X1", doc: clone(demoProject()), appVersion: "0.6.0" }) })).json();
    const st = [];
    u.client({ app: "netzwerkplaner", session: s.id, code: "falsch", name: "C", onStatus: (x, d) => st.push(d?.reason || x) });
    await bis(() => st.includes("code-falsch"));
    const A = u.client({ app: "netzwerkplaner", session: s.id, code: "X1", name: "A" });
    await bis(() => A.online);
    const st2 = [];
    u.client({ app: "netzwerkplaner", session: s.id, code: "X1", name: "Alt", appVersion: "0.5.0", onStatus: (x, d) => st2.push(d?.reason || x) });
    await bis(() => st2.includes("version"));
    const st3 = [];
    u.client({ app: "stromplaner", session: s.id, code: "X1", name: "Falsche App", onStatus: (x, d) => st3.push(d?.reason || x) });
    await bis(() => st3.includes("unbekannt"));
  } finally { await u.ende(); }
});

test("Reconnect holt verpasste Änderungen nach, Neustart lädt Snapshot + Log", async () => {
  const u = await umgebung();
  let sid;
  try {
    const s = await (await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "stromplaner", name: "Strom", doc: { meta: { production: "X" }, instances: [] }, appVersion: "1.1.0" }) })).json();
    sid = s.id;
    const A = u.client({ app: "stromplaner", session: s.id, name: "A", appVersion: "1.1.0" });
    const B = u.client({ app: "stromplaner", session: s.id, name: "B", appVersion: "1.1.0" });
    await bis(() => A.online && B.online);
    // B verliert die Verbindung, A arbeitet weiter, B arbeitet offline weiter
    const bWs = [...u.srv.hub.sitzungen.get(s.id).clients].find((c) => c.user.name === "B");
    bWs.ws.terminate();
    await bis(() => !B.online);
    aendern(A, (d) => { d.instances.push({ id: "i1", name: "Verteiler 1" }); });
    aendern(B, (d) => { d.meta.production = "Show B"; });
    await bis(() => B.online && !B.ausstehend && !A.ausstehend && A.seq === B.seq, 8000);
    assert.deepEqual(A.doc, B.doc);
    assert.equal(A.doc.meta.production, "Show B");
    assert.equal(A.doc.instances.length, 1);
  } finally { await u.ende(); }
  // Neustart mit demselben Datenordner
  const srv2 = await starteServer({ port: 0, dataDir: u.dataDir, host: "127.0.0.1" });
  try {
    const d = await (await fetch(`http://127.0.0.1:${srv2.port}/api/sessions/${sid}/doc`)).json();
    assert.equal(d.seq, 2);
    assert.equal(d.doc.meta.production, "Show B");
  } finally { await srv2.stop(); }
});

test("Drei Clients, zufällige gleichzeitige Änderungen: alle landen beim selben Stand", async () => {
  const u = await umgebung();
  try {
    const s = await (await u.req("/api/sessions", { method: "POST", body: JSON.stringify({ app: "netzwerkplaner", name: "Last", doc: clone(demoProject()), appVersion: "0.6.0" }) })).json();
    const C = ["A", "B", "C"].map((n) => u.client({ app: "netzwerkplaner", session: s.id, name: n }));
    await bis(() => C.every((c) => c.online));
    let seed = 3;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 60; i++) {
      const c = C[rnd(3)];
      const art = rnd(4);
      aendern(c, (d) => {
        const g = d.geraete[rnd(d.geraete.length)];
        if (art === 0) g.name = `${g.name.split(" #")[0]} #${i}`;
        else if (art === 1 && g.ports[0]) g.ports[0].ip = `10.1.${rnd(3)}.${10 + rnd(200)}`;
        else if (art === 2) d.layout.offsets[g.id] = { x: rnd(300), y: rnd(300) };
        else d.vlans[rnd(d.vlans.length)].notiz = `n${i}`;
      });
      if (rnd(3) === 0) await warte(1);
    }
    await bis(() => C.every((c) => !c.ausstehend) && new Set(C.map((c) => c.seq)).size === 1, 8000);
    assert.deepEqual(C[0].doc, C[1].doc);
    assert.deepEqual(C[1].doc, C[2].doc);
    assert.deepEqual(C[0].doc, u.srv.hub.sitzungen.get(s.id).doc);
  } finally { await u.ende(); }
});
