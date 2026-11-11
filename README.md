# bpmn-mcp

Ein MCP-Server, mit dem Claude BPMN-Diagramme für den **Camunda Modeler** (Camunda 8) zeichnen und bearbeiten kann.

Es gibt zwei Arbeitsweisen, die sich kombinieren lassen:

| Modus | Was passiert | Braucht |
|---|---|---|
| **Datei-Modus** | Claude liest und schreibt `.bpmn`-Dateien direkt. Der Modeler fragt anschließend, ob er die Datei neu laden soll. | nur den MCP-Server |
| **Live-Modus** | Claude bearbeitet das im Modeler **gerade geöffnete** Diagramm. Änderungen erscheinen sofort, Undo/Redo funktioniert. | MCP-Server + Modeler-Plugin |

## Voraussetzungen

- **Camunda Modeler** (Desktop), getestet mit **5.52.0**. Das Diagramm muss ein **Camunda-8-Diagramm** sein (Zeebe). Camunda 7 wird nicht unterstützt.
- **Node.js** ab Version 20.10, getestet mit Node 22, inklusive `npm`.
- Ein **MCP-fähiger Client**, zum Beispiel Claude Code oder Claude Desktop.
- Betriebssystem: getestet auf **macOS**. Linux und Windows sollten funktionieren, das Installationsskript ist aber nur für macOS (siehe Schritt 3 für die manuelle Installation).
- **Kein Camunda-Cluster nötig.** Der Server arbeitet nur mit dem Modeler und mit Dateien.

## Einrichtung

### 1. Projekt holen und Abhängigkeiten installieren

Lege den Ordner an einen festen Ort, denn der Pfad kommt später in die MCP-Konfiguration. Dann im Projektordner:

```bash
npm install
```

Wichtig: Führe `npm install` **im Projektordner** aus und achte darauf, dass dort eine `package.json` liegt. Sonst sucht npm in übergeordneten Ordnern weiter und installiert Pakete an der falschen Stelle.

### 2. Server testen (optional)

```bash
node test.js
```

Das Skript legt ein Beispieldiagramm in einem Temp-Ordner an und prüft alle Datei-Tools. Am Ende sollte `BPMNShapes: 6  BPMNEdges: 5` stehen, ohne eine Zeile mit `FEHLER`.

### 3. Modeler-Plugin installieren (nur für den Live-Modus)

**macOS:**

```bash
./install-plugin.sh
```

**Manuell (alle Systeme):** Kopiere die beiden Dateien aus `plugin/` (`index.js` und `client.js`) in einen neuen Ordner `bpmn-mcp-bridge` innerhalb des Plugin-Verzeichnisses deines Modelers:

| System | Plugin-Ordner |
|---|---|
| macOS | `~/Library/Application Support/camunda-modeler/resources/plugins/` |
| Linux | `~/.config/camunda-modeler/resources/plugins/` |
| Windows | `%APPDATA%\camunda-modeler\resources\plugins\` |

Das Ergebnis sieht dann so aus:

```
plugins/
  bpmn-mcp-bridge/
    index.js
    client.js
