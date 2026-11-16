# Camunda-MCP

An MCP server that lets Claude draw and edit BPMN diagrams for **Camunda Modeler** (Camunda 8 and Camunda 7) – and generate UML class and state diagrams (domain model, object lifecycle). For Camunda 7, Claude can also deploy the models to a running process engine and walk through test runs (complete tasks, fire timers, send messages, inspect instances).

There are two ways of working with the same feature set, and they can be combined:

| Mode | What happens | Requires |
|---|---|---|
| **File mode** | Claude edits `.bpmn` files directly, without an open Modeler. If the file is open in the Modeler, the Modeler asks whether to reload it. | MCP server + Google Chrome (or Chromium/Edge) |
| **Live mode** | Claude edits the diagram **currently open** in the Modeler. Changes appear immediately, undo/redo works. | MCP server + Modeler plugin |

## Requirements

- **Camunda Modeler** (desktop) for live mode, tested with **5.52.0**. Both **Camunda 8** (Zeebe) and **Camunda 7** diagrams are supported; the platform is taken from the file header (see "Platforms").
- **Node.js** 20.10 or later, tested with Node 22, including `npm`.
- **Google Chrome**, Chromium or Microsoft Edge for file mode. The server looks for the browser in the usual places; otherwise set the `CHROME_PATH` environment variable to the executable. The browser runs invisibly in the background and is shut down after 10 minutes without calls.
- An **MCP client**, for example Claude Code or Claude Desktop.
- Operating system: tested on **macOS**. Linux and Windows should work, but the install script is macOS only (see step 3 for the manual installation).
- **No Camunda cluster needed** for modeling, checking and exporting. Only the `engine_*` tools need a running Camunda 7 engine with REST API (e.g. a Spring Boot application with `camunda-bpm-spring-boot-starter-rest`).

## Setup

### 1. Get the project and install the dependencies

Put the folder in a permanent location, because its path goes into the MCP configuration later. Then, in the project folder:

```bash
npm install
```

Important: run `npm install` **in the project folder** and make sure there is a `package.json` there. Otherwise npm keeps searching in parent folders and installs packages in the wrong place.

### 2. Test the server (optional)

```bash
node test.js
```

The script creates an example diagram in a temp folder and exercises the most important file tools. At the end it should print `BPMNShapes: 6  BPMNEdges: 5`, without any line starting with `ERROR`. More thorough: `node test/file-full.mjs` (ends with `all ok`).

### 3. Install the Modeler plugin (live mode only)

**macOS:**

```bash
./install-plugin.sh
```

**Manually (all systems):** copy the two files from `plugin/` (`index.js` and `client.js`) into a new folder `bpmn-mcp-bridge` inside your Modeler's plugin directory:

| System | Plugin folder |
|---|---|
| macOS | `~/Library/Application Support/camunda-modeler/resources/plugins/` |
| Linux | `~/.config/camunda-modeler/resources/plugins/` |
| Windows | `%APPDATA%\camunda-modeler\resources\plugins\` |

The result looks like this:

```
plugins/
  bpmn-mcp-bridge/
    index.js
    client.js
