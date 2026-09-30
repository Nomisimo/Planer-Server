// Ablage je Sitzung: <DATA_DIR>/<app>/<id>/
//   meta.json      Name, App, App-Version, Sitzungscode (gehasht), Zeiten
//   snapshot.json  { seq, doc }  kanonischer Stand
//   ops.jsonl      Transaktionen seit dem Snapshot (eine Zeile je Transaktion)
//   backups/       stündliche Snapshots, die letzten 48 bleiben
import fs from "node:fs";
import path from "node:path";

const BACKUPS = 48;

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  sitzungsDir(app, id) { return path.join(this.dir, app, id); }

  // Alle gespeicherten Sitzungen laden: Snapshot plus Transaktionen aus dem Log nachspielen.
  ladeAlle(apply) {
    const out = [];
    for (const app of fs.readdirSync(this.dir)) {
      const appDir = path.join(this.dir, app);
      if (!fs.statSync(appDir).isDirectory() || app === "plans") continue;
      for (const id of fs.readdirSync(appDir)) {
        try { out.push(this.lade(app, id, apply)); }
        catch (e) { console.error(`Sitzung ${app}/${id} nicht lesbar: ${e.message}`); }
      }
    }
    return out;
  }

  lade(app, id, apply) {
    const d = this.sitzungsDir(app, id);
    const meta = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));
    const snap = JSON.parse(fs.readFileSync(path.join(d, "snapshot.json"), "utf8"));
    let { seq, doc } = snap;
    const logFile = path.join(d, "ops.jsonl");
    if (fs.existsSync(logFile)) {
      for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let tx;
        try { tx = JSON.parse(line); } catch { break; } // abgerissene letzte Zeile nach Absturz
        if (tx.seq <= seq) continue;
        apply(doc, tx.ops);
        seq = tx.seq;
      }
    }
    return { meta, seq, doc };
  }

  schreibeMeta(app, id, meta) {
    const d = this.sitzungsDir(app, id);
    fs.mkdirSync(d, { recursive: true });
    atomar(path.join(d, "meta.json"), JSON.stringify(meta, null, 2));
  }

  anhaengen(app, id, tx) {
    fs.appendFileSync(path.join(this.sitzungsDir(app, id), "ops.jsonl"), JSON.stringify(tx) + "\n");
  }

  // Snapshot schreiben, Log leeren, stündlich eine Sicherung
  snapshot(app, id, seq, doc) {
    const d = this.sitzungsDir(app, id);
    fs.mkdirSync(d, { recursive: true });
    const json = JSON.stringify({ seq, doc });
    atomar(path.join(d, "snapshot.json"), json);
    fs.writeFileSync(path.join(d, "ops.jsonl"), "");
    const b = path.join(d, "backups");
    fs.mkdirSync(b, { recursive: true });
    const stunde = new Date().toISOString().slice(0, 13).replace(/[:T]/g, "-");
    const f = path.join(b, `${stunde}.json`);
    if (!fs.existsSync(f)) {
      fs.writeFileSync(f, json);
      const alle = fs.readdirSync(b).filter((x) => x.endsWith(".json")).sort();
      for (const alt of alle.slice(0, Math.max(0, alle.length - BACKUPS))) fs.rmSync(path.join(b, alt));
    }
  }

  loesche(app, id) {
    fs.rmSync(this.sitzungsDir(app, id), { recursive: true, force: true });
  }
}

const atomar = (file, text) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};
