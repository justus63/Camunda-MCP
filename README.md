# bpmn-mcp

Ein MCP-Server, mit dem Claude BPMN-Diagramme für den **Camunda Modeler** (Camunda 8 und Camunda 7) zeichnen und bearbeiten kann – und dazu UML-Klassen- und Zustandsdiagramme (Domänenmodell, Objektlebenszyklus) erzeugt. Für Camunda 7 kann Claude die Modelle außerdem auf einer laufenden Process Engine deployen und Testläufe durchspielen (Aufgaben erledigen, Timer auslösen, Nachrichten senden, Instanzen ansehen).

Es gibt zwei Arbeitsweisen mit demselben Funktionsumfang, die sich kombinieren lassen:

| Modus | Was passiert | Braucht |
|---|---|---|
| **Datei-Modus** | Claude bearbeitet `.bpmn`-Dateien direkt, ohne geöffneten Modeler. Ist die Datei im Modeler offen, fragt er anschließend, ob er sie neu laden soll. | MCP-Server + Google Chrome (oder Chromium/Edge) |
| **Live-Modus** | Claude bearbeitet das im Modeler **gerade geöffnete** Diagramm. Änderungen erscheinen sofort, Undo/Redo funktioniert. | MCP-Server + Modeler-Plugin |

## Voraussetzungen

- **Camunda Modeler** (Desktop) für den Live-Modus, getestet mit **5.52.0**. Unterstützt werden **Camunda-8-** (Zeebe) und **Camunda-7-Diagramme**; welche Plattform gilt, steht im Dateikopf (siehe „Plattformen“).
- **Node.js** ab Version 20.10, getestet mit Node 22, inklusive `npm`.
- **Google Chrome**, Chromium oder Microsoft Edge für den Datei-Modus. Der Server findet den Browser an den üblichen Orten; sonst die Umgebungsvariable `CHROME_PATH` auf die Programmdatei setzen. Der Browser läuft unsichtbar im Hintergrund und wird nach 10 Minuten ohne Aufruf beendet.
- Ein **MCP-fähiger Client**, zum Beispiel Claude Code oder Claude Desktop.
- Betriebssystem: getestet auf **macOS**. Linux und Windows sollten funktionieren, das Installationsskript ist aber nur für macOS (siehe Schritt 3 für die manuelle Installation).
- **Kein Camunda-Cluster nötig** für Modellieren, Prüfen und Exportieren. Nur die `engine_*`-Tools brauchen eine laufende Camunda-7-Engine mit REST-API (z. B. eine Spring-Boot-Anwendung mit `camunda-bpm-spring-boot-starter-rest`).

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

Das Skript legt ein Beispieldiagramm in einem Temp-Ordner an und prüft die wichtigsten Datei-Tools. Am Ende sollte `BPMNShapes: 6  BPMNEdges: 5` stehen, ohne eine Zeile mit `FEHLER`. Ausführlicher: `node test/file-full.mjs` (endet mit `alles ok`).

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

Öffne im Modeler ein Camunda-8- oder Camunda-7-Diagramm und frage Claude zum Beispiel:

> Prüf mit live_status, ob der Modeler verbunden ist, und füge nach dem Start-Event einen User Task „Antrag prüfen“ ein.

Für den Datei-Modus:

> Lege unter `/pfad/bestellung.bpmn` ein neues Diagramm an: Start, Service Task „Bestand prüfen“, Gateway „Verfügbar?“, danach zwei Enden.

## Verfügbare Tools

**Live-Modus** (wirkt auf das im Modeler aktive Diagramm, alles per Undo rückgängig zu machen):

