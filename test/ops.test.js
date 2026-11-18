import test from "node:test";
import assert from "node:assert/strict";
import { apply, applyOp } from "../src/ops.js";

test("Prototype Pollution über Pfade wird abgewiesen", () => {
  const pfade = [["__proto__", "x"], ["constructor", "prototype", "x"], ["a", "__proto__", "x"], ["__proto__"], ["constructor"], ["a", "prototype"]];
  for (const path of pfade) {
    const doc = { a: {} };
    assert.equal(applyOp(doc, { op: "set", path, value: 1 }), false, JSON.stringify(path));
    assert.deepEqual(doc, { a: {} });
  }
  assert.equal(({}).x, undefined);
  assert.equal(applyOp({}, { op: "del", path: ["__proto__", "toString"] }), false);
  assert.equal(typeof ({}).toString, "function");
  assert.equal(applyOp({}, { op: "ins", path: ["__proto__"], value: { id: "z" }, after: null }), false);
});

test("Pfad, der kein Array ist, wird abgewiesen", () => {
  assert.equal(applyOp({}, { op: "set", path: "a", value: 1 }), false);
});

test("Normale Operationen funktionieren weiter", () => {
  const doc = { geraete: [{ id: "a1", name: "alt" }] };
  assert.equal(applyOp(doc, { op: "set", path: ["geraete", { id: "a1" }, "name"], value: "neu" }), true);
  assert.equal(doc.geraete[0].name, "neu");
  assert.deepEqual(apply(doc, [{ op: "set", path: ["titel"], value: "T" }]), []);
  assert.equal(doc.titel, "T");
});
