/* Läuft im Renderer des Camunda Modelers (kein Node, kein Bundler nötig).
 * - fängt über ein bpmn-js-Modul die Modeler-Instanzen aller Tabs ab
 * - verbindet sich per WebSocket mit dem MCP-Server (ws://127.0.0.1:PORT)
 * - führt dessen Befehle über bpmn-js "modeling" aus, d. h. mit Undo/Redo
 */
(function () {
  var PORT = 17877;
  var URL = 'ws://127.0.0.1:' + PORT;

  window.plugins = window.plugins || [];

  var injectors = [];
  var activeTab = null;
  var api = { triggerAction: null };

  // ---------- Instanzen sammeln ----------
  function Capture(injector, eventBus) {
    injectors.push(injector);
    eventBus.on('diagram.destroy', function () {
      injectors = injectors.filter(function (i) { return i !== injector; });
    });
  }
  Capture.$inject = ['injector', 'eventBus'];

  window.plugins.push({
    type: 'bpmn.modeler.additionalModules',
    plugin: { __init__: ['mcpBridgeCapture'], mcpBridgeCapture: ['type', Capture] },
  });

  // ---------- Client-Plugin (liefert subscribe/triggerAction) ----------
  function Bridge(props) {
    if (!api.triggerAction) {
      api.triggerAction = props.triggerAction;
      props.subscribe('app.activeTabChanged', function (e) { activeTab = e.activeTab; });
      start();
    }
    return null;
  }
  window.plugins.push({ type: 'client', plugin: Bridge });

  // ---------- aktive Instanz ----------
  function visible(injector) {
    try {
      var el = injector.get('canvas').getContainer();
      return el.isConnected && el.getClientRects().length > 0;
    } catch (e) { return false; }
  }
  function active() {
    var live = injectors.filter(visible);
    return live[live.length - 1] || null;
  }
  function need() {
    var inj = active();
    if (!inj) throw new Error('Kein BPMN-Diagramm im aktiven Tab (oder Tab ist kein BPMN).');
    return inj;
  }

  // ---------- Befehle ----------
  var TYPES = {
    startEvent: 'bpmn:StartEvent', endEvent: 'bpmn:EndEvent', task: 'bpmn:Task',
    userTask: 'bpmn:UserTask', serviceTask: 'bpmn:ServiceTask', scriptTask: 'bpmn:ScriptTask',
    businessRuleTask: 'bpmn:BusinessRuleTask', sendTask: 'bpmn:SendTask',
    receiveTask: 'bpmn:ReceiveTask', callActivity: 'bpmn:CallActivity',
    exclusiveGateway: 'bpmn:ExclusiveGateway', parallelGateway: 'bpmn:ParallelGateway',
    inclusiveGateway: 'bpmn:InclusiveGateway',
    intermediateCatchEvent: 'bpmn:IntermediateCatchEvent',
    intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
  };

  function el(inj, id) {
    var e = inj.get('elementRegistry').get(id);
    if (!e) throw new Error('Element nicht gefunden: ' + id);
    return e;
  }

  function setJobType(inj, element, jobType) {
    var bo = element.businessObject;
    if (bo.$type !== 'bpmn:ServiceTask') throw new Error('jobType geht nur bei serviceTask.');
    var f = inj.get('bpmnFactory');
    var old = (bo.extensionElements && bo.extensionElements.values) || [];
    var values = old.filter(function (v) { return v.$type !== 'zeebe:TaskDefinition'; });
    values.push(f.create('zeebe:TaskDefinition', { type: jobType }));
    inj.get('modeling').updateProperties(element, {
      extensionElements: f.create('bpmn:ExtensionElements', { values: values }),
    });
  }

  function setCondition(inj, flow, condition) {
    if (flow.businessObject.$type !== 'bpmn:SequenceFlow') throw new Error('condition geht nur bei Verbindungen.');
    inj.get('modeling').updateProperties(flow, {
      conditionExpression: inj.get('bpmnFactory').create('bpmn:FormalExpression', { body: condition }),
    });
  }

  var handlers = {
    status: function () {
      var inj = active();
      return {
        connected: true,
        diagramOpen: !!inj,
        tab: activeTab && { name: activeTab.name, type: activeTab.type, path: activeTab.file && activeTab.file.path },
      };
    },

    describe: function () {
      var inj = need();
      var all = inj.get('elementRegistry').getAll();
      var nodes = [], flows = [];
      all.forEach(function (e) {
        var bo = e.businessObject;
        if (!bo || e.labelTarget || e.type === 'label' || bo.$type === 'bpmn:Process' || bo.$type === 'bpmn:Collaboration' || /^bpmndi:/.test(bo.$type)) return;
        if (bo.$type === 'bpmn:SequenceFlow') {
          flows.push({ id: e.id, from: e.source && e.source.id, to: e.target && e.target.id, name: bo.name || undefined,
            condition: bo.conditionExpression ? bo.conditionExpression.body : undefined });
        } else if (e.waypoints === undefined) {
          var td = bo.extensionElements && (bo.extensionElements.values || []).filter(function (v) { return v.$type === 'zeebe:TaskDefinition'; })[0];
          nodes.push({ id: e.id, type: bo.$type.replace('bpmn:', ''), name: bo.name || undefined, jobType: td ? td.type : undefined });
        }
      });
      return { elements: nodes, flows: flows };
    },

    addElement: function (p) {
      var inj = need();
      var type = TYPES[p.type];
      if (!type) throw new Error('Unbekannter Typ: ' + p.type);
      if (p.id && inj.get('elementRegistry').get(p.id)) throw new Error('ID existiert schon: ' + p.id);
      // ID muss am Business-Objekt gesetzt werden, sonst landet sie nicht in der Datei.
      var bo = inj.get('bpmnFactory').create(type, p.id ? { id: p.id } : {});
      var shape = inj.get('elementFactory').createShape({ type: type, businessObject: bo });
      var modeling = inj.get('modeling');
      var created;
      if (p.after) {
        created = inj.get('autoPlace').append(el(inj, p.after), shape);
      } else {
        var root = inj.get('canvas').getRootElement();
        var maxX = 0;
        inj.get('elementRegistry').forEach(function (e) {
          if (e.parent === root && !e.waypoints && e.type !== 'label') maxX = Math.max(maxX, e.x + e.width);
        });
        created = modeling.createShape(shape, { x: maxX ? maxX + 100 : 200, y: 200 }, root);
      }
      if (p.name) modeling.updateProperties(created, { name: p.name });
      if (p.after && p.flowName) {
        var conn = created.incoming && created.incoming[0];
        if (conn) modeling.updateProperties(conn, { name: p.flowName });
      }
      inj.get('canvas').scrollToElement(created);
      return { id: created.id };
    },

    connect: function (p) {
      var inj = need();
      var conn = inj.get('modeling').connect(el(inj, p.source), el(inj, p.target), { type: 'bpmn:SequenceFlow' });
      if (!conn) throw new Error('Verbindung laut BPMN-Regeln nicht erlaubt.');
      if (p.name) inj.get('modeling').updateProperties(conn, { name: p.name });
      if (p.condition) setCondition(inj, conn, p.condition);
      return { id: conn.id };
    },

    update: function (p) {
      var inj = need();
      var e = el(inj, p.id);
      if (p.name !== undefined) inj.get('modeling').updateProperties(e, { name: p.name });
      if (p.jobType !== undefined) setJobType(inj, e, p.jobType);
      if (p.condition !== undefined) setCondition(inj, e, p.condition);
      return { id: e.id };
    },

    remove: function (p) {
      var inj = need();
      inj.get('modeling').removeElements([el(inj, p.id)]);
      return { removed: p.id };
    },

    undo: function () { need().get('commandStack').undo(); return {}; },

    save: function () {
      if (!api.triggerAction) throw new Error('Speichern nicht verfügbar.');
      return Promise.resolve(api.triggerAction('save')).then(function () { return { saved: true }; });
    },
  };

  // ---------- WebSocket zum MCP-Server ----------
  function start() {
    var ws;
    function connect() {
      try { ws = new WebSocket(URL); } catch (e) { return setTimeout(connect, 3000); }
      ws.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        var h = handlers[msg.method];
        Promise.resolve()
          .then(function () { if (!h) throw new Error('Unbekannte Methode: ' + msg.method); return h(msg.params || {}); })
          .then(function (result) { ws.send(JSON.stringify({ id: msg.id, result: result })); },
                function (err) { ws.send(JSON.stringify({ id: msg.id, error: String((err && err.message) || err) })); });
      };
      ws.onclose = function () { setTimeout(connect, 3000); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
    connect();
  }
})();