| Tool | Zweck |
|---|---|
| `live_status` | Verbindung und aktiven Tab prüfen (meldet auch ein veraltetes Plugin) |
| `live_describe` | Elemente und Verbindungen mit IDs, Typ, Pool/Lane, Event-Typ, auch den Inhalt zugeklappter Teilprozesse (`plane`); mit `geometry: true` auch Positionen, mit `ids`/`region` nur einen Teil |
| `live_add_element` | Element anlegen (siehe Elementtypen), optional verbunden (`after`), in Pool/Lane/Teilprozess (`parent`), angeheftet (`attachTo`) |
| `live_connect` | Sequenzfluss, Nachrichtenfluss (zwischen Pools) oder Assoziation; Bedingung, Standardfluss |
| `live_update_element` | Name, Typ, Event-Definition, Job-Typ, Bedingung, Schleifen-/Multi-Instanz-Markierung, Farbe, Dokumentation, Camunda-8-Eigenschaften |
| `live_remove_element` | ein oder mehrere Elemente löschen |
| `live_arrange` | wie mit der Maus: verschieben (auch in andere Lane), Größe, Wegpunkte, Beschriftung, ausrichten, verteilen |
| `live_batch` | viele Änderungen in einem Aufruf; mit `layout: true` danach automatisch anordnen und prüfen |
| `live_layout` | Diagramm nach den Modellierungskonventionen anordnen (ein Undo-Schritt); `only: "messageFlows"` verlegt nur die Nachrichtenflüsse neu, `poolOrder` legt die Pool-Reihenfolge fest |
| `live_check` | Prüfung gegen die Konventionen: Darstellung, Benennung, Struktur, Nachrichtenflüsse, mögliche Deadlocks, Pflichtangaben der Plattform; mit `level` zusätzlich die Regeln der Modellebene; dazu bpmnlint mit den Regeln des Camunda Modelers (`lint`) |
| `live_export` | aktives Diagramm als PDF, SVG oder PNG speichern; `plane` = eine Drill-down-Ebene, `includePlanes: true` = alle Ebenen als eigene Dateien |
| `live_screenshot` | Bild des Diagramms, damit Claude das Ergebnis selbst ansehen kann; `ids`/`region` = vergrößerter Ausschnitt, `plane` = Drill-down-Ebene |
| `live_undo`, `live_redo`, `live_save` | rückgängig, wiederherstellen, speichern |

**Datei-Modus** (Parameter `file` = absoluter Pfad, jede Änderung wird sofort gespeichert):

| Tool | Zweck | entspricht |
|---|---|---|
| `create_diagram` | neue Datei anlegen (`platform: camunda8` oder `camunda7`, optional `platformVersion` wie `"7.20.0"`); mit `operations` wird das ganze Diagramm im selben Aufruf gebaut, angeordnet und geprüft | – |
| `describe_diagram` | wie `live_describe` | `live_describe` |
| `add_element`, `connect`, `update_element`, `remove_element` | dieselben Parameter wie im Live-Modus | `live_add_element` … |
| `batch` | viele Änderungen in einem Aufruf; **alles oder nichts**: bei einem Fehler bleibt die Datei unverändert | `live_batch` |
| `arrange` | manuell anordnen | `live_arrange` |
| `relayout` | neu anordnen | `live_layout` |
| `check_diagram` | Prüfung gegen die Konventionen, optional je Modellebene (`level`) | `live_check` |
| `export_diagram` | Datei als PDF (eine Seite in Diagrammgröße), SVG oder PNG exportieren | `live_export` |
| `screenshot_diagram` | Bild der Datei | `live_screenshot` |
| `undo`, `redo` | Änderungen an der Datei zurücknehmen/wiederholen (bis zu 50 Schritte, nur innerhalb der laufenden Sitzung) | `live_undo`, `live_redo` |

Ändernde Datei-Tools ordnen danach automatisch neu an und melden Darstellungsprobleme. Mit `layout: false` bleibt die bisherige Anordnung, zum Beispiel nach `arrange`.

Technisch öffnet der Datei-Modus die Datei in einem unsichtbaren bpmn-js und führt dort **denselben Plugin-Code** aus wie der Live-Modus. Deshalb gelten in beiden Modi dieselben Elementtypen, Eigenschaften und BPMN-Regeln.

**Elementtypen (beide Modi):** `startEvent`, `endEvent`, `intermediateCatchEvent`, `intermediateThrowEvent`, `boundaryEvent`, `task`, `userTask`, `serviceTask`, `scriptTask`, `businessRuleTask`, `sendTask`, `receiveTask`, `manualTask`, `callActivity`, `subProcess`, `eventSubProcess`, `transaction`, `adHocSubProcess`, `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`, `complexGateway`, `dataObject`, `dataStore`, `textAnnotation`, `group`, `participant` (Pool, optional mit `lanes`), `lane`.

**Event-Definitionen** (`eventDefinition`):

```json
{ "type": "timer", "timerType": "duration", "value": "P7D" }
{ "type": "timer", "timerType": "date", "value": "= startDatum" }
{ "type": "message", "name": "projekt_zugewiesen", "correlationKey": "= mitarbeiterId" }
{ "type": "signal" | "error" | "escalation", "name": "...", "code": "..." }
{ "type": "conditional", "value": "= x > 5" }
{ "type": "terminate" }   { "type": "compensate" }   { "type": "none" }
```