```

**Then quit Camunda Modeler completely and start it again.** Plugins are only loaded at startup. Save your diagrams first.

### 4. Register the server with Claude

**Claude Code:**

```bash
claude mcp add bpmn -- node /full/path/to/bpmn-mcp/server.js
```

**Claude Desktop or other clients** (in the client's MCP configuration file):

```json
{
  "mcpServers": {
    "bpmn": {
      "command": "node",
      "args": ["/full/path/to/bpmn-mcp/server.js"]
    }
  }
}
```

The path must be absolute. Then restart the client or session.

### 5. Try it out

Open a Camunda 8 or Camunda 7 diagram in the Modeler and ask Claude, for example:

> Check with live_status whether the Modeler is connected, then add a user task "Check application" after the start event.

For file mode:

> Create a new diagram at `/path/order.bpmn`: start, service task "Check stock", gateway "Available?", then two ends.

## Available tools

**Live mode** (acts on the active diagram in the Modeler, everything can be undone):

| Tool | Purpose |
|---|---|
| `live_status` | check the connection and the active tab (also reports an outdated plugin) |
| `live_describe` | elements and connections with IDs, type, pool/lane, event type, including the content of collapsed subprocesses (`plane`); with `geometry: true` also positions, with `ids`/`region` only a part |
| `live_add_element` | create an element (see element types), optionally connected (`after`), inside a pool/lane/subprocess (`parent`), attached (`attachTo`) |
| `live_connect` | sequence flow, message flow (between pools) or association; condition, default flow |
| `live_update_element` | name, type, event definition, job type, condition, loop/multi-instance marker, color, documentation, platform properties |
| `live_remove_element` | delete one or more elements |
| `live_arrange` | as with the mouse: move (also into another lane), size, waypoints, label, align, distribute |
| `live_batch` | many changes in one call; with `layout: true` the diagram is laid out and checked afterwards |
| `live_layout` | lay out the diagram following the modeling conventions (one undo step); `only: "messageFlows"` only reroutes the message flows, `poolOrder` sets the order of the pools |
| `live_check` | check against the conventions: layout, naming, structure, message flows, possible deadlocks, required platform properties; with `level` also the rules of the model level; plus bpmnlint with the rules of Camunda Modeler (`lint`) |
| `live_export` | save the active diagram as PDF, SVG or PNG; `plane` = one drill-down plane, `includePlanes: true` = all planes as separate files |
| `live_screenshot` | image of the diagram so Claude can look at the result itself; `ids`/`region` = enlarged crop, `plane` = drill-down plane |
| `live_undo`, `live_redo`, `live_save` | undo, redo, save |

**File mode** (parameter `file` = absolute path, every change is saved immediately):

| Tool | Purpose | Corresponds to |
|---|---|---|
| `create_diagram` | create a new file (`platform: camunda8` or `camunda7`, optionally `platformVersion` such as `"7.20.0"`); with `operations` the whole diagram is built, laid out and checked in the same call | – |
| `describe_diagram` | like `live_describe` | `live_describe` |
| `add_element`, `connect`, `update_element`, `remove_element` | same parameters as in live mode | `live_add_element` … |
| `batch` | many changes in one call; **all or nothing**: on an error the file stays unchanged | `live_batch` |
| `arrange` | manual arrangement | `live_arrange` |
| `relayout` | lay out again | `live_layout` |
| `check_diagram` | check against the conventions, optionally per model level (`level`) | `live_check` |
| `export_diagram` | export the file as PDF (one page the size of the diagram), SVG or PNG | `live_export` |
| `screenshot_diagram` | image of the file | `live_screenshot` |
| `undo`, `redo` | revert/repeat changes to the file (up to 50 steps, only within the current session) | `live_undo`, `live_redo` |

Mutating file tools lay out the diagram again afterwards and report layout problems. With `layout: false` the current arrangement is kept, for example after `arrange`.

Under the hood, file mode opens the file in an invisible bpmn-js and runs **the same plugin code** as live mode. That is why both modes share the same element types, properties and BPMN rules.

**Element types (both modes):** `startEvent`, `endEvent`, `intermediateCatchEvent`, `intermediateThrowEvent`, `boundaryEvent`, `task`, `userTask`, `serviceTask`, `scriptTask`, `businessRuleTask`, `sendTask`, `receiveTask`, `manualTask`, `callActivity`, `subProcess`, `eventSubProcess`, `transaction`, `adHocSubProcess`, `exclusiveGateway`, `parallelGateway`, `inclusiveGateway`, `eventBasedGateway`, `complexGateway`, `dataObject`, `dataStore`, `textAnnotation`, `group`, `participant` (pool, optionally with `lanes`), `lane`.

**Event definitions** (`eventDefinition`):

```json
{ "type": "timer", "timerType": "duration", "value": "P7D" }
{ "type": "timer", "timerType": "date", "value": "= startDate" }
{ "type": "message", "name": "project_assigned", "correlationKey": "= employeeId" }
{ "type": "signal" | "error" | "escalation", "name": "...", "code": "..." }
{ "type": "conditional", "value": "= x > 5" }
{ "type": "terminate" }   { "type": "compensate" }   { "type": "none" }
```

**Collapsed subprocesses** (`expanded: false`) have their own drill-down plane, as in the Modeler. Elements with `parent` = subprocess go into that plane; layout and checks handle each plane separately (findings are marked with `[Plane "…"]`), `describe` tags them with `plane`.

**Process properties** (`historyTimeToLive`, `versionTag`, `candidateStarterGroups`, `isExecutable`) are set with `update` and the ID of the process or the pool.

**Camunda 7 process engine** (REST API, default `http://localhost:8080/engine-rest`, configurable with the `CAMUNDA_URL` environment variable or per call with `engineUrl`; basic auth via `CAMUNDA_USER`/`CAMUNDA_PASSWORD`):

