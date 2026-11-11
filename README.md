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

**Datei-Modus** (Parameter `file` = absoluter Pfad):

| Tool | Zweck |
|---|---|
| `create_diagram` | neue, leere `.bpmn`-Datei anlegen |
| `describe_diagram` | Elemente und Verbindungen mit IDs auflisten |
| `add_element` | Element hinzufügen, optional direkt mit Verbindung (`after`) |
| `connect` | zwei Elemente verbinden, optional mit FEEL-Bedingung |
| `update_element` | Name, Job-Typ (Service Task) oder Bedingung ändern |
| `remove_element` | Element samt Verbindungen löschen |
| `relayout` | Layout komplett neu berechnen |

**Live-Modus** (wirkt auf das im Modeler aktive Diagramm):

`live_status`, `live_describe`, `live_add_element`, `live_connect`, `live_update_element`, `live_remove_element`, `live_undo`, `live_save`

Unterstützte Elementtypen: `startEvent`, `endEvent`, `task`, `userTask`, `serviceTask`, `scriptTask`, `businessRuleTask`, `sendTask`, `receiveTask`, `callActivity`, `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `intermediateCatchEvent`, `intermediateThrowEvent`.

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

- Nur **Camunda 8** (Zeebe-Erweiterungen). Der Job-Typ lässt sich nur bei Service Tasks setzen.
- Datei-Modus: ein Prozess pro Datei, keine Subprozesse, Pools/Lanes, Boundary-Events oder Message-/Timer-Definitionen.
- Datei-Modus: Das Layout wird bei jeder Änderung automatisch neu berechnet. Manuell verschobene Elemente gehen dabei verloren.
- Live-Modus: Die automatische Platzierung kann sich überlappen. Ein Aufräumen von Hand ist manchmal nötig.
- Die Plugin-Schnittstelle des Modelers ist laut Camunda-Doku **nicht stabil**. Nach einem Modeler-Update kann das Plugin angepasst werden müssen.

## Tests

- `node test.js`: Datei-Modus.
- `node test-live.js <geöffnete.bpmn>`: Live-Modus. Der Modeler muss mit installiertem Plugin laufen und die angegebene Datei geöffnet haben. **Achtung:** Der Test ändert und speichert diese Datei. Nimm also eine Kopie.

## Projektstruktur

```
server.js            MCP-Server (Datei-Tools, Live-Tools, WebSocket-Brücke)
plugin/index.js      Plugin-Manifest für den Modeler
plugin/client.js     Plugin-Code, läuft im Modeler
install-plugin.sh    Plugin-Installation (macOS)
test.js              Test für den Datei-Modus
test-live.js         Test für den Live-Modus
beispiel.bpmn        Beispiel-Ergebnis des Datei-Modus
```