**Zugeklappte Teilprozesse** (`expanded: false`) haben wie im Modeler eine eigene Drill-down-Ebene. Elemente mit `parent` = Teilprozess landen in dieser Ebene; Layout und Prüfung behandeln jede Ebene einzeln (Meldungen sind mit `[Ebene „…“]` markiert), `describe` kennzeichnet sie mit `plane`.

**Prozess-Eigenschaften** (`historyTimeToLive`, `versionTag`, `candidateStarterGroups`, `isExecutable`) setzt `update` mit der ID des Prozesses oder des Pools.

**Camunda 7 Process Engine** (REST-API, Standard `http://localhost:8080/engine-rest`, änderbar mit der Umgebungsvariable `CAMUNDA_URL` oder je Aufruf mit `engineUrl`; Basic Auth über `CAMUNDA_USER`/`CAMUNDA_PASSWORD`):

| Tool | Zweck |
|---|---|
| `engine_status` | Engine erreichbar? Deployte Prozesse und DMN-Tabellen, laufende Instanzen, Incidents |
| `engine_deploy` | `.bpmn`, `.dmn`, `.form`, `.html` deployen (Standard: nur Geänderte) |
| `engine_start_instance` | Instanz mit Variablen und Business Key starten; zeigt, wo sie danach wartet |
| `engine_tasks` | offene User Tasks je Instanz, Bearbeiter, Gruppe oder Name, optional mit Formularfeldern |
| `engine_complete_task` | Aufgabe per ID oder per Business Key + Name erledigen, optional als bestimmter Benutzer (claim) |
| `engine_execute_jobs` | Timer und asynchrone Jobs einer Instanz sofort ausführen (Fristen im Testlauf überspringen) |
| `engine_correlate_message` | Nachricht an wartende Ereignisse senden oder Instanz per Nachricht starten |
| `engine_instance` | Zustand einer (auch beendeten) Instanz: Warteposition, Aufgaben, Timer, External Tasks, Incidents, Variablen, Verlauf |
| `engine_incidents` | Incidents mit Fehlermeldung und Stacktrace-Anfang; `retry: true` setzt die Retries wieder auf 1 |
| `engine_rest` | beliebiger REST-Aufruf für alles andere |

Variablen werden als `{ name: wert }` übergeben; der Typ ergibt sich aus dem Wert (`true` → Boolean, `5` → Long, `1.5` → Double, Text → String, Objekt → Json) oder wird explizit angegeben (`{ "value": "2026-12-01T00:00:00.000+0100", "type": "Date" }`).

Ein Testlauf sieht dann zum Beispiel so aus:

> Deploy `dienstreise.bpmn` und `genehmigungsstellen.dmn`, starte eine Instanz für mara nach Berlin (320 €), lass henrik das Budget und ole die fachliche Prüfung genehmigen, löse die Timer aus und zeig mir den Verlauf.

**UML** (unabhängig vom Modeler):

| Tool | Zweck |
|---|---|
| `uml_class_diagram` | UML-Klassendiagramm (Domänenmodell) aus Klassen, Attributen und Beziehungen: ordnet automatisch an, verlegt die Beziehungen rechtwinklig, schreibt `.drawio` (XML), `.svg`, `.pdf`, `.png` und die Beschreibung als `.uml.json`; liefert ein Vorschaubild und fachliche Hinweise |
| `uml_state_diagram` | UML-Zustandsdiagramm (Objektlebenszyklus) aus Zuständen und Übergängen, gleiche Ausgaben |

## Plattformen: Camunda 8 und Camunda 7

Die Plattform steht im Dateikopf (`modeler:executionPlatform`) und wird in beiden Modi automatisch erkannt. `create_diagram` legt mit `platform: "camunda7"` eine Camunda-7-Datei an (Standard ist `camunda8`; die Umgebungsvariable `BPMN_MCP_PLATFORM=camunda7` ändert den Standard). Im Live-Modus gilt die Plattform des geöffneten Tabs. Eigenschaften der jeweils anderen Plattform werden mit einer klaren Meldung abgelehnt.