| Tool | Purpose |
|---|---|
| `engine_status` | Is the engine reachable? Deployed processes and DMN tables, running instances, incidents |
| `engine_deploy` | deploy `.bpmn`, `.dmn`, `.form`, `.html` (default: only changed files) |
| `engine_start_instance` | start an instance with variables and business key; shows where it waits afterwards |
| `engine_tasks` | open user tasks per instance, assignee, group or name, optionally with form fields |
| `engine_complete_task` | complete a task by ID or by business key + name, optionally as a specific user (claim) |
| `engine_execute_jobs` | run the timers and asynchronous jobs of an instance immediately (skip deadlines in a test run) |
| `engine_correlate_message` | send a message to waiting events or start an instance by message |
| `engine_instance` | state of an instance (also finished ones): waiting position, tasks, timers, external tasks, incidents, variables, history |
| `engine_incidents` | incidents with error message and the start of the stack trace; `retry: true` sets the retries back to 1 |
| `engine_rest` | any REST call for everything else |

Variables are passed as `{ name: value }`; the type follows from the value (`true` → Boolean, `5` → Long, `1.5` → Double, text → String, object → Json) or is given explicitly (`{ "value": "2026-12-01T00:00:00.000+0100", "type": "Date" }`).

A test run might then look like this:

> Deploy `business-trip.bpmn` and `approvers.dmn`, start an instance for mara to Berlin (€320), let henrik approve the budget and ole the content check, fire the timers and show me the history.

**UML** (independent of the Modeler):

| Tool | Purpose |
|---|---|
| `uml_class_diagram` | UML class diagram (domain model) from classes, attributes and relations: arranges them automatically, routes the relations at right angles, writes `.drawio` (XML), `.svg`, `.pdf`, `.png` and the description as `.uml.json`; returns a preview image and modeling hints |
| `uml_state_diagram` | UML state diagram (object lifecycle) from states and transitions, same outputs |

## Platforms: Camunda 8 and Camunda 7

The platform is stored in the file header (`modeler:executionPlatform`) and detected automatically in both modes. `create_diagram` with `platform: "camunda7"` creates a Camunda 7 file (the default is `camunda8`; the environment variable `BPMN_MCP_PLATFORM=camunda7` changes the default). In live mode the platform of the open tab applies. Properties of the other platform are rejected with a clear message.

**Camunda 8 properties** (`properties`): `assignee`, `candidateGroups`, `candidateUsers`, `dueDate`, `formId`, `retries`, `calledProcessId`, `decisionId`, `resultVariable`, `script`, `inputs`/`outputs` (`[{source, target}]`), `headers`; plus `jobType` and FEEL conditions (`= amount > 500`).

**Camunda 7 properties** (`properties`):

| Element | Properties |
|---|---|
| User task | `assignee`, `candidateGroups`, `candidateUsers`, `dueDate`, `followUpDate`, `priority`, form via `formKey` (embedded form, e.g. `embedded:app:forms/request.html`), `formRef` (Camunda Form) or `formFields` (generated form), `taskListeners` |
| Start event | `formKey` / `formRef` / `formFields`, `initiator` |
| Service, send, business rule task, throwing message event | `class` (JavaDelegate), `delegateExpression` (Spring bean), `expression` (+ `resultVariable`) or `topic` (external task) |
| Business rule task | `decisionRef`, `resultVariable`, `mapDecisionResult` |
| Script task | `scriptFormat` (default `groovy`), `script` or `resource`, `resultVariable` |
| Call activity | `calledElement` |
| Process (ID of the pool or process) | `historyTimeToLive`, `isExecutable`, `candidateStarterGroups`, `candidateStarterUsers`, `versionTag` |
| all | `asyncBefore`, `asyncAfter`, `inputs`/`outputs` (`[{name, value}]`), `executionListeners` |

In Camunda 7, conditions are expressions (`${amount > 500}`); multi-instances get `loop: { type: "parallel", collection: "receipts", elementVariable: "receipt" }` or `cardinality`. New Camunda 7 processes get `historyTimeToLive="180"`, because since 7.20 the engine rejects the deployment otherwise.

In a collaboration diagram only the process engine's pool is executable: `{ op: "add", type: "participant", name: "Process Engine", processId: "Process_Trip", executable: true, lanes: [...] }`, all other pools with `executable: false`. The technical check rules then only apply to that pool.

