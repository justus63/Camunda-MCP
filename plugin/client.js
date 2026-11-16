/* Läuft im Renderer des Camunda Modelers (kein Node, kein Bundler nötig).
 * - fängt über ein bpmn-js-Modul die Modeler-Instanzen aller Tabs ab
 * - verbindet sich per WebSocket mit dem MCP-Server (ws://127.0.0.1:PORT)
 * - führt dessen Befehle über bpmn-js "modeling" aus, d. h. mit Undo/Redo
 */
(function () {
  var VERSION = 6;
  var PORT = window.__BPMN_MCP_PORT || 17877;
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
      var c = injector.get('canvas').getContainer();
      return c.isConnected && c.getClientRects().length > 0;
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

  // ---------- Typen ----------
  var X = { isExpanded: true };
  var TYPES = {
    startEvent: 'bpmn:StartEvent', endEvent: 'bpmn:EndEvent', task: 'bpmn:Task',
    userTask: 'bpmn:UserTask', serviceTask: 'bpmn:ServiceTask', scriptTask: 'bpmn:ScriptTask',
    businessRuleTask: 'bpmn:BusinessRuleTask', sendTask: 'bpmn:SendTask', receiveTask: 'bpmn:ReceiveTask',
    manualTask: 'bpmn:ManualTask', callActivity: 'bpmn:CallActivity',
    exclusiveGateway: 'bpmn:ExclusiveGateway', parallelGateway: 'bpmn:ParallelGateway',
    inclusiveGateway: 'bpmn:InclusiveGateway', eventBasedGateway: 'bpmn:EventBasedGateway', complexGateway: 'bpmn:ComplexGateway',
    intermediateCatchEvent: 'bpmn:IntermediateCatchEvent', intermediateThrowEvent: 'bpmn:IntermediateThrowEvent',
    boundaryEvent: 'bpmn:BoundaryEvent', subProcess: 'bpmn:SubProcess', eventSubProcess: 'bpmn:SubProcess',
    transaction: 'bpmn:Transaction', adHocSubProcess: 'bpmn:AdHocSubProcess',
    dataObject: 'bpmn:DataObjectReference', dataStore: 'bpmn:DataStoreReference',
    textAnnotation: 'bpmn:TextAnnotation', group: 'bpmn:Group', participant: 'bpmn:Participant', lane: 'bpmn:Lane',
  };
  var ATTRS = { subProcess: X, transaction: X, adHocSubProcess: X, eventSubProcess: { isExpanded: true, triggeredByEvent: true } };
  var CONNECTIONS = { sequence: 'bpmn:SequenceFlow', message: 'bpmn:MessageFlow', association: 'bpmn:Association' };

  function assign(t) {
    for (var i = 1; i < arguments.length; i++) for (var k in arguments[i] || {}) t[k] = arguments[i][k];
    return t;
  }
  function clean(o) { Object.keys(o).forEach(function (k) { if (o[k] === undefined || o[k] === null || o[k] === false) delete o[k]; }); return o; }
  function short(t) { return t.replace('bpmn:', ''); }
  function isA(e, t) { return e.businessObject && e.businessObject.$instanceOf(t); }
  // Hauptebene (Prozess/Kollaboration) – auch wenn im Modeler gerade ein zugeklappter Teilprozess geöffnet ist.
  function rootOf(inj) {
    var c = inj.get('canvas'), rs = c.getRootElements ? c.getRootElements() : [c.getRootElement()];
    return rs.filter(function (r) { return r.businessObject && !isA(r, 'bpmn:SubProcess'); })[0] || c.getRootElement();
  }
  // Drill-down-Ebene eines zugeklappten Teilprozesses (bpmn-js legt sie als eigenes Root "<id>_plane" an).
  function planeOf(inj, e) {
    if (!e || !isA(e, 'bpmn:SubProcess') || (e.di && e.di.isExpanded) || e.parent === undefined) return null;
    return inj.get('elementRegistry').get(e.id + '_plane') || null;
  }
  function inner(inj, c) { return planeOf(inj, c) || c; }
  function enclosingProcess(bo) { while (bo && bo.$type !== 'bpmn:Process') bo = bo.$parent; return bo; }
  // Zugeklappte Teilprozesse, deren Ebene Inhalt hat.
  function subPlanes(inj) {
    return inj.get('elementRegistry').filter(function (e) {
      var pl = planeOf(inj, e);
      return pl && pl.children && pl.children.some(function (k) { return k.type !== 'label'; });
    }).map(function (e) { return e.id; });
  }
  function topOf(e) { while (e.parent) e = e.parent; return e; }
  function el(inj, id) {
    var reg = inj.get('elementRegistry'), e = reg.get(id);
    // Prozess-ID in einer Kollaboration: steht nicht in der Registry, gemeint ist der Pool mit diesem Prozess.
    if (!e) e = reg.filter(function (x) { return isA(x, 'bpmn:Participant') && x.businessObject.processRef && x.businessObject.processRef.id === id; })[0];
    if (!e) throw new Error('Element nicht gefunden: ' + id);
    return e;
  }
  // Pool/Lane/Teilprozess über ID oder (eindeutigen) Namen finden – spart einen describe-Aufruf.
  function container(inj, ref) {
    var reg = inj.get('elementRegistry'), e = reg.get(ref);
    if (e) return e;
    var hits = reg.filter(function (x) {
      return x.type !== 'label' && x.businessObject && x.businessObject.name === ref && (isA(x, 'bpmn:Participant') || isA(x, 'bpmn:Lane') || isA(x, 'bpmn:SubProcess'));
    });
    if (hits.length === 1) return hits[0];
    throw new Error(hits.length ? 'Name "' + ref + '" ist nicht eindeutig (' + hits.map(function (h) { return h.id; }).join(', ') + ') – ID angeben.' : 'Element nicht gefunden: ' + ref);
  }
  function shapesIn(c) { return c.children.filter(function (k) { return !k.waypoints && k.type !== 'label'; }); }
  function box(list) {
    if (!list.length) return null;
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    list.forEach(function (s) { x1 = Math.min(x1, s.x); y1 = Math.min(y1, s.y); x2 = Math.max(x2, s.x + s.width); y2 = Math.max(y2, s.y + s.height); });
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  function centerIn(s, b) { var cx = s.x + s.width / 2, cy = s.y + s.height / 2; return cx > b.x && cx < b.x + b.width && cy > b.y && cy < b.y + b.height; }

  // ---------- Event-Definitionen ----------
  var EVENT_DEF_TYPES = {
    timer: 'bpmn:TimerEventDefinition', message: 'bpmn:MessageEventDefinition',
    signal: 'bpmn:SignalEventDefinition', error: 'bpmn:ErrorEventDefinition',
    escalation: 'bpmn:EscalationEventDefinition', conditional: 'bpmn:ConditionalEventDefinition',
    terminate: 'bpmn:TerminateEventDefinition', link: 'bpmn:LinkEventDefinition', compensate: 'bpmn:CompensateEventDefinition',
  };
  var ROOT_FOR_DEF = {
    message: ['bpmn:Message', 'messageRef'], signal: ['bpmn:Signal', 'signalRef'],
    error: ['bpmn:Error', 'errorRef'], escalation: ['bpmn:Escalation', 'escalationRef'],
  };
  var TIMER_PROP = { date: 'timeDate', duration: 'timeDuration', cycle: 'timeCycle' };

  function definitionsOf(inj) {
    var bo = rootOf(inj).businessObject;
    while (bo.$parent) bo = bo.$parent;
    return bo;
  }

  // Ausführungsplattform des Diagramms: 'camunda7' (camunda:-Erweiterungen) oder 'camunda8' (zeebe:-Erweiterungen).
  function platformOf(inj) {
    var defs = definitionsOf(inj), v;
    try { v = defs.get('modeler:executionPlatform'); } catch (e) { /* egal */ }
    v = v || (defs.$attrs && defs.$attrs['modeler:executionPlatform']);
    if (v) return /cloud|zeebe|8/i.test(v) ? 'camunda8' : 'camunda7';
    var moddle = inj.get('moddle'), hasC = !!moddle.getPackage('camunda'), hasZ = !!moddle.getPackage('zeebe');
    if (hasC !== hasZ) return hasC ? 'camunda7' : 'camunda8';
    var a = defs.$attrs || {};
    return a['xmlns:camunda'] && !a['xmlns:zeebe'] ? 'camunda7' : 'camunda8';
  }
  function isC7(inj) { return platformOf(inj) === 'camunda7'; }

  function setEventDefinition(inj, element, spec) {
    var bo = element.businessObject;
    if (!/Event$/.test(bo.$type)) throw new Error('eventDefinition geht nur bei Events, nicht bei ' + bo.$type + '.');
    var modeling = inj.get('modeling');
    var f = inj.get('bpmnFactory');
    if (spec.type === 'none') {
      modeling.updateProperties(element, { eventDefinitions: [] });
      return;
    }
    var defType = EVENT_DEF_TYPES[spec.type];
    if (!defType) throw new Error('Unbekannter Event-Typ: ' + spec.type);
    var def = f.create(defType);
    if (spec.type === 'timer') {
      if (!spec.value) throw new Error('Timer braucht "value" (z. B. "P7D" oder "= startDatum").');
      var prop = TIMER_PROP[spec.timerType || 'duration'];
      def.set(prop, f.create('bpmn:FormalExpression', { body: spec.value }));
      def.get(prop).$parent = def;
    } else if (spec.type === 'conditional') {
      // Ohne value erlaubt (fachliche Modelle); für ausführbare Prozesse meldet die Prüfung die fehlende Bedingung.
      def.condition = f.create('bpmn:FormalExpression', spec.value ? { body: spec.value } : {});
      def.condition.$parent = def;
    } else if (spec.type === 'link') {
      def.name = spec.name || bo.name || 'Link';
    } else if (ROOT_FOR_DEF[spec.type]) {
      var rootType = ROOT_FOR_DEF[spec.type][0], refProp = ROOT_FOR_DEF[spec.type][1];
      var definitions = definitionsOf(inj);
      var name = spec.name || bo.name || spec.type;
      var roots = definitions.get('rootElements');
      var root = roots.filter(function (r) { return r.$type === rootType && r.name === name; })[0];
      if (!root) {
        root = f.create(rootType, { name: name });
        root.$parent = definitions;
        modeling.updateModdleProperties(element, definitions, { rootElements: roots.concat([root]) });
      }
      if (spec.code && spec.type === 'error') modeling.updateModdleProperties(element, root, { errorCode: spec.code });
      if (spec.code && spec.type === 'escalation') modeling.updateModdleProperties(element, root, { escalationCode: spec.code });
      if (spec.correlationKey && spec.type === 'message' && !isC7(inj)) setExt(inj, element, root, 'zeebe:Subscription', { correlationKey: spec.correlationKey });
      def[refProp] = root;
    }
    def.$parent = bo;
    modeling.updateProperties(element, { eventDefinitions: [def] });
  }

  function summarizeEventDefinition(bo) {
    var def = bo.eventDefinitions && bo.eventDefinitions[0];
    if (!def) return undefined;
    var out = { type: def.$type.replace('bpmn:', '').replace('EventDefinition', '').toLowerCase() };
    Object.keys(TIMER_PROP).forEach(function (t) {
      if (def[TIMER_PROP[t]]) { out.timerType = t; out.value = def[TIMER_PROP[t]].body; }
    });
    var ref = def.messageRef || def.signalRef || def.errorRef || def.escalationRef;
    if (ref) {
      out.name = ref.name;
      var sub = extOf(ref, 'zeebe:Subscription');
      if (sub) out.correlationKey = sub.correlationKey;
    }
    if (def.condition) out.value = def.condition.body;
    return out;
  }

  // ---------- Zeebe-Erweiterungen ----------
  function extOf(bo, type) {
    return ((bo.extensionElements && bo.extensionElements.values) || []).filter(function (v) { return v.$type === type; })[0];
  }
  // Ersetzt/ergänzt ein Erweiterungselement; props === null entfernt es.
  function setExt(inj, element, bo, type, props, make) {
    var f = inj.get('bpmnFactory');
    var values = ((bo.extensionElements && bo.extensionElements.values) || []).filter(function (v) { return v.$type !== type; });
    var old = extOf(bo, type);
    if (props) {
      var merged = {};
      // vorhandene Attribute behalten (z. B. type, wenn nur retries geändert wird)
      if (old && !make) old.$descriptor.properties.forEach(function (d) { if (old.get(d.name) !== undefined) merged[d.name] = old.get(d.name); });
      var neu = make ? make(f) : f.create(type, assign(merged, props));
      values.push(neu);
    }
    var ext = f.create('bpmn:ExtensionElements', { values: values });
    ext.$parent = bo;
    values.forEach(function (v) { v.$parent = ext; });
    inj.get('modeling').updateModdleProperties(element, bo, { extensionElements: ext });
  }
  function pickDefined(o, keys) {
    var out = null;
    keys.forEach(function (k) { if (o[k] !== undefined) { out = out || {}; out[k] = o[k]; } });
    return out;
  }
  function setProperties(inj, e, pr) {
    if (isC7(inj)) return setProperties7(inj, e, pr);
    var bo = e.businessObject, v;
    var only7 = Object.keys(pr).filter(function (k) { return /^(class|delegateExpression|expression|topic|formKey|formRef|formFields|scriptFormat|taskListeners|executionListeners|historyTimeToLive|asyncBefore|asyncAfter|mapDecisionResult|initiator)$/.test(k); });
    if (only7.length) throw new Error('Nur in Camunda-7-Diagrammen möglich: ' + only7.join(', ') + ' (dieses Diagramm ist Camunda 8).');
    if ((v = pickDefined(pr, ['retries']))) setExt(inj, e, bo, 'zeebe:TaskDefinition', v);
    if ((v = pickDefined(pr, ['assignee', 'candidateGroups', 'candidateUsers']))) setExt(inj, e, bo, 'zeebe:AssignmentDefinition', v);
    if ((v = pickDefined(pr, ['dueDate', 'followUpDate']))) setExt(inj, e, bo, 'zeebe:TaskSchedule', v);
    if ((v = pickDefined(pr, ['formId']))) setExt(inj, e, bo, 'zeebe:FormDefinition', v);
    if (pr.calledProcessId !== undefined) setExt(inj, e, bo, 'zeebe:CalledElement', { processId: pr.calledProcessId, propagateAllChildVariables: false });
    if (pr.decisionId !== undefined) setExt(inj, e, bo, 'zeebe:CalledDecision', clean({ decisionId: pr.decisionId, resultVariable: pr.resultVariable }));
    if (pr.script !== undefined) setExt(inj, e, bo, 'zeebe:Script', clean({ expression: pr.script, resultVariable: pr.resultVariable }));
    if (pr.inputs || pr.outputs) {
      var old = extOf(bo, 'zeebe:IoMapping');
      setExt(inj, e, bo, 'zeebe:IoMapping', {}, function (f) {
        var io = f.create('zeebe:IoMapping', {
          inputParameters: pr.inputs ? pr.inputs.map(function (m) { return f.create('zeebe:Input', m); }) : (old && old.inputParameters) || [],
          outputParameters: pr.outputs ? pr.outputs.map(function (m) { return f.create('zeebe:Output', m); }) : (old && old.outputParameters) || [],
        });
        io.inputParameters.concat(io.outputParameters).forEach(function (m) { m.$parent = io; });
        return io;
      });
    }
    if (pr.headers) {
      setExt(inj, e, bo, 'zeebe:TaskHeaders', {}, function (f) {
        var h = f.create('zeebe:TaskHeaders', { values: Object.keys(pr.headers).map(function (k) { return f.create('zeebe:Header', { key: k, value: String(pr.headers[k]) }); }) });
        h.values.forEach(function (m) { m.$parent = h; });
        return h;
      });
    }
  }

  // ---------- Camunda 7 (camunda:-Attribute und -Erweiterungen) ----------
  function val(v) { return v === '' || v === null ? undefined : v; }
  function need7(bo, re, what) { if (!re.test(bo.$type)) throw new Error(what + ' geht nicht bei ' + short(bo.$type) + '.'); }
  function processOf(e) {
    var bo = e.businessObject;
    return bo.$type === 'bpmn:Participant' ? bo.processRef : bo.$type === 'bpmn:Process' ? bo : null;
  }
  function adopt(parent, kids) { (kids || []).forEach(function (k) { if (k) k.$parent = parent; }); return parent; }
  function setExtAll(inj, element, bo, type, list) {
    var f = inj.get('bpmnFactory');
    var values = ((bo.extensionElements && bo.extensionElements.values) || []).filter(function (v) { return v.$type !== type; }).concat(list);
    var ext = adopt(f.create('bpmn:ExtensionElements', { values: values }), values);
    ext.$parent = bo;
    inj.get('modeling').updateModdleProperties(element, bo, { extensionElements: ext });
  }
  function listener7(f, type, l) {
    var a = { event: l.event || (type === 'camunda:TaskListener' ? 'create' : 'start') };
    ['class', 'delegateExpression', 'expression'].forEach(function (k) { if (l[k]) a[k] = l[k]; });
    var li = f.create(type, a);
    if (l.script) adopt(li, [li.script = f.create('camunda:Script', { scriptFormat: l.scriptFormat || 'groovy', value: l.script })]);
    else if (!l['class'] && !l.delegateExpression && !l.expression) throw new Error('Listener braucht class, delegateExpression, expression oder script.');
    return li;
  }
  function formData7(f, fields) {
    var fd = f.create('camunda:FormData', {
      fields: fields.map(function (d) {
        if (!d.id) throw new Error('formFields: jedes Feld braucht eine "id" (= Name der Prozessvariable).');
        var a = { id: d.id, label: d.label || d.id, type: d.type || (d.values ? 'enum' : 'string') };
        if (d.defaultValue !== undefined) a.defaultValue = String(d.defaultValue);
        if (d.datePattern) a.datePattern = d.datePattern;
        var ff = f.create('camunda:FormField', a), cons = [];
        if (d.required) cons.push({ name: 'required' });
        if (d.readonly) cons.push({ name: 'readonly' });
        ['min', 'max', 'minlength', 'maxlength'].forEach(function (k) { if (d[k] !== undefined) cons.push({ name: k, config: String(d[k]) }); });
        if (cons.length) {
          ff.validation = f.create('camunda:Validation', { constraints: cons.map(function (c) { return f.create('camunda:Constraint', c); }) });
          adopt(ff, [adopt(ff.validation, ff.validation.constraints)]);
        }
        if (d.values) {
          var list = Array.isArray(d.values)
            ? d.values.map(function (x) { return typeof x === 'string' ? { id: x, name: x } : { id: x.id, name: x.name || x.id }; })
            : Object.keys(d.values).map(function (k) { return { id: k, name: String(d.values[k]) }; });
          ff.values = list.map(function (x) { return f.create('camunda:Value', x); });
          adopt(ff, ff.values);
        }
        return ff;
      }),
    });
    return adopt(fd, fd.fields);
  }
  function setProperties7(inj, e, pr) {
    var bo = e.businessObject, modeling = inj.get('modeling'), f = inj.get('bpmnFactory'), up = {};
    var only8 = Object.keys(pr).filter(function (k) { return /^(retries|headers)$/.test(k); });
    if (only8.length) throw new Error('Nur in Camunda-8-Diagrammen möglich: ' + only8.join(', ') + ' (dieses Diagramm ist Camunda 7).');
    var proc = processOf(e), pp = {};
    if (pr.historyTimeToLive !== undefined) pp['camunda:historyTimeToLive'] = val(String(pr.historyTimeToLive));
    ['candidateStarterGroups', 'candidateStarterUsers', 'versionTag'].forEach(function (k) { if (pr[k] !== undefined) pp['camunda:' + k] = val(pr[k]); });
    if (pr.isExecutable !== undefined) pp.isExecutable = !!pr.isExecutable;
    if (Object.keys(pp).length) {
      if (!proc) throw new Error('historyTimeToLive/isExecutable/candidateStarter… gehören an den Prozess: ID des Pools oder des Prozesses angeben.');
      modeling.updateModdleProperties(e, proc, pp);
    }
    ['assignee', 'candidateGroups', 'candidateUsers', 'dueDate', 'followUpDate', 'priority'].forEach(function (k) {
      if (pr[k] !== undefined) { need7(bo, /UserTask/, k); up['camunda:' + k] = val(pr[k]); }
    });
    // Formulare: formKey (Embedded Form), formRef (Camunda Form), formFields (Generated Form)
    var formRef = pr.formRef !== undefined ? pr.formRef : pr.formId;
    if (pr.formKey !== undefined || formRef !== undefined || pr.formFields) need7(bo, /UserTask|StartEvent/, 'Ein Formular');
    if (pr.formKey !== undefined) { up['camunda:formKey'] = val(pr.formKey); if (pr.formKey) { up['camunda:formRef'] = undefined; up['camunda:formRefBinding'] = undefined; } }
    if (formRef !== undefined) { up['camunda:formRef'] = val(formRef); up['camunda:formRefBinding'] = formRef ? pr.formRefBinding || 'latest' : undefined; if (formRef) up['camunda:formKey'] = undefined; }
    if (pr.formFields) setExtAll(inj, e, bo, 'camunda:FormData', pr.formFields.length ? [formData7(f, pr.formFields)] : []);
    if (pr.initiator !== undefined) { need7(bo, /StartEvent/, 'initiator'); up['camunda:initiator'] = val(pr.initiator); }
    // Implementierung: Java-Klasse, Delegate Expression (Spring Bean), Expression oder External Task (topic)
    if (pickDefined(pr, ['class', 'delegateExpression', 'expression', 'topic'])) {
      var target = /ServiceTask|SendTask|BusinessRuleTask/.test(bo.$type) ? bo
        : (/Event$/.test(bo.$type) && bo.eventDefinitions && bo.eventDefinitions[0] && bo.eventDefinitions[0].$type === 'bpmn:MessageEventDefinition') ? bo.eventDefinitions[0] : null;
      if (!target) throw new Error('class/delegateExpression/expression/topic gehen nur bei Service-, Send-, Business-Rule-Tasks und auslösenden Nachrichtenereignissen, nicht bei ' + short(bo.$type) + '.');
      var impl = { 'camunda:class': undefined, 'camunda:delegateExpression': undefined, 'camunda:expression': undefined, 'camunda:type': undefined, 'camunda:topic': undefined };
      if (pr.topic) { impl['camunda:type'] = 'external'; impl['camunda:topic'] = pr.topic; }
      else if (pr['class']) impl['camunda:class'] = pr['class'];
      else if (pr.delegateExpression) impl['camunda:delegateExpression'] = pr.delegateExpression;
      else if (pr.expression) impl['camunda:expression'] = pr.expression;
      if (target === bo) assign(up, impl); else modeling.updateModdleProperties(e, target, impl);
    }
    var decision = pr.decisionRef !== undefined ? pr.decisionRef : pr.decisionId;
    if (decision !== undefined) { need7(bo, /BusinessRuleTask/, 'decisionRef'); up['camunda:decisionRef'] = val(decision); }
    if (pr.mapDecisionResult !== undefined) { need7(bo, /BusinessRuleTask/, 'mapDecisionResult'); up['camunda:mapDecisionResult'] = val(pr.mapDecisionResult); }
    if (pr.script !== undefined || pr.scriptFormat !== undefined || pr.resource !== undefined) {
      need7(bo, /ScriptTask/, 'script/scriptFormat/resource');
      up.scriptFormat = pr.scriptFormat || bo.scriptFormat || 'groovy';
      if (pr.script !== undefined) { up.script = val(pr.script); if (pr.script) up['camunda:resource'] = undefined; }
      if (pr.resource !== undefined) { up['camunda:resource'] = val(pr.resource); if (pr.resource) up.script = undefined; }
    }
    if (pr.resultVariable !== undefined) { need7(bo, /ServiceTask|SendTask|BusinessRuleTask|ScriptTask/, 'resultVariable'); up['camunda:resultVariable'] = val(pr.resultVariable); }
    var called = pr.calledElement !== undefined ? pr.calledElement : pr.calledProcessId;
    if (called !== undefined) { need7(bo, /CallActivity/, 'calledElement'); up.calledElement = val(called); up['camunda:calledElementBinding'] = called ? 'latest' : undefined; }
    if (pr.asyncBefore !== undefined) up['camunda:asyncBefore'] = !!pr.asyncBefore;
    if (pr.asyncAfter !== undefined) up['camunda:asyncAfter'] = !!pr.asyncAfter;
    if (Object.keys(up).length) modeling.updateProperties(e, up);
    if (pr.inputs || pr.outputs) {
      var oldIo = extOf(bo, 'camunda:InputOutput');
      var mk = function (type) { return function (m) { return f.create(type, { name: m.name || m.target, value: m.value !== undefined ? m.value : m.source }); }; };
      var io = f.create('camunda:InputOutput', {
        inputParameters: pr.inputs ? pr.inputs.map(mk('camunda:InputParameter')) : (oldIo && oldIo.inputParameters) || [],
        outputParameters: pr.outputs ? pr.outputs.map(mk('camunda:OutputParameter')) : (oldIo && oldIo.outputParameters) || [],
      });
      adopt(io, io.inputParameters.concat(io.outputParameters));
      setExtAll(inj, e, bo, 'camunda:InputOutput', io.inputParameters.length + io.outputParameters.length ? [io] : []);
    }
    if (pr.taskListeners) { need7(bo, /UserTask/, 'taskListeners'); setExtAll(inj, e, bo, 'camunda:TaskListener', pr.taskListeners.map(function (l) { return listener7(f, 'camunda:TaskListener', l); })); }
    if (pr.executionListeners) {
      var lbo = proc || bo;
      setExtAll(inj, e, lbo, 'camunda:ExecutionListener', pr.executionListeners.map(function (l) { return listener7(f, 'camunda:ExecutionListener', l); }));
    }
  }

  // Kurzfassung der technischen Eigenschaften (für describe und die Prüfung)
  function propsOf(c7, bo) {
    var o = {}, x;
    var g = function (k, from) { try { return (from || bo).get(k); } catch (e) { return undefined; } };
    if (c7) {
      ['assignee', 'candidateGroups', 'candidateUsers', 'dueDate', 'formKey', 'formRef', 'class', 'delegateExpression', 'expression', 'topic', 'decisionRef', 'mapDecisionResult', 'resultVariable', 'initiator'].forEach(function (k) {
        var v = g('camunda:' + k); if (v) o[k] = v;
      });
      var md = /Event$/.test(bo.$type) && bo.eventDefinitions && bo.eventDefinitions[0];
      if (md && md.$type === 'bpmn:MessageEventDefinition') ['class', 'delegateExpression', 'expression', 'topic'].forEach(function (k) { var v = g('camunda:' + k, md); if (v) o[k] = v; });
      if (bo.scriptFormat) o.scriptFormat = bo.scriptFormat;
      if (bo.script || g('camunda:resource')) o.script = g('camunda:resource') || 'inline';
      if (bo.calledElement) o.calledElement = bo.calledElement;
      if (g('camunda:asyncBefore')) o.asyncBefore = true;
      if ((x = extOf(bo, 'camunda:FormData')) && x.fields) o.formFields = x.fields.map(function (d) { return d.id; });
      var ext = (bo.extensionElements && bo.extensionElements.values) || [];
      var tl = ext.filter(function (v) { return v.$type === 'camunda:TaskListener'; }).length, el2 = ext.filter(function (v) { return v.$type === 'camunda:ExecutionListener'; }).length;
      if (tl) o.taskListeners = tl;
      if (el2) o.executionListeners = el2;
      if (bo.loopCharacteristics && g('camunda:collection', bo.loopCharacteristics)) o.collection = g('camunda:collection', bo.loopCharacteristics);
    } else {
      if ((x = extOf(bo, 'zeebe:AssignmentDefinition'))) { if (x.assignee) o.assignee = x.assignee; if (x.candidateGroups) o.candidateGroups = x.candidateGroups; }
      if ((x = extOf(bo, 'zeebe:FormDefinition')) && x.formId) o.formId = x.formId;
      if ((x = extOf(bo, 'zeebe:CalledDecision')) && x.decisionId) o.decisionId = x.decisionId;
      if ((x = extOf(bo, 'zeebe:CalledElement')) && x.processId) o.calledProcessId = x.processId;
      if (extOf(bo, 'zeebe:Script')) o.script = 'inline';
    }
    return Object.keys(o).length ? o : undefined;
  }
  function processInfo(c7, proc) {
    if (!proc) return undefined;
    var o = { processId: proc.id, isExecutable: !!proc.isExecutable };
    if (c7) { try { var h = proc.get('camunda:historyTimeToLive'); if (h) o.historyTimeToLive = h; } catch (e) { /* egal */ } }
    return o;
  }

  function setLoop(inj, e, loop) {
    var f = inj.get('bpmnFactory'), lc;
    if (loop.type === 'loop') lc = f.create('bpmn:StandardLoopCharacteristics');
    else if (loop.type === 'parallel' || loop.type === 'sequential') {
      lc = f.create('bpmn:MultiInstanceLoopCharacteristics', { isSequential: loop.type === 'sequential' });
      var z = pickDefined(loop, ['inputCollection', 'inputElement', 'outputCollection', 'outputElement']);
      if (isC7(inj)) {
        var col = loop.collection || loop.inputCollection, ev = loop.elementVariable || loop.inputElement;
        if (col) lc.set('camunda:collection', col);
        if (ev) lc.set('camunda:elementVariable', ev);
        if (loop.cardinality !== undefined) adopt(lc, [lc.loopCardinality = f.create('bpmn:FormalExpression', { body: String(loop.cardinality) })]);
        if (loop.completionCondition) adopt(lc, [lc.completionCondition = f.create('bpmn:FormalExpression', { body: loop.completionCondition })]);
      } else if (z) {
        var zl = f.create('zeebe:LoopCharacteristics', z);
        lc.extensionElements = f.create('bpmn:ExtensionElements', { values: [zl] });
        lc.extensionElements.$parent = lc;
        zl.$parent = lc.extensionElements;
      }
    }
    if (lc) lc.$parent = e.businessObject;
    inj.get('modeling').updateProperties(e, { loopCharacteristics: lc });
  }

  function setCondition(inj, flow, condition) {
    if (flow.businessObject.$type !== 'bpmn:SequenceFlow') throw new Error('condition geht nur bei Sequenzflüssen.');
    var src = flow.source && flow.source.businessObject.$type;
    if (condition && /EventBasedGateway|ParallelGateway/.test(src)) throw new Error(short(src) + ' hat keine Bedingungen an seinen Ausgängen.');
    inj.get('modeling').updateProperties(flow, {
      conditionExpression: condition ? inj.get('bpmnFactory').create('bpmn:FormalExpression', { body: condition }) : undefined,
    });
  }

  // Elementtyp wechseln (bpmn-js Replace), ID und Verbindungen bleiben erhalten.
  function changeType(inj, element, type) {
    var target = TYPES[type];
    if (!target || /participant|lane|group|textAnnotation|data/.test(type)) throw new Error('Typwechsel nach ' + type + ' nicht möglich.');
    var bo = element.businessObject;
    if (bo.$type === target && !ATTRS[type]) return element;
    var oldId = element.id;
    var keepDefs = /Event$/.test(target) && bo.eventDefinitions && bo.eventDefinitions[0];
    var links = (element.incoming || []).length + (element.outgoing || []).length;
    var replaced = inj.get('bpmnReplace').replaceElement(element, assign({ type: target }, ATTRS[type]));
    var lost = links - (replaced.incoming || []).length - (replaced.outgoing || []).length;
    if (lost > 0) {
      throw new Error('Typwechsel nach ' + type + ' abgebrochen: ' + lost + ' Verbindung(en) wären laut BPMN-Regeln entfernt worden.' +
        (type === 'eventBasedGateway' ? ' Zuerst den folgenden Ereignissen einen Typ geben (eventDefinition: timer/message/...).' : ''));
    }
    var modeling = inj.get('modeling');
    if (replaced.id !== oldId) modeling.updateProperties(replaced, { id: oldId });
    if (keepDefs) {
      keepDefs.$parent = replaced.businessObject;
      modeling.updateProperties(replaced, { eventDefinitions: [keepDefs] });
    }
    if (/EventBasedGateway|ParallelGateway/.test(target)) {
      (replaced.outgoing || []).forEach(function (c) {
        if (c.businessObject.conditionExpression) modeling.updateProperties(c, { conditionExpression: undefined });
      });
    }
    return replaced;
  }

  // Alle änderbaren Eigenschaften; wird von addElement, connect und update benutzt.
  function applyUpdate(inj, e, p) {
    var modeling = inj.get('modeling'), f = inj.get('bpmnFactory');
    if (p.type !== undefined && !e.waypoints && TYPES[p.type] && (e.businessObject.$type !== TYPES[p.type] || ATTRS[p.type]) && p.__created !== true) e = changeType(inj, e, p.type);
    var bo = e.businessObject;
    if (p.eventDefinition !== undefined) setEventDefinition(inj, e, p.eventDefinition);
    var text = p.name !== undefined ? p.name : p.text;
    if (text !== undefined) {
      if (/TextAnnotation|Group/.test(bo.$type)) modeling.updateLabel(e, text);
      else modeling.updateProperties(e, { name: text });
    }
    if (p.jobType !== undefined) {
      if (isC7(inj)) throw new Error('jobType gibt es nur in Camunda 8. Camunda 7: properties.class, delegateExpression, expression oder topic (External Task) verwenden.');
      if (!/ServiceTask|SendTask|BusinessRuleTask|ScriptTask|EndEvent|IntermediateThrowEvent/.test(bo.$type)) throw new Error('jobType geht nicht bei ' + short(bo.$type) + '.');
      setExt(inj, e, bo, 'zeebe:TaskDefinition', { type: p.jobType });
    }
    if (p.properties) setProperties(inj, e, p.properties);
    if (p.condition !== undefined) setCondition(inj, e, p.condition);
    if (p.isDefault !== undefined) {
      if (!e.waypoints || !e.source) throw new Error('isDefault geht nur bei Sequenzflüssen.');
      modeling.updateProperties(e.source, { default: p.isDefault ? bo : undefined });
    }
    if (p.documentation !== undefined) {
      modeling.updateProperties(e, { documentation: p.documentation ? [f.create('bpmn:Documentation', { text: p.documentation })] : [] });
    }
    if (p.interrupting !== undefined) {
      if (bo.$type === 'bpmn:BoundaryEvent') modeling.updateProperties(e, { cancelActivity: !!p.interrupting });
      else if (bo.$type === 'bpmn:StartEvent') modeling.updateProperties(e, { isInterrupting: !!p.interrupting });
      else throw new Error('interrupting geht nur bei Boundary- und Start-Events.');
    }
    if (p.loop) setLoop(inj, e, p.loop);
    if (p.state !== undefined) {
      if (!/DataObjectReference|DataStoreReference/.test(bo.$type)) throw new Error('state geht nur bei Datenobjekten/-speichern.');
      var st = p.state ? f.create('bpmn:DataState', { name: p.state }) : undefined;
      if (st) st.$parent = bo;
      modeling.updateModdleProperties(e, bo, { dataState: st });
      // bpmn-js zeichnet den Zustand nicht: zusätzlich sichtbar als "Name [Zustand]"
      var base = (bo.name || '').replace(/\s*\[[^\]]*\]\s*$/, '');
      modeling.updateProperties(e, { name: p.state ? base + ' [' + p.state + ']' : base });
    }
    if (p.collection !== undefined) {
      if (bo.$type !== 'bpmn:DataObjectReference' || !bo.dataObjectRef) throw new Error('collection geht nur bei Datenobjekten.');
      modeling.updateModdleProperties(e, bo.dataObjectRef, { isCollection: !!p.collection });
    }
    if (p.color) modeling.setColor([e], { fill: p.color.fill, stroke: p.color.stroke });
    if (p.newId) modeling.updateProperties(e, { id: p.newId });
    return e;
  }

  // ---------- Layout direkt setzen: ein einziger Undo-Schritt, ohne Seiteneffekte ----------
  function syncDi(e, f) {
    var di = e.di || (e.labelTarget && e.labelTarget.di);
    if (!di) return;
    if (e.waypoints) { di.set('waypoint', f.createDiWaypoints(e.waypoints)); return; }
    var target = di;
    if (e.labelTarget) {
      if (!di.label) { di.label = f.createDiLabel(); di.label.$parent = di; }
      target = di.label;
    }
    var b = target.bounds;
    if (!b) { b = f.createDiBounds(); b.$parent = target; target.set('bounds', b); }
    b.x = e.x; b.y = e.y; b.width = e.width; b.height = e.height;
  }
  function ApplyLayoutHandler(elementRegistry, bpmnFactory) {
    function geo(s) { return { x: s.x, y: s.y, width: s.width, height: s.height }; }
    function apply(state, snap) {
      var changed = [], before = { shapes: {}, labels: {}, edges: {} };
      function setBox(s, b, bucket, id) {
        if (snap) before[bucket][id] = geo(s);
        s.x = b.x; s.y = b.y; s.width = b.width; s.height = b.height;
        syncDi(s, bpmnFactory);
        changed.push(s);
      }
      Object.keys(state.shapes).forEach(function (id) {
        var s = elementRegistry.get(id);
        if (s && !s.waypoints) setBox(s, state.shapes[id], 'shapes', id);
      });
      Object.keys(state.labels).forEach(function (id) {
        var s = elementRegistry.get(id);
        if (s && s.label) setBox(s.label, state.labels[id], 'labels', id);
      });
      Object.keys(state.edges).forEach(function (id) {
        var c = elementRegistry.get(id);
        if (!c || !c.waypoints) return;
        if (snap) before.edges[id] = c.waypoints.map(function (p) { return { x: p.x, y: p.y }; });
        c.waypoints = state.edges[id].map(function (p) { return { x: p.x, y: p.y }; });
        syncDi(c, bpmnFactory);
        changed.push(c);
      });
      return { changed: changed, before: before };
    }
    this.execute = function (ctx) {
      var r = apply(ctx.after, !ctx.before);
      if (!ctx.before) ctx.before = r.before;
      ctx.count = { shapes: Object.keys(ctx.before.shapes).length, edges: Object.keys(ctx.before.edges).length };
      return r.changed;
    };
    this.revert = function (ctx) { return apply(ctx.before, false).changed; };
  }
  ApplyLayoutHandler.$inject = ['elementRegistry', 'bpmnFactory'];

  function commandStack(inj) {
    var cs = inj.get('commandStack');
    if (!cs._mcpLayoutRegistered) {
      cs.registerHandler('mcp.applyLayout', ApplyLayoutHandler);
      cs._mcpLayoutRegistered = true;
    }
    return cs;
  }

  // ---------- Graph (für Layout, Prüfung und describe) ----------
  function graph(inj, opts) {
    var plane = opts && opts.plane, nodes = [], edges = [], c7 = isC7(inj);
    var root = plane ? planeOf(inj, el(inj, plane)) : rootOf(inj);
    if (!root) throw new Error(plane + ' ist kein zugeklappter Teilprozess mit eigener Ebene.');
    var all = inj.get('elementRegistry').filter(function (e) { return e !== root && e.parent && e.type !== 'label' && !e.labelTarget && e.businessObject && topOf(e) === root; });
    var topLanes = all.filter(function (e) { return isA(e, 'bpmn:Lane') && isA(e.parent, 'bpmn:Participant'); });
    function lb(e) { return e.label ? { x: e.label.x, y: e.label.y, width: e.label.width, height: e.label.height } : undefined; }
    all.forEach(function (e) {
      var bo = e.businessObject, type = short(bo.$type);
      if (e.waypoints) {
        edges.push(clean({
          id: e.id, type: type, source: e.source && e.source.id, target: e.target && e.target.id, name: bo.name,
          condition: bo.conditionExpression && bo.conditionExpression.body,
          isDefault: !!(e.source && e.source.businessObject.default === bo),
          waypoints: e.waypoints.map(function (p) { return { x: Math.round(p.x), y: Math.round(p.y) }; }), label: lb(e),
        }));
        return;
      }
      var td = extOf(bo, 'zeebe:TaskDefinition'), lc = bo.loopCharacteristics;
      var lane = topLanes.filter(function (l) { return topLanesParent(l) === e.parent && centerIn(e, l); })[0];
      nodes.push(clean({
        id: e.id, type: type, name: bo.name || bo.text || (bo.categoryValueRef && bo.categoryValueRef.value),
        x: e.x, y: e.y, width: e.width, height: e.height,
        parent: e.parent !== root ? e.parent.id : null, lane: lane && type !== 'Lane' ? lane.id : undefined, host: e.host && e.host.id,
        expanded: /SubProcess|Transaction/.test(type) ? !!(e.di && e.di.isExpanded) : type === 'Participant' ? !!bo.processRef : undefined,
        collapsed: (/SubProcess|Transaction/.test(type) && !(e.di && e.di.isExpanded)) || (type === 'Participant' && !bo.processRef) ? true : undefined,
        triggeredByEvent: bo.triggeredByEvent, label: lb(e), eventDefinition: summarizeEventDefinition(bo), jobType: td && td.type,
        loop: lc ? (lc.$type === 'bpmn:StandardLoopCharacteristics' ? 'loop' : lc.isSequential ? 'sequential' : 'parallel') : undefined,
        nonInterrupting: bo.cancelActivity === false || bo.isInterrupting === false,
        props: propsOf(c7, bo), process: type === 'Participant' ? processInfo(c7, bo.processRef) : undefined,
        state: bo.dataState && bo.dataState.name, collection: bo.dataObjectRef && bo.dataObjectRef.isCollection,
      }));
    });
    function topLanesParent(l) { return l.parent; }
    nodes.forEach(function (n) { if (n.collapsed) { n.expanded = false; delete n.collapsed; } });
    var lanes = nodes.filter(function (n) { return n.type === 'Lane'; }).sort(function (a, b) { return a.y - b.y; });
    nodes = nodes.filter(function (n) { return n.type !== 'Lane'; }).concat(lanes);
    nodes.forEach(function (g) {
      if (g.type !== 'Group') return;
      g.members = nodes.filter(function (n) { return n !== g && !/^(Participant|Lane|Group)$/.test(n.type) && centerIn(n, g); }).map(function (n) { return n.id; });
    });
    var rbo = root.businessObject;
    return {
      root: clean({ id: plane || root.id, type: short(rbo.$type), name: rbo.name, platform: c7 ? 'camunda7' : 'camunda8', process: rbo.$type === 'bpmn:Process' ? processInfo(c7, rbo) : plane ? processInfo(c7, enclosingProcess(rbo)) : undefined, plane: plane, planeName: plane ? rbo.name : undefined }),
      nodes: nodes, edges: edges, planes: plane ? undefined : subPlanes(inj),
    };
  }

  // ---------- Elemente anlegen ----------
  function freeSpot(inj, container, shape, lane) {
    var root = rootOf(inj), area = lane || container;
    var kids = shapesIn(container).filter(function (k) { return !isA(k, 'bpmn:Lane') && !isA(k, 'bpmn:Participant') && (!lane || centerIn(k, lane)); });
    var b = box(kids);
    if (container === root || !container.parent) return { x: b ? b.x + b.width + 80 + shape.width / 2 : 240, y: b ? kids[0].y + kids[0].height / 2 : 200 };
    return { x: b ? b.x + b.width + 80 + shape.width / 2 : area.x + 110 + shape.width / 2, y: area.y + area.height / 2 };
  }
  function resolveParent(inj, p) {
    var root = rootOf(inj);
    if (p.parent) {
      var c = container(inj, p.parent), lane = null;
      if (isA(c, 'bpmn:Lane')) { lane = c; while (isA(c, 'bpmn:Lane')) c = c.parent; }
      return { container: inner(inj, c), lane: lane, explicit: true };
    }
    if (p.after) return { container: el(inj, p.after).parent };
    if (isA(root, 'bpmn:Collaboration')) {
      var pools = shapesIn(root).filter(function (k) { return isA(k, 'bpmn:Participant') && k.businessObject.processRef; });
      if (!pools.length) throw new Error('Kein aufgeklappter Pool vorhanden – "parent" angeben.');
      return { container: pools[0] };
    }
    return { container: root };
  }

  function addParticipant(inj, p, bo) {
    var modeling = inj.get('modeling'), ef = inj.get('elementFactory'), root = rootOf(inj);
    var shape = ef.createParticipantShape(assign({ type: 'bpmn:Participant', businessObject: bo }, p.expanded === false ? { isExpanded: false } : {}));
    var kids = shapesIn(root), b = box(kids), pos;
    if (isA(root, 'bpmn:Process') && b) {
      shape.width = Math.max(shape.width, b.width + 160);
      shape.height = Math.max(shape.height, b.height + 120);
      pos = { x: b.x - 100 + shape.width / 2, y: b.y - 60 + shape.height / 2 };
    } else {
      if (b) shape.width = Math.max(shape.width, b.width);
      pos = { x: b ? b.x + shape.width / 2 : 500, y: b ? b.y + b.height + 70 + shape.height / 2 : 250 };
    }
    var created = modeling.createShape(shape, pos, root);
    var proc = created.businessObject.processRef;
    if (proc && p.processId && proc.id !== p.processId) {
      var ids = inj.get('moddle').ids;
      if (ids && ids.assigned(p.processId)) throw new Error('ID existiert schon: ' + p.processId);
      if (ids) { ids.unclaim(proc.id); ids.claim(p.processId, proc); }
      proc.id = p.processId;
    }
    if (proc && p.executable !== undefined) {
      proc.isExecutable = !!p.executable;
      if (isC7(inj)) {
        if (p.executable && !proc.get('camunda:historyTimeToLive')) proc.set('camunda:historyTimeToLive', '180');
        if (!p.executable) proc.set('camunda:historyTimeToLive', undefined);
      }
    }
    var lanes;
    if (p.lanes && p.lanes.length > 1 && p.expanded !== false) {
      modeling.splitLane(created, p.lanes.length);
      lanes = shapesIn(created).filter(function (k) { return isA(k, 'bpmn:Lane'); }).sort(function (a, c) { return a.y - c.y; });
      lanes.forEach(function (l, i) {
        var spec = p.lanes[i];
        if (!spec) return;
        modeling.updateProperties(l, typeof spec === 'string' ? { name: spec } : clean({ name: spec.name, id: spec.id }));
      });
    }
    return { created: created, extra: lanes ? { lanes: lanes.map(function (l) { return { id: l.id, name: l.businessObject.name }; }) } : {} };
  }

  function addLane(inj, p) {
    var modeling = inj.get('modeling');
    var target = container(inj, p.parent || p.after || '');
    if (!isA(target, 'bpmn:Participant') && !isA(target, 'bpmn:Lane')) throw new Error('Lane braucht "parent" = Pool oder Lane.');
    var lane = modeling.addLane(target, p.position === 'top' ? 'top' : 'bottom');
    if (p.name) modeling.updateProperties(lane, { name: p.name });
    if (p.id) modeling.updateProperties(lane, { id: p.id });
    var pool = lane;
    while (!isA(pool, 'bpmn:Participant')) pool = pool.parent;
    var lanes = shapesIn(pool).filter(function (k) { return isA(k, 'bpmn:Lane'); }).sort(function (a, c) { return a.y - c.y; });
    return { id: lane.id, lanes: lanes.map(function (l) { return clean({ id: l.id, name: l.businessObject.name }); }) };
  }

  function addElement(inj, p) {
    var type = TYPES[p.type];
    if (!type) throw new Error('Unbekannter Typ: ' + p.type);
    var reg = inj.get('elementRegistry'), modeling = inj.get('modeling'), ef = inj.get('elementFactory');
    if (p.id && reg.get(p.id)) throw new Error('ID existiert schon: ' + p.id);
    if (p.type === 'lane') return addLane(inj, p);
    // ID muss am Business-Objekt gesetzt werden, sonst landet sie nicht in der Datei.
    var bo = inj.get('bpmnFactory').create(type, p.id ? { id: p.id } : {});
    var attrs = assign({ type: type, businessObject: bo }, ATTRS[p.type]);
    if (p.expanded === false) attrs.isExpanded = false;
    if (p.type === 'boundaryEvent' && p.interrupting === false) attrs.cancelActivity = false;
    // Ereignistyp schon beim Anlegen setzen: sonst verbieten die BPMN-Regeln z. B. die Verbindung vom ereignisbasierten Gateway.
    if (p.eventDefinition && EVENT_DEF_TYPES[p.eventDefinition.type] && /Event$/.test(type)) attrs.eventDefinitionType = EVENT_DEF_TYPES[p.eventDefinition.type];
    var created, extra = {}, host = p.attachTo ? el(inj, p.attachTo) : null;

    if (p.type === 'participant') {
      var r = addParticipant(inj, p, bo);
      created = r.created; extra = r.extra;
    } else if (p.type === 'boundaryEvent') {
      if (!host) throw new Error('boundaryEvent braucht "attachTo" (ID der Aktivität).');
      var n = (host.attachers || []).length;
      created = modeling.createShape(ef.createShape(attrs), { x: host.x + host.width - 30 - n * 46, y: host.y + host.height }, host, { attach: true });
    } else if (/^(textAnnotation|dataObject|dataStore)$/.test(p.type)) {
      var shape = ef.createShape(attrs), par = host ? host.parent : resolveParent(inj, p).container;
      var pos = p.position || (host ? { x: host.x + host.width / 2 + (p.type === 'textAnnotation' ? 70 : 0), y: host.y - 60 } : freeSpot(inj, par, shape));
      created = modeling.createShape(shape, pos, par);
      if (host) {
        var c = p.direction === 'input' ? modeling.connect(created, host) : p.type === 'textAnnotation' ? modeling.connect(created, host, { type: 'bpmn:Association' }) : modeling.connect(host, created);
        if (c) extra.connection = c.id;
      }
    } else if (p.type === 'group') {
      var g = ef.createShape(attrs), around = (p.around || []).map(function (id) { return el(inj, id); });
      var gb = box(around.concat(around.map(function (a) { return a.label; }).filter(Boolean)));
      if (gb) { g.width = gb.width + 40; g.height = gb.height + 50; }
      created = modeling.createShape(g, gb ? { x: gb.x + gb.width / 2, y: gb.y + gb.height / 2 - 5 } : p.position || freeSpot(inj, rootOf(inj), g), around.length ? around[0].parent : resolveParent(inj, p).container);
    } else {
      var s = ef.createShape(attrs), where = resolveParent(inj, p), src = p.after ? el(inj, p.after) : null;
      if (src && !where.explicit && !p.position) {
        created = inj.get('autoPlace').append(src, s);
        if (!(created.incoming || []).some(function (c) { return c.source === src; })) {
          throw new Error('Verbindung von ' + p.after + ' zu einem ' + p.type + ' ist laut BPMN-Regeln nicht erlaubt' +
            (isA(src, 'bpmn:EventBasedGateway') ? ' (nach einem ereignisbasierten Gateway folgen nur eintretende Ereignisse mit eventDefinition oder receiveTask).' : '.'));
        }
      } else {
        // Hinter dem Vorgänger auf dessen Mittellinie, damit die Verbindung gerade ist (keine Mini-Stufen);
        // nur wenn der Vorgänger in einer anderen Lane liegt, auf die Mitte der Ziel-Lane.
        var inLane = function (l, e) { return l && e.y + e.height / 2 > l.y && e.y + e.height / 2 < l.y + l.height; };
        var at = p.position || (src
          ? { x: src.x + src.width + 80 + s.width / 2, y: where.lane && !inLane(where.lane, src) ? where.lane.y + where.lane.height / 2 : src.y + src.height / 2 }
          : freeSpot(inj, where.container, s, where.lane));
        created = modeling.createShape(s, at, where.lane || where.container);
        if (src) { var conn = modeling.connect(src, created); if (!conn) throw new Error('Verbindung von ' + p.after + ' laut BPMN-Regeln nicht erlaubt.'); }
      }
      if (src && p.flowName) {
        var inc = (created.incoming || []).filter(function (c) { return c.source === src; })[0];
        if (inc) modeling.updateProperties(inc, { name: p.flowName });
      }
    }
    var q = assign({}, p, { __created: true });
    delete q.type; delete q.newId;
    if (p.type === 'boundaryEvent') delete q.interrupting;
    applyUpdate(inj, created, q);
    try { if (topOf(created) === inj.get('canvas').getRootElement()) inj.get('canvas').scrollToElement(created); } catch (e) { /* egal */ }
    return assign({ id: created.id }, extra);
  }

  // SVG einer Ebene (plane = ID eines zugeklappten Teilprozesses), optional auf einen Ausschnitt zugeschnitten
  // (region = {x,y,width,height} oder ids = Elemente, um die herum ausgeschnitten wird).
  function svgOf(inj, p) {
    var canvas = inj.get('canvas'), before = canvas.getRootElement(), target = p.plane ? planeOf(inj, el(inj, p.plane)) : rootOf(inj);
    if (!target) return Promise.reject(new Error(p.plane + ' ist kein zugeklappter Teilprozess mit eigener Ebene.'));
    var crop = p.region;
    if (!crop && p.ids && p.ids.length) {
      var parts = [];
      p.ids.forEach(function (id) {
        var e = el(inj, id);
        if (e.waypoints) e.waypoints.forEach(function (q) { parts.push({ x: q.x, y: q.y, width: 0, height: 0 }); });
        else parts.push(e);
        if (e.label) parts.push(e.label);
      });
      var b = box(parts), m = p.margin !== undefined ? p.margin : 60;
      crop = { x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m };
    }
    if (target !== before) canvas.setRootElement(target);
    return inj.get('bpmnjs').saveSVG().then(function (r) {
      if (target !== before) canvas.setRootElement(before);
      var svg = r.svg;
      if (crop) {
        var vb = Math.round(crop.x) + ' ' + Math.round(crop.y) + ' ' + Math.round(crop.width) + ' ' + Math.round(crop.height);
        svg = svg.replace(/<svg([^>]*)>/, function (all, attrs) {
          attrs = attrs.replace(/\s(width|height|viewBox)="[^"]*"/g, '');
          return '<svg' + attrs + ' width="' + Math.round(crop.width) + '" height="' + Math.round(crop.height) + '" viewBox="' + vb + '">';
        });
      }
      return svg;
    }, function (err) { if (target !== before) canvas.setRootElement(before); throw err; });
  }

  function rasterize(svg, max) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(2, max / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.ceil(img.width * s); c.height = Math.ceil(img.height * s);
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve({ png: c.toDataURL('image/png').split(',')[1], width: c.width, height: c.height });
      };
      img.onerror = function () { reject(new Error('Diagramm konnte nicht gerendert werden.')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  // ---------- Befehle ----------
  var handlers = {
    status: function () {
      var inj = active();
      return {
        connected: true, plugin: VERSION, diagramOpen: !!inj,
        tab: activeTab && { name: activeTab.name, type: activeTab.type, path: activeTab.file && activeTab.file.path },
      };
    },

    graph: function (p) { return graph(need(), p); },

    addElement: function (p) { return addElement(need(), p); },

    connect: function (p) {
      var inj = need(), s = el(inj, p.source), t = el(inj, p.target), modeling = inj.get('modeling');
      var allowed = inj.get('bpmnRules').canConnect(s, t);
      var attrs = p.type === 'association' ? { type: CONNECTIONS.association } : allowed;
      if (!attrs) throw new Error('Verbindung ' + p.source + ' → ' + p.target + ' ist laut BPMN-Regeln nicht erlaubt.');
      if (p.type && p.type !== 'association' && attrs.type !== CONNECTIONS[p.type]) {
        throw new Error('Zwischen diesen Elementen ist kein ' + p.type + '-Fluss erlaubt, sondern ' + short(attrs.type) + '.');
      }
      if (p.condition && /EventBasedGateway|ParallelGateway/.test(s.businessObject.$type)) throw new Error(short(s.businessObject.$type) + ' hat keine Bedingungen an seinen Ausgängen.');
      var conn = modeling.connect(s, t, attrs);
      if (!conn) throw new Error('Verbindung konnte nicht angelegt werden.');
      applyUpdate(inj, conn, { name: p.name, condition: p.condition || undefined, isDefault: p.isDefault || undefined, color: p.color });
      return { id: conn.id, type: short(conn.businessObject.$type) };
    },

    update: function (p) {
      var inj = need();
      return { id: applyUpdate(inj, el(inj, p.id), p).id };
    },

    remove: function (p) {
      var inj = need(), ids = p.ids || [p.id];
      inj.get('modeling').removeElements(ids.map(function (id) { return el(inj, id); }));
      return { removed: ids };
    },

    arrange: function (p) {
      var inj = need(), modeling = inj.get('modeling');
      var list = (p.ids || (p.id ? [p.id] : [])).map(function (id) { return el(inj, id); });
      if (!list.length) throw new Error('"id" oder "ids" fehlt.');
      var e = list[0];
      if (p.action === 'move') {
        var d = p.x !== undefined || p.y !== undefined
          ? { x: p.x !== undefined ? p.x - e.x : 0, y: p.y !== undefined ? p.y - e.y : 0 }
          : { x: p.dx || 0, y: p.dy || 0 };
        modeling.moveElements(list, d, p.parent ? inner(inj, container(inj, p.parent)) : undefined);
      } else if (p.action === 'resize') {
        modeling.resizeShape(e, { x: p.x !== undefined ? p.x : e.x, y: p.y !== undefined ? p.y : e.y, width: p.width || e.width, height: p.height || e.height });
      } else if (p.action === 'waypoints') {
        if (!e.waypoints) throw new Error(e.id + ' ist keine Verbindung.');
        if (p.waypoints && p.waypoints.length > 1) modeling.updateWaypoints(e, p.waypoints); else modeling.layoutConnection(e);
      } else if (p.action === 'label') {
        if (!e.label) throw new Error(e.id + ' hat keine frei platzierbare Beschriftung.');
        modeling.moveShape(e.label, { x: p.x - e.label.x, y: p.y - e.label.y });
      } else if (p.action === 'align') {
        inj.get('alignElements').trigger(list, p.to || 'middle');
      } else if (p.action === 'distribute') {
        inj.get('distributeElements').trigger(list, p.axis || 'horizontal');
      } else throw new Error('Unbekannte Aktion: ' + p.action);
      return { ok: true };
    },

    applyLayout: function (p) {
      var inj = need();
      var ctx = { after: { shapes: p.shapes || {}, labels: p.labels || {}, edges: p.edges || {} } };
      commandStack(inj).execute('mcp.applyLayout', ctx);
      try { inj.get('canvas').zoom('fit-viewport', 'auto'); } catch (e) { /* egal */ }
      return ctx.count;
    },

    screenshot: function (p) {
      return svgOf(need(), p).then(function (svg) { return rasterize(svg, p.maxSize || 2000); });
    },

    svg: function (p) {
      return svgOf(need(), p || {}).then(function (svg) { return { svg: svg }; });
    },

    planes: function () { return subPlanes(need()); },

    xml: function () {
      return need().get('bpmnjs').saveXML({ format: true }).then(function (r) { return { xml: r.xml }; });
    },

    batch: function (p) {
      var results = [], i = 0;
      var names = { add: 'addElement', connect: 'connect', update: 'update', remove: 'remove', arrange: 'arrange' };
      return (p.operations || []).reduce(function (chain, op) {
        return chain.then(function () {
          var h = handlers[names[op.op]];
          if (!h) throw new Error('Unbekannte Operation: ' + op.op);
          return Promise.resolve(atomic(names[op.op], h, op)).then(function (r) { results.push(r); i++; });
        });
      }, Promise.resolve()).then(function () { return { results: results }; }, function (err) {
        throw new Error('Schritt ' + (i + 1) + ' (' + JSON.stringify(p.operations[i]) + ') fehlgeschlagen: ' + ((err && err.message) || err) + ' – ' + i + ' Schritte davor wurden ausgeführt.');
      });
    },

    undo: function () { need().get('commandStack').undo(); return {}; },
    redo: function () { need().get('commandStack').redo(); return {}; },

    save: function () {
      if (!api.triggerAction) throw new Error('Speichern nicht verfügbar.');
      return Promise.resolve(api.triggerAction('save')).then(function () { return { saved: true }; });
    },
  };

  // Schlägt ein ändernder Befehl mittendrin fehl, werden seine Teilschritte zurückgenommen.
  var MUTATING = { addElement: 1, connect: 1, update: 1, remove: 1, arrange: 1 };
  function atomic(method, h, params) {
    if (!MUTATING[method]) return h(params);
    var cs = need().get('commandStack'), before = cs._stackIdx;
    try { return h(params); } catch (err) {
      for (var n = 0; typeof before === 'number' && cs._stackIdx > before && n < 200; n++) cs.undo();
      throw err;
    }
  }

  // Direkter Zugang ohne WebSocket: der Datei-Modus (headless.js) ruft die Befehle so auf.
  window.__bpmnMcp = { call: function (method, params) { return atomic(method, handlers[method], params || {}); } };

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
          .then(function () { if (!h) throw new Error('Unbekannte Methode: ' + msg.method + ' (Plugin veraltet? install-plugin.sh ausführen und Modeler neu starten)'); return atomic(msg.method, h, msg.params || {}); })
          .then(function (result) { ws.send(JSON.stringify({ id: msg.id, result: result })); },
                function (err) { ws.send(JSON.stringify({ id: msg.id, error: String((err && err.message) || err) })); });
      };
      ws.onclose = function () { setTimeout(connect, 3000); };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* egal */ } };
    }
    connect();
  }
})();