```

**Danach den Camunda Modeler komplett beenden und neu starten.** Plugins werden nur beim Start geladen. Speichere vorher deine Diagramme.

### 4. Server bei Claude eintragen

**Claude Code:**

```bash
claude mcp add bpmn -- node /voller/pfad/zu/bpmn-mcp/server.js
```

**Claude Desktop oder andere Clients** (in der MCP-Konfigurationsdatei des Clients):

```json
{
  "mcpServers": {
    "bpmn": {
      "command": "node",
      "args": ["/voller/pfad/zu/bpmn-mcp/server.js"]
    }
  }
}
```

Der Pfad muss absolut sein. Danach den Client bzw. die Session neu starten.

### 5. Ausprobieren

Öffne im Modeler ein Camunda-8-Diagramm und frage Claude zum Beispiel:

> Prüf mit live_status, ob der Modeler verbunden ist, und füge nach dem Start-Event einen User Task „Antrag prüfen“ ein.

Für den Datei-Modus:

> Lege unter `/pfad/bestellung.bpmn` ein neues Diagramm an: Start, Service Task „Bestand prüfen“, Gateway „Verfügbar?“, danach zwei Enden.

## Verfügbare Tools

**Live-Modus** (wirkt auf das im Modeler aktive Diagramm, alles per Undo rückgängig zu machen):

| Tool | Zweck |
|---|---|
| `live_status` | Verbindung und aktiven Tab prüfen (meldet auch ein veraltetes Plugin) |
| `live_describe` | Elemente und Verbindungen mit IDs, Typ, Pool/Lane, Event-Typ; mit `geometry: true` auch Positionen |
| `live_add_element` | Element anlegen (siehe Elementtypen), optional verbunden (`after`), in Pool/Lane/Teilprozess (`parent`), angeheftet (`attachTo`) |
| `live_connect` | Sequenzfluss, Nachrichtenfluss (zwischen Pools) oder Assoziation; Bedingung, Standardfluss |
| `live_update_element` | Name, Typ, Event-Definition, Job-Typ, Bedingung, Schleifen-/Multi-Instanz-Markierung, Farbe, Dokumentation, Camunda-8-Eigenschaften |
| `live_remove_element` | ein oder mehrere Elemente löschen |
| `live_arrange` | wie mit der Maus: verschieben (auch in andere Lane), Größe, Wegpunkte, Beschriftung, ausrichten, verteilen |
| `live_batch` | viele Änderungen in einem Aufruf; mit `layout: true` danach automatisch anordnen und prüfen |
| `live_layout` | Diagramm nach den Modellierungskonventionen anordnen (ein Undo-Schritt) |
| `live_check` | Prüfung gegen die Konventionen: Darstellung, Benennung, Struktur, Camunda-8-Pflichtangaben |
| `live_screenshot` | Bild des Diagramms, damit Claude das Ergebnis selbst ansehen kann |
| `live_undo`, `live_redo`, `live_save` | rückgängig, wiederherstellen, speichern |

**Datei-Modus** (Parameter `file` = absoluter Pfad): `create_diagram`, `describe_diagram`, `add_element`, `connect`, `update_element`, `remove_element`, `relayout`, `check_diagram`. Er legt einfache Abläufe an (Ereignisse, Aufgaben, Gateways, Event-Definitionen); `relayout` und `check_diagram` verstehen aber jede Datei, auch mit Pools, Lanes und Teilprozessen.

**Elementtypen im Live-Modus:** `startEvent`, `endEvent`, `intermediateCatchEvent`, `intermediateThrowEvent`, `boundaryEvent`, `task`, `userTask`, `serviceTask`, `scriptTask`, `businessRuleTask`, `sendTask`, `receiveTask`, `manualTask`, `callActivity`, `subProcess`, `eventSubProcess`, `transaction`, `adHocSubProcess`, `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`, `complexGateway`, `dataObject`, `dataStore`, `textAnnotation`, `group`, `participant` (Pool, optional mit `lanes`), `lane`.

**Event-Definitionen** (`eventDefinition`):

```json
{ "type": "timer", "timerType": "duration", "value": "P7D" }
{ "type": "timer", "timerType": "date", "value": "= startDatum" }
{ "type": "message", "name": "projekt_zugewiesen", "correlationKey": "= mitarbeiterId" }
{ "type": "signal" | "error" | "escalation", "name": "...", "code": "..." }
{ "type": "conditional", "value": "= x > 5" }
{ "type": "terminate" }   { "type": "compensate" }   { "type": "none" }
```

**Camunda-8-Eigenschaften** (`properties`): `assignee`, `candidateGroups`, `candidateUsers`, `dueDate`, `formId`, `retries`, `calledProcessId`, `decisionId`, `resultVariable`, `script`, `inputs`/`outputs` (`[{source, target}]`), `headers`.

## Layout und Konventionen

`layout.js` ordnet Diagramme nach den Camunda-Best-Practices an (Grundlage: Vorlesung Business Engineering, „Modellierungskonventionen“):

- von links nach rechts, der Normalablauf liegt auf einer geraden Linie
- Verzweigungen symmetrisch: gleichwertige Zweige ober- und unterhalb, Gateway mittig, Linien über die Gateway-Ecken
- keine Linie durch ein Element; Rückschleifen laufen außen herum, innere Schleifen innen
- Zweige bilden getrennte Bänder, dadurch möglichst keine Kreuzungen
- Beschriftungen stehen frei (Antworten an den Gateway-Ausgängen, Gateway-Frage neben der Linie)
- Pools, Lanes, aufgeklappte Teilprozesse, angeheftete Ereignisse, Datenobjekte und Anmerkungen werden mit angeordnet

`check.js` prüft dieselben Regeln und zusätzlich: Namensschema (Aufgabe = Objekt + Verb, Gateway = Frage, Ausgänge = Antworten), explizite und symmetrische Gateways, gleiche Aufgabengröße, fehlende Start-/Endereignisse und Camunda-8-Pflichtangaben (Event-Typ, Job-Typ, Bedingungen).

## So funktioniert die Live-Brücke

```
Claude ──stdio──> MCP-Server (server.js) <──WebSocket 127.0.0.1:17877── Plugin im Modeler ──> bpmn-js
```

- Der MCP-Server öffnet lokal einen WebSocket-Server. Das Plugin im Modeler verbindet sich dorthin und wiederholt das alle 3 Sekunden, falls der Server noch nicht läuft.
- Der Server lauscht nur auf `127.0.0.1`. Verbindungen von Webseiten (Origin `http://` oder `https://`) werden abgelehnt.
- Der Port ist standardmäßig `17877`. Du kannst ihn mit der Umgebungsvariable `BPMN_MCP_PORT` ändern und musst dann `PORT` am Anfang von `plugin/client.js` auf denselben Wert setzen und das Plugin neu installieren.
- Läuft der Server mehrfach (zum Beispiel in zwei Claude-Sessions), kann nur eine Instanz den Port belegen. Die anderen melden das auf stderr und bieten dann nur den Datei-Modus.