**Camunda-8-Eigenschaften** (`properties`): `assignee`, `candidateGroups`, `candidateUsers`, `dueDate`, `formId`, `retries`, `calledProcessId`, `decisionId`, `resultVariable`, `script`, `inputs`/`outputs` (`[{source, target}]`), `headers`; dazu `jobType` und FEEL-Bedingungen (`= betrag > 500`).

**Camunda-7-Eigenschaften** (`properties`):

| Element | Eigenschaften |
|---|---|
| User Task | `assignee`, `candidateGroups`, `candidateUsers`, `dueDate`, `followUpDate`, `priority`, Formular über `formKey` (Embedded Form, z. B. `embedded:app:forms/antrag.html`), `formRef` (Camunda Form) oder `formFields` (Generated Form), `taskListeners` |
| Startereignis | `formKey` / `formRef` / `formFields`, `initiator` |
| Service-, Send-, Business-Rule-Task, auslösendes Nachrichtenereignis | `class` (JavaDelegate), `delegateExpression` (Spring Bean), `expression` (+ `resultVariable`) oder `topic` (External Task) |
| Business Rule Task | `decisionRef`, `resultVariable`, `mapDecisionResult` |
| Script Task | `scriptFormat` (Standard `groovy`), `script` oder `resource`, `resultVariable` |
| Call Activity | `calledElement` |
| Prozess (ID des Pools oder Prozesses) | `historyTimeToLive`, `isExecutable`, `candidateStarterGroups`, `candidateStarterUsers`, `versionTag` |
| alle | `asyncBefore`, `asyncAfter`, `inputs`/`outputs` (`[{name, value}]`), `executionListeners` |

Bedingungen stehen in Camunda 7 als Expression (`${betrag > 500}`), Mehrfachinstanzen bekommen `loop: { type: "parallel", collection: "belege", elementVariable: "beleg" }` oder `cardinality`. Neue Camunda-7-Prozesse erhalten `historyTimeToLive="180"`, weil die Engine das Deployment seit 7.20 sonst ablehnt.

Im Kollaborationsdiagramm ist nur der Pool der Process Engine ausführbar: `{ op: "add", type: "participant", name: "Process Engine", processId: "Process_Reise", executable: true, lanes: [...] }`, die übrigen Pools mit `executable: false`. Die technischen Prüfregeln gelten dann nur für diesen Pool.

**Datenobjekte:** `state: "genehmigt"` setzt den Zustand (sichtbar als „Name [genehmigt]“), `collection: true` markiert eine Liste.

## Layout und Konventionen

`layout.js` ordnet Diagramme nach den Camunda-Best-Practices an (Grundlage: Vorlesung Business Engineering, „Modellierungskonventionen“):

- von links nach rechts, der Normalablauf liegt auf einer geraden Linie
- Verzweigungen symmetrisch: gleichwertige Zweige ober- und unterhalb, Gateway mittig, Linien über die Gateway-Ecken
- keine Linie durch ein Element; Rückschleifen laufen außen herum, innere Schleifen innen
- Zweige bilden getrennte Bänder, dadurch möglichst keine Kreuzungen
- Beschriftungen stehen frei (Antworten an den Gateway-Ausgängen, Gateway-Frage neben der Linie)
- Pools, Lanes, aufgeklappte Teilprozesse, angeheftete Ereignisse, Datenobjekte und Anmerkungen werden mit angeordnet

**Kollaborationsdiagramme** (mehrere ausmodellierte Pools):

- Die Pools werden so gestapelt, dass möglichst viele Nachrichtenflüsse zwischen Nachbarn laufen (die Process Engine landet zwischen den Pools, mit denen sie spricht). `poolOrder` überstimmt das.
- Alle Pools teilen sich ein Spaltenraster. Sender und Empfänger einer Nachricht kommen nach Möglichkeit in dieselbe Spalte, der Nachrichtenfluss wird dann eine senkrechte Linie. Bei Schleifen über Poolgrenzen ist das nicht für jeden Fluss möglich.
- Nachrichtenflüsse weichen Elementen und Beschriftungen aus: an einer freien Stelle des Elements heraus, sonst mit einem kurzen Versatz in eine freie Gasse, durch dazwischenliegende Pools nur an freien Stellen. Waagerechte Stücke liegen auf eigenen Spuren im Zwischenraum, der dafür bei Bedarf wächst.
- Ereignisse mit einem Nachrichtenfluss nach unten bekommen ihre Beschriftung nach oben.
- `only: "messageFlows"` (bei `relayout` / `live_layout`) verlegt nur die Nachrichtenflüsse neu. Elemente, Sequenzflüsse und von Hand gesetzte Positionen bleiben unverändert. Für weitere Änderungen nach einer manuellen Korrektur `layout: false` verwenden.

