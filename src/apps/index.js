// App-Module: Jede App bekommt eigene Sitzungen. Ein Modul kann Absichten (Intents) und harte
// Prüfungen mitbringen, die der Server gegen den aktuellen Stand ausführt. Ohne Modul-Logik
// gilt nur die generische Regel: Operationen in Serverreihenfolge, Last-Writer-Wins je Feld.
import { netzwerkplaner } from "./netzwerkplaner.js";

export const generisch = (id, name) => ({ id, name, intents: {}, pruefe: () => [] });

export const APPS = {
  netzwerkplaner,
  stromplaner: generisch("stromplaner", "Stromplaner"),
};

export const appModul = (id) => (Object.hasOwn(APPS, id) ? APPS[id] : null);