## Fehlerbehebung

**`live_status` meldet „Modeler nicht verbunden“**
- Wurde der Modeler nach der Plugin-Installation **komplett** beendet und neu gestartet?
- Liegt das Plugin im richtigen Ordner (siehe Schritt 3) und enthält `index.js` und `client.js` direkt im Ordner `bpmn-mcp-bridge`?
- Läuft der MCP-Server, also ist er im Client eingetragen und die Session neu gestartet?
- Ist der Port `17877` frei? Prüfen mit `lsof -nP -iTCP:17877` (macOS/Linux).
- Details liefert die Konsole des Modelers (F12, Reiter „Console“).

**„Kein BPMN-Diagramm im aktiven Tab“**
Der aktive Tab muss ein BPMN-Diagramm sein, kein DMN- oder Formular-Tab.

**Änderung per Datei-Tool erscheint nicht**
Der Modeler fragt nach dem Neuladen, wenn er wieder den Fokus bekommt. Für sofortige Änderungen den Live-Modus nutzen.

**`npm install` verändert Dateien außerhalb des Projekts**
Siehe Hinweis in Schritt 1: Es muss eine `package.json` im Projektordner liegen.

## Grenzen

- Nur **Camunda 8** (Zeebe-Erweiterungen).
- Datei-Modus: legt nur flache Abläufe in einem Prozess an. Pools, Lanes, Teilprozesse, Boundary-Events und Artefakte gibt es nur im Live-Modus.
- Datei-Modus: Das Layout wird bei jeder Änderung neu berechnet. Manuell verschobene Elemente gehen dabei verloren.
- `live_layout` ordnet immer das ganze Diagramm neu an. Verschachtelte Lanes (Lane in Lane) und zugeklappte Teilprozesse (eigene Zeichenebene) werden nicht angeordnet.
- Nicht enthalten: Kopieren/Einfügen, Deployment/Ausführung, DMN- und Formular-Editor.
- Die Plugin-Schnittstelle des Modelers ist laut Camunda-Doku **nicht stabil**. Nach einem Modeler-Update kann das Plugin angepasst werden müssen.

## Tests

- `npm test`: Datei-Modus plus Live-Modus gegen ein echtes bpmn-js in Headless-Chrome (braucht Google Chrome; anderer Pfad über `CHROME_PATH`). Der Camunda Modeler wird dafür nicht gebraucht.
- `node test/layout-file.mjs ein.bpmn aus.bpmn aus.png`: eine Datei neu anordnen, prüfen und als Bild rendern.
- `node test-live.js <geöffnete.bpmn>`: Live-Modus im echten Modeler. **Achtung:** Der Test ändert und speichert diese Datei. Nimm also eine Kopie.

## Projektstruktur

```
server.js            MCP-Server (Datei-Tools, Live-Tools, WebSocket-Brücke)
layout.js            Layout-Engine nach den Modellierungskonventionen
check.js             Prüfung gegen die Konventionen
model.js             Brücke zwischen BPMN-Datei und Layout/Prüfung
plugin/index.js      Plugin-Manifest für den Modeler
plugin/client.js     Plugin-Code, läuft im Modeler
install-plugin.sh    Plugin-Installation (macOS)
test.js              Test für den Datei-Modus
test-live.js         Test für den Live-Modus im echten Modeler
test/                Tests mit bpmn-js in Headless-Chrome, Render-Werkzeug
beispiel.bpmn        Beispiel-Ergebnis des Datei-Modus
```