Im Test `test/collab-direct.mjs` (drei ausmodellierte Pools, 13 Nachrichtenflüsse) sinkt die Gesamtlänge der Nachrichtenflüsse gegenüber der unausgerichteten Anordnung von rund 10.500 auf 6.300 px und die Zahl der Kreuzungen von 37 auf 22.

`check.js` prüft dieselben Regeln und zusätzlich: Namensschema (Aufgabe = Objekt + Verb, Gateway = Frage, Ausgänge = Antworten), explizite und symmetrische Gateways, gleiche Aufgabengröße, fehlende Start-/Endereignisse, Nachrichtenflüsse (nur an Tasks und Nachrichtenereignissen, Send/Receive mit Fluss, höchstens einer je Task), das ereignisbasierte Gateway, mögliche Deadlocks (XOR-Verzweigung, die parallel zusammengeführt wird) und fehlende Synchronisation sowie die Pflichtangaben der Plattform für ausführbare Prozesse. Am Ende steht eine Liste der verwendeten Konstrukte.

Mit `level` kommen die Empfehlungen der Modellebene dazu:

| `level` | prüft zusätzlich |
|---|---|
| `strategisch` | höchstens 10 Schritte, abstrakte Tasks ohne Typ und Marker, keine inklusiven/komplexen/ereignisbasierten Gateways, wenige Gateways und Zwischenereignisse, ein Pool mit Lanes, Datenobjekte statt Nachrichtenflüssen; technische Angaben werden nicht verlangt |
| `operativ` | mehrere ausmodellierte Pools mit Nachrichtenaustausch, Datenfluss vorhanden, typisierte Tasks im Pool der Process Engine; technische Angaben werden nicht verlangt |
| `technisch` | mindestens ein ausführbarer Prozess, alle Pflichtangaben der Plattform |

## UML-Diagramme

`uml.js` erzeugt Diagramme aus einer Beschreibung, ohne Modeler und ohne weitere Programme:

```json
{
  "file": "/pfad/domaenenmodell",
  "title": "Domänenmodell",
  "classes": [
    { "name": "Leser", "attributes": ["ausweisnummer: Text"] },
    { "name": "Ausleihe", "attributes": ["ausgeliehenAm: Datum"] }
  ],
  "relations": [
    { "from": "Leser", "to": "Ausleihe", "name": "tätigt", "fromMult": "1", "toMult": "0..*" }
  ]
}
```

- Beziehungstypen: `association`, `aggregation`, `composition` (`from` ist das Ganze), `generalization` (`from` ist die Unterklasse), `dependency`; dazu `fromRole`/`toRole` und `navigable`.
- Die Klassen werden in einem Raster so angeordnet, dass Beziehungen kurz bleiben, sich wenig kreuzen und Unterklassen unter ihrer Oberklasse stehen. `col`/`row` an einer Klasse legen ihre Zelle fest.
- Geschrieben werden `<file>.drawio` (in diagrams.net weiterbearbeitbar), `.svg`, `.pdf`, `.png` und `.uml.json` (die Beschreibung; zum Ändern anpassen und das Tool erneut aufrufen).
- Hinweise nach den Regeln für Domänenmodelle: keine Methoden, Attribute mit Typ, Klassen nicht als Attributtyp, Assoziationen benannt und mit Kardinalitäten, keine unverbundenen Klassen.

`uml_state_diagram` nimmt `states`, `initial`, `finals` und `transitions` (`from`, `to`, `label`) und nutzt für die Anordnung dieselbe Layout-Engine wie die BPMN-Diagramme.

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

**Datei-Modus meldet „braucht Google Chrome, Chromium oder Edge“**
Browser installieren oder `CHROME_PATH` setzen, zum Beispiel in der MCP-Konfiguration: `claude mcp add bpmn -e CHROME_PATH=/pfad/zu/chrome -- node /voller/pfad/zu/bpmn-mcp/server.js`.

**`npm install` verändert Dateien außerhalb des Projekts**
Siehe Hinweis in Schritt 1: Es muss eine `package.json` im Projektordner liegen.

## Grenzen

