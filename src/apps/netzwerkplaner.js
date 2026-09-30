// Netzwerkplaner: Absichten und Invarianten kommen direkt aus dem App-Code (src/shared),
// beim Bauen über den Alias @netzwerkplaner eingebunden. So rechnen Server und App gleich.
import { INTENTS } from "@netzwerkplaner/intents.js";
import { pruefeInvarianten, fehlerKey } from "@netzwerkplaner/invarianten.js";

export const netzwerkplaner = {
  id: "netzwerkplaner",
  name: "Netzwerkplaner",
  labels: { geraete: "Gerät", ports: "Port", verbindungen: "Verbindung", vlans: "VLAN", layout: "Layout", meta: "Projekt", stroeme: "Strom" },
  intents: INTENTS,
  // Nur neu entstandene Verstöße zählen; Altlasten im Plan blockieren niemanden.
  pruefe: (vorher, nachher) => {
    const alt = new Set(pruefeInvarianten(vorher).map(fehlerKey));
    return pruefeInvarianten(nachher).filter((f) => !alt.has(fehlerKey(f)));
  },
};
