// App-Module: Jede App bekommt eigene Sitzungen. Ein Modul kann Absichten (Intents) und harte
// Prüfungen mitbringen, die der Server gegen den aktuellen Stand ausführt. Ohne Modul-Logik
// gilt nur die generische Regel: Operationen in Serverreihenfolge, Last-Writer-Wins je Feld.
import { netzwerkplaner } from "./netzwerkplaner.js";

export const generisch = (id, name, labels = {}) => ({ id, name, labels, intents: {}, pruefe: () => [] });

export const APPS = {
  netzwerkplaner,
  stromplaner: generisch("stromplaner", "Stromplaner", { instances: "Verteiler", loads: "Verbraucher", boxTypes: "Verteilertyp", mainConns: "Einspeisung", placements: "Platzierung", meta: "Projekt" }),
};

export const appModul = (id) => (Object.hasOwn(APPS, id) ? APPS[id] : null);