- Die `engine_*`-Tools sprechen nur die Camunda-7-REST-API an (keine Camunda-8-/Zeebe-Cluster).
- Camunda 7 und 8 lassen sich nicht in einer Datei mischen. DMN-Tabellen, Formulare (`.form`, HTML) und Java-Klassen legt der Server nicht an; er trägt nur die Verweise darauf ein.
- UML: Klassen- und Zustandsdiagramme. Die `.drawio`-Datei wurde nicht in diagrams.net geöffnet geprüft, sondern nur auf ihren Aufbau; maßgeblich für das Aussehen sind SVG/PDF/PNG.
- Die Deadlock-Prüfung ist eine Heuristik über den nächsten gemeinsamen Verzweigungspunkt. Sie ersetzt kein Durchspielen des Tokenflusses.
- Datei-Modus: Undo/Redo gilt nur für Änderungen der laufenden Sitzung. Wird die Datei zwischendurch außerhalb geändert, beginnt der Verlauf neu.
- Datei-Modus: Der erste Aufruf dauert ein bis zwei Sekunden, weil der Browser startet.
- `live_layout` ordnet ohne `only: "messageFlows"` immer das ganze Diagramm neu an; einzelne Elemente lassen sich nicht festhalten. Elemente in aufgeklappten Teilprozessen werden innerhalb des Teilprozesses angeordnet und nicht spaltengenau an Nachrichtenpartnern ausgerichtet. Verschachtelte Lanes (Lane in Lane) werden nicht angeordnet. Zugeklappte Teilprozesse werden in ihrer eigenen Drill-down-Ebene angeordnet.
- Nicht enthalten: Kopieren/Einfügen, DMN- und Formular-Editor, Deployment auf Camunda 8.
- Die Plugin-Schnittstelle des Modelers ist laut Camunda-Doku **nicht stabil**. Nach einem Modeler-Update kann das Plugin angepasst werden müssen.

## Tests

- `npm test`: Datei-Modus (`test.js`, `test/file-full.mjs`), Live-Modus gegen ein echtes bpmn-js in Headless-Chrome, Camunda 7 (`test/c7-direct.mjs`, `test/c7-file.mjs`), Kollaborations-Layout (`test/collab-direct.mjs`), UML (`test/uml.mjs`), Drill-down-Ebenen, bpmnlint und weitere Verbesserungen aus dem Dienstreise-Projekt (`test/projekt-fixes.mjs`) sowie die Engine-Tools gegen eine nachgebildete REST-API (`test/engine-mock.mjs`). Braucht Google Chrome (anderer Pfad über `CHROME_PATH`), aber keinen Camunda Modeler.
- Die Tests mit `[ausgabe-präfix]` bzw. `[ausgabe-ordner]` als Argument schreiben ihre Ergebnisse (BPMN, PNG, PDF) zum Ansehen dorthin.
- `node test/layout-file.mjs ein.bpmn aus.bpmn aus.png`: eine Datei neu anordnen, prüfen und als Bild rendern.
- `node test-live.js <geöffnete.bpmn>`: Live-Modus im echten Modeler. **Achtung:** Der Test ändert und speichert diese Datei. Nimm also eine Kopie.

## Projektstruktur

```
server.js            MCP-Server (Live-Tools, Datei-Tools, WebSocket-Brücke)
headless.js          Datei-Modus: unsichtbares bpmn-js mit dem Plugin-Code, Undo-Verlauf
layout.js            Layout-Engine nach den Modellierungskonventionen
check.js             Prüfung gegen die Konventionen, Modellebenen, Plattform-Pflichtangaben
lint.js              bpmnlint mit den Regeln des Camunda Modelers (camunda-compat je Plattform/Version)
engine.js            Camunda-7-REST-Client für die engine_*-Tools
uml.js               UML-Klassen- und Zustandsdiagramme (SVG und draw.io-XML)
model.js             Brücke zwischen bpmn-moddle und Layout/Prüfung (für test/layout-file.mjs)
plugin/index.js      Plugin-Manifest für den Modeler
plugin/client.js     Plugin-Code, läuft im Modeler und im Datei-Modus
install-plugin.sh    Plugin-Installation (macOS)
test.js              Test für den Datei-Modus
test-live.js         Test für den Live-Modus im echten Modeler
test/                Tests mit bpmn-js in Headless-Chrome, Render-Werkzeug
beispiel.bpmn        Beispieldiagramm
```