**Data objects:** `state: "approved"` sets the state (shown as "Name [approved]"), `collection: true` marks a list.

## Layout and conventions

`layout.js` lays out diagrams following Camunda's best practices:

- left to right, the normal flow lies on a straight line
- symmetric branches: equivalent branches above and below, gateway in the middle, lines leave via the gateway corners
- no line through an element; loops run around the outside, inner loops inside
- branches form separate bands, which avoids crossings where possible
- labels stay clear (answers at the gateway's outgoing flows, the gateway question next to the line)
- pools, lanes, expanded subprocesses, boundary events, data objects and annotations are laid out as well

**Collaboration diagrams** (several expanded pools):

- The pools are stacked so that as many message flows as possible run between neighbors (the process engine ends up between the pools it talks to). `poolOrder` overrides this.
- All pools share one column grid. Sender and receiver of a message are put into the same column where possible, so the message flow becomes a vertical line. With loops across pool borders this is not possible for every flow.
- Message flows avoid elements and labels: they leave the element at a free spot, otherwise with a short offset into a free lane, and cross pools in between only at free spots. Horizontal pieces lie on their own tracks in the gap between pools, which grows if needed.
- Events with a message flow going down get their label at the top.
- `only: "messageFlows"` (with `relayout` / `live_layout`) only reroutes the message flows. Elements, sequence flows and positions set by hand stay unchanged. Use `layout: false` for further changes after a manual correction.

In the test `test/collab-direct.mjs` (three expanded pools, 13 message flows) the aligned layout makes the message flows considerably shorter than the unaligned one and reduces the number of crossings.

`check.js` checks the same rules and additionally: naming patterns (task = verb + object, gateway = question, outgoing flows = answers), explicit and symmetric gateways, equal task size, missing start/end events, message flows (only at tasks and message events, send/receive with a flow, at most one per task), the event-based gateway, possible deadlocks (XOR split merged in parallel) and missing synchronization, as well as the required platform properties of executable processes. At the end there is a list of the constructs used.

With `level`, the recommendations of the model level are added:

| `level` | additionally checks |
|---|---|
| `strategic` | at most 10 steps, abstract tasks without type and markers, no inclusive/complex/event-based gateways, few gateways and intermediate events, one pool with lanes, data objects instead of message flows; technical properties are not required |
| `operational` | several expanded pools that exchange messages, data flow present, typed tasks in the process engine's pool; technical properties are not required |
| `technical` | at least one executable process, all required platform properties |

The German level names `strategisch`, `operativ` and `technisch` from earlier versions are still accepted.

## UML diagrams

`uml.js` generates diagrams from a description, without the Modeler and without any other programs:

```json
{
  "file": "/path/domain-model",
  "title": "Domain model",
  "classes": [
    { "name": "Reader", "attributes": ["cardNumber: Text"] },
    { "name": "Loan", "attributes": ["loanedOn: Date"] }
  ],
  "relations": [
    { "from": "Reader", "to": "Loan", "name": "makes", "fromMult": "1", "toMult": "0..*" }
  ]
}
```

- Relation types: `association`, `aggregation`, `composition` (`from` is the whole), `generalization` (`from` is the subclass), `dependency`; plus `fromRole`/`toRole` and `navigable`.
- The classes are arranged in a grid so that relations stay short, cross little and subclasses sit below their superclass. `col`/`row` on a class pin its cell.
- Written files: `<file>.drawio` (editable in diagrams.net), `.svg`, `.pdf`, `.png` and `.uml.json` (the description; adjust it and call the tool again to make changes).
- Hints following the rules for domain models: no methods, attributes with a type, no classes as attribute types, associations named and with multiplicities, no unconnected classes.

`uml_state_diagram` takes `states`, `initial`, `finals` and `transitions` (`from`, `to`, `label`) and uses the same layout engine as the BPMN diagrams.

## How the live bridge works

```
Claude ──stdio──> MCP server (server.js) <──WebSocket 127.0.0.1:17877── plugin in the Modeler ──> bpmn-js
```

- The MCP server opens a local WebSocket server. The plugin in the Modeler connects to it and retries every 3 seconds if the server is not running yet.
- The server only listens on `127.0.0.1`. Connections from web pages (origin `http://` or `https://`) are rejected.
- The default port is `17877`. You can change it with the `BPMN_MCP_PORT` environment variable; then also set `PORT` at the top of `plugin/client.js` to the same value and reinstall the plugin.
- If the server runs several times (for example in two Claude sessions), only one instance can take the port. The others report this on stderr and then only offer file mode.

## Troubleshooting

**`live_status` reports "Camunda Modeler is not connected"**
- Did you quit the Modeler **completely** after installing the plugin and start it again?
- Is the plugin in the right folder (see step 3), with `index.js` and `client.js` directly inside `bpmn-mcp-bridge`?
- Is the MCP server running, i.e. registered in the client and the session restarted?
- Is port `17877` free? Check with `lsof -nP -iTCP:17877` (macOS/Linux).
- The Modeler's console has details (F12, "Console" tab).

**`live_status` warns that the plugin is outdated**
Run `./install-plugin.sh` (or copy the plugin files again) and restart the Modeler.

**"No BPMN diagram in the active tab"**
The active tab must be a BPMN diagram, not a DMN or form tab.

**A change made with a file tool does not show up**
The Modeler asks about reloading when it gets the focus again. Use live mode for immediate changes.

**File mode reports "needs Google Chrome, Chromium or Edge"**
Install a browser or set `CHROME_PATH`, for example in the MCP configuration: `claude mcp add bpmn -e CHROME_PATH=/path/to/chrome -- node /full/path/to/bpmn-mcp/server.js`.

**`npm install` changes files outside the project**
See the note in step 1: there must be a `package.json` in the project folder.

## Limitations

- The `engine_*` tools only talk to the Camunda 7 REST API (no Camunda 8/Zeebe clusters).
- Camunda 7 and 8 cannot be mixed in one file. The server does not create DMN tables, forms (`.form`, HTML) or Java classes; it only adds the references to them.
- UML: class and state diagrams. The `.drawio` file has only been checked for its structure, not opened in diagrams.net; SVG/PDF/PNG are authoritative for the look.
- The deadlock check is a heuristic based on the nearest common split point. It does not replace simulating the token flow.
- File mode: undo/redo only covers changes of the current session. If the file is changed elsewhere in between, the history starts over.
- File mode: the first call takes one or two seconds because the browser starts.
- Without `only: "messageFlows"`, `live_layout` always lays out the whole diagram; single elements cannot be pinned. Elements in expanded subprocesses are laid out inside the subprocess and not aligned column by column with their message partners. Nested lanes (lane in lane) are not laid out. Collapsed subprocesses are laid out in their own drill-down plane.
- Not included: copy/paste, DMN and form editors, deployment to Camunda 8.
- According to the Camunda docs, the Modeler's plugin API is **not stable**. The plugin may need adjustments after a Modeler update.

## Tests

- `npm test`: file mode (`test.js`, `test/file-full.mjs`), live mode against a real bpmn-js in headless Chrome, Camunda 7 (`test/c7-direct.mjs`, `test/c7-file.mjs`), collaboration layout (`test/collab-direct.mjs`), UML (`test/uml.mjs`), drill-down planes, bpmnlint, cropped screenshots and other features (`test/project-fixes.mjs`) and the engine tools against a mocked REST API (`test/engine-mock.mjs`). Needs Google Chrome (other path via `CHROME_PATH`), but no Camunda Modeler.
- Tests that take `[output-prefix]` or `[output-folder]` as an argument write their results (BPMN, PNG, PDF) there for inspection.
- `node test/layout-file.mjs in.bpmn out.bpmn out.png`: re-lay out a file, check it and render it as an image.
- `node test-live.js <open.bpmn>`: live mode in the real Modeler. **Caution:** the test changes and saves this file, so use a copy of `example.bpmn`.

## Project structure

```
server.js            MCP server (live tools, file tools, WebSocket bridge)
headless.js          file mode: invisible bpmn-js with the plugin code, undo history
layout.js            layout engine following the modeling conventions
check.js             checks against the conventions, model levels, required platform properties
lint.js              bpmnlint with the rules of Camunda Modeler (camunda-compat per platform/version)
engine.js            Camunda 7 REST client for the engine_* tools
uml.js               UML class and state diagrams (SVG and draw.io XML)
model.js             bridge between bpmn-moddle and layout/check (for test/layout-file.mjs)
plugin/index.js      plugin manifest for the Modeler
plugin/client.js     plugin code, runs in the Modeler and in file mode
install-plugin.sh    plugin installation (macOS)
test.js              test for file mode
test-live.js         test for live mode in the real Modeler
test/                tests with bpmn-js in headless Chrome, render tool
example.bpmn         example diagram
```
