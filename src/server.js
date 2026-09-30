// HTTP + WebSocket. Ohne Express, einzige Abhängigkeit ist ws.
//
// GET    /health
// GET    /api/apps                         bekannte Apps
// GET    /api/sessions?app=netzwerkplaner  Sitzungen einer App
// POST   /api/sessions                     { app, name, code?, appVersion, doc } → Sitzung anlegen
// GET    /api/sessions/:id/doc             aktueller Stand (Kopie speichern), Header X-Session-Code
// GET    /api/sessions/:id/verlauf         Verlauf aller Nutzer (?vor=seq&limit=100)
// DELETE /api/sessions/:id                 Header X-Session-Code
// WS     /ws                               Echtzeit-Protokoll, siehe hub.js
//
// Stromplaner-kompatibel (bisheriger Sync-Server, unverändert nutzbar):
// GET/PUT/DELETE /api/plans[/:id]
//
// Zugriff: optional AUTH_TOKEN für alles außer /health (Authorization: Bearer …, im WS-hello als token).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { Hub, PROTO } from "./hub.js";
import { Store } from "./store.js";
import { APPS } from "./apps/index.js";

const MAX_BODY = 20 * 1024 * 1024;

export const starteServer = ({ port = 3001, dataDir = "./data", authToken = "", host } = {}) => {
  const store = new Store(dataDir);
  const hub = new Hub({ store, authToken });
  const plansDir = path.join(dataDir, "stromplaner", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = (id) => path.join(plansDir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const lesen = (req) => new Promise((resolve, reject) => {
    let n = 0; const teile = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error("Zu groß"), { status: 413 })); req.destroy(); } else teile.push(c); });
    req.on("end", () => { try { resolve(teile.length ? JSON.parse(Buffer.concat(teile)) : null); } catch { reject(Object.assign(new Error("Kein JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
  const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer /, "");
  const ipOf = (req) => req.socket.remoteAddress || "";

  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Session-Code");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, "http://x");
    const p = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/health") return json(res, 200, { ok: true, proto: PROTO, apps: Object.keys(APPS) });
      if (!hub.pruefeToken(bearer(req))) return json(res, 401, { error: "Unauthorized" });

      if (url.pathname === "/api/apps") return json(res, 200, Object.values(APPS).map((a) => ({ id: a.id, name: a.name })));

      if (p[0] === "api" && p[1] === "sessions") {
        if (p.length === 2 && req.method === "GET") return json(res, 200, hub.liste(url.searchParams.get("app")));
        if (p.length === 2 && req.method === "POST") return json(res, 201, hub.erstellen((await lesen(req)) || {}));
        const s = hub.sitzungen.get(p[2]);
        if (!s) return json(res, 404, { error: "Sitzung nicht gefunden" });
        const cf = hub.pruefeCode(s, req.headers["x-session-code"], ipOf(req));
        if (cf) return json(res, 403, { error: cf });
        if (p.length === 4 && p[3] === "doc" && req.method === "GET") return json(res, 200, { seq: s.seq, doc: s.doc });
        if (p.length === 4 && p[3] === "verlauf" && req.method === "GET") return json(res, 200, hub.store.leseVerlauf(s.app, s.id, { vor: +url.searchParams.get("vor") || Infinity, limit: url.searchParams.get("limit") }));
        if (p.length === 3 && req.method === "DELETE") { hub.loeschen(s.id); return json(res, 200, { ok: true }); }
      }

      if (p[0] === "api" && p[1] === "plans") {
        if (p.length === 2 && req.method === "GET") {
          const list = fs.readdirSync(plansDir).filter((f) => f.endsWith(".json")).map((f) => {
            try {
              const plan = JSON.parse(fs.readFileSync(path.join(plansDir, f), "utf8"));
              return { id: plan._syncId || f.replace(".json", ""), name: plan.meta?.production || f.replace(".json", ""), date: plan.meta?.date || null, instances: plan.instances?.length || 0 };
            } catch { return null; }
          }).filter(Boolean);
          return json(res, 200, list);
        }
        if (p.length === 3) {
          const f = planFile(decodeURIComponent(p[2]));
          if (req.method === "GET") return fs.existsSync(f) ? json(res, 200, JSON.parse(fs.readFileSync(f, "utf8"))) : json(res, 404, { error: "Not found" });
          if (req.method === "PUT") {
            const body = await lesen(req);
            if (!body || typeof body !== "object") return json(res, 400, { error: "Invalid body" });
            fs.writeFileSync(f, JSON.stringify(body, null, 2));
            return json(res, 200, { ok: true, id: decodeURIComponent(p[2]) });
          }
          if (req.method === "DELETE") { if (!fs.existsSync(f)) return json(res, 404, { error: "Not found" }); fs.unlinkSync(f); return json(res, 200, { ok: true }); }
        }
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_BODY });
  wss.on("connection", (ws, req) => hub.verbinden(ws, ipOf(req)));
  const hb = hub.heartbeat();

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({
      server, hub,
      port: server.address().port,
      stop: () => new Promise((r) => { clearInterval(hb); hub.alleSichern(); for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => r()); }),
    }));
  });
};

// Direkt gestartet (node dist/server.js)
if (process.argv[1] && /server\.(js|mjs|cjs)$/.test(process.argv[1]) && !process.env.PLANER_SERVER_NO_START) {
  const port = +(process.env.PORT || 3001);
  const dataDir = process.env.DATA_DIR || "./data";
  starteServer({ port, dataDir, authToken: process.env.AUTH_TOKEN || "" }).then(({ stop }) => {
    console.log(`Planer-Server läuft auf Port ${port}, Daten in ${dataDir}${process.env.AUTH_TOKEN ? ", Token aktiv" : ""}`);
    const ende = () => stop().then(() => process.exit(0));
    process.on("SIGTERM", ende);
    process.on("SIGINT", ende);
  });
}
