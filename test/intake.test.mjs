import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectReports, acknowledge} from '../src/intake.mjs';
import {runOnce} from '../src/main.mjs';
import {Archive} from '../src/archive.mjs';
import {createState} from '../src/state.mjs';
import {createApi} from '../src/api.mjs';
import {resolveEvent} from '../src/reader.mjs';

const temp = () => mkdtemp(join(tmpdir(),'intake-'));

function fakeClient(routes) {
  const calls = [];
  const client = async (path, request = {}) => {
    calls.push({path, method:request.method ?? 'GET', body:request.body ?? null});
    const key = `${request.method ?? 'GET'} ${path}`;
    const value = routes[key];
    if (value === undefined) {
      const error = new Error(`not found ${key}`);
      error.status = 404;
      throw error;
    }
    return typeof value === 'function' ? value() : structuredClone(value);
  };
  return {client, calls};
}

const binding = (version, reports, links) => ({bindingVersion:version, reports, links});

test('一次采集同时记录通信、定义、事件与设备确认',async () => {
  const source = await createSource();
  const directory = await temp();
  try {
    const client = createClient(source.origin);
    const archive = new Archive(directory);
    const state = createState(directory);
    const result = await runOnce({client, archive, state, source:source.origin});

    assert.equal(result.outcome,'events-understood');
    assert.equal(result.acknowledgement.requested,1);
    assert.equal(result.acknowledgement.accepted,1);

    const rows = (await archive.list()).map(entry => entry.row);
    const kinds = new Set(rows.map(row => row.kind));
    for (const kind of ['intake-run','communication','binding','event-page','event','acknowledgement']) {
      assert.ok(kinds.has(kind), `missing ${kind}`);
    }

    const event = rows.find(row => row.kind === 'event');
    assert.equal(event.status,'understood');
    assert.deepEqual(event.fields, [
      {vid:'lot', value:{type:'A', value:'LOT-A'}},
      {vid:'reason', value:{type:'U1', value:7}}
    ]);
    // The typed list is carried through, not stringified.
    assert.equal(event.raw.typedValues[1].type,'U1');
    assert.equal(event.raw.typedValues[1].value,7);

    const acknowledgement = rows.find(row => row.kind === 'acknowledgement');
    assert.equal(acknowledgement.accepted,true);
    // Device acknowledgement is a separate observation; the event itself was
    // already received and archived before the ack was requested.
    assert.equal(event.acknowledgement,undefined);

    const stateFile = await state.read();
    assert.equal(stateFile.cursor,1);
    assert.equal(stateFile.communicationEpoch,'e1');
    assert.equal(stateFile.bindingVersion,'b1');
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('未领取前重复轮询不重复收件，游标只在归档成功后推进',async () => {
  const source = await createSource();
  const directory = await temp();
  try {
    const client = createClient(source.origin);
    const archive = new Archive(directory);
    const state = createState(directory);
    const first = await runOnce({client, archive, state, source:source.origin});
    const second = await runOnce({client, archive, state, source:source.origin});
    assert.equal(first.archived.added,5);
    assert.equal(second.archived.added,2); // only run row + empty event page
    const events = (await archive.list()).filter(entry => entry.row.kind === 'event');
    assert.equal(events.length,1);
    assert.equal((await state.read()).cursor,1);
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('换配方后按事件自带绑定解释，不沿用当前目录',async () => {
  const source = await createSource({scenario:'relinked'});
  try {
    const client = createClient(source.origin);
    const result = await collectReports(client,{source:source.origin});
    const event = result.eventRows[0];
    assert.equal(event.bindingVersion,'b2');
    assert.equal(event.interpretation.bindingVersion,'b2');
    assert.deepEqual(event.fields, [
      {vid:'recipe', value:{type:'A', value:'R2'}},
      {vid:'pressure', value:{type:'F4', value:1.2}}
    ]);
    // The list value is not flattened into a string.
    assert.deepEqual(event.values[1],{type:'F4',value:1.2});
  } finally {
    await source.close();
  }
});

test('事件指向已失效的历史绑定时留待核对，不猜测',async () => {
  const {client} = fakeClient({
    'POST /establish':{communicationEpoch:'e9'},
    'GET /reports':binding('b9',[{reportId:10,vids:['recipe','pressure']}],[{ceid:20,reportIds:[10]}]),
    'GET /links':binding('b9',[{reportId:10,vids:['recipe','pressure']}],[{ceid:20,reportIds:[10]}]),
    'GET /events?after=0':{items:[{
      deliveryId:'d-old',DATAID:4,CEID:20,RPTID:10,
      typedValues:[{type:'A',value:'R1'},{type:'F4',value:9.5}],
      bindingVersion:'b1',communicationEpoch:'e1'
    }],next:5}
  });
  // /bindings/b1 is deliberately absent.
  const result = await collectReports(client,{source:'fake'});
  const event = result.eventRows[0];
  assert.equal(event.status,'pending-review');
  assert.equal(event.fields,null);
  assert.equal(event.report,null);
  assert.equal(event.reasons[0].code,'binding-history-unavailable');
  // Raw evidence survives even though interpretation did not.
  assert.equal(event.raw.typedValues[1].value,9.5);
  assert.equal(event.raw.typedValues[1].type,'F4');
});

test('历史绑定可得时用它解释旧事件',async () => {
  const historical = binding('b1',[{reportId:10,vids:['lot','reason']}],[{ceid:20,reportIds:[10]}]);
  const {client, calls} = fakeClient({
    'POST /establish':{communicationEpoch:'e2'},
    'GET /reports':binding('b2',[{reportId:10,vids:['recipe','pressure']}],[{ceid:20,reportIds:[10]}]),
    'GET /links':binding('b2',[{reportId:10,vids:['recipe','pressure']}],[{ceid:20,reportIds:[10]}]),
    'GET /events?after=0':{items:[{
      deliveryId:'d-old',DATAID:4,CEID:20,RPTID:10,
      typedValues:[{type:'A',value:'LOT-A'},{type:'U1',value:7}],
      bindingVersion:'b1',communicationEpoch:'e1'
    }],next:5},
    'GET /bindings/b1':historical
  });
  const result = await collectReports(client,{source:'fake'});
  const event = result.eventRows[0];
  assert.equal(event.status,'understood');
  assert.equal(event.interpretation.bindingOrigin,'history');
  assert.deepEqual(event.fields, [
    {vid:'lot', value:{type:'A', value:'LOT-A'}},
    {vid:'reason', value:{type:'U1', value:7}}
  ]);
  assert.ok(calls.some(call => call.path === '/bindings/b1'));
});

test('同一版本号出现不同定义时冲突留待核对',async () => {
  let calls = 0;
  const {client} = fakeClient({
    'POST /establish':{communicationEpoch:'e1'},
    'GET /reports':() => (++calls === 1
      ? binding('b1',[{reportId:10,vids:['lot','reason']}],[{ceid:20,reportIds:[10]}])
      : binding('b1',[{reportId:10,vids:['recipe','pressure']}],[{ceid:20,reportIds:[10]}])),
    'GET /links':binding('b1',[{ceid:20,reportIds:[10]}],[{ceid:20,reportIds:[10]}]),
    'GET /events?after=0':{items:[{
      deliveryId:'d1',DATAID:1,CEID:20,RPTID:10,
      typedValues:[{type:'A',value:'X'},{type:'A',value:'Y'}],
      bindingVersion:'b1',communicationEpoch:'e1'
    }],next:1}
  });
  // First pass records the definition that belongs to b1.
  const first = await collectReports(client,{source:'fake',knownBindings:{}});
  assert.equal(first.eventRows[0].status,'understood');
  // Second pass sees the same label with a different definition.
  const second = await collectReports(client,{source:'fake',knownBindings:first.bindingsSeen});
  assert.equal(second.eventRows[0].status,'pending-review');
  assert.ok(second.eventRows[0].reasons.some(reason => reason.code === 'binding-version-conflict'));
  assert.equal(second.eventRows[0].fields,null);
});

test('未知报告或值数量不符时保留原因和原件',async () => {
  const snapshot = {
    bindingVersion:'b1',origin:'active',usable:true,problems:[],
    reports:[{reportId:10,vids:['lot'],valid:true}],
    links:[{ceid:20,reportIds:[10],valid:true}]
  };
  const unknown = resolveEvent({deliveryId:'d1',DATAID:1,CEID:20,RPTID:99,
    typedValues:[{type:'A',value:'x'}]},snapshot);
  assert.equal(unknown.status,'pending-review');
  assert.ok(unknown.reasons.some(reason => reason.code === 'report-not-defined'));

  const wrongCount = resolveEvent({deliveryId:'d2',DATAID:2,CEID:20,RPTID:10,
    typedValues:[{type:'A',value:'x'},{type:'A',value:'y'}]},snapshot);
  assert.equal(wrongCount.status,'pending-review');
  assert.ok(wrongCount.reasons.some(reason => reason.code === 'value-count-mismatch'));
  assert.equal(wrongCount.fields,null);
});

test('列表与嵌套列表保留类型结构',async () => {
  const snapshot = {
    bindingVersion:'b1',origin:'active',usable:true,problems:[],
    reports:[{reportId:10,vids:['lots'],valid:true}],
    links:[{ceid:20,reportIds:[10],valid:true}]
  };
  const value = {type:'L',value:[
    {type:'A',value:'LOT-A'},
    {type:'L',value:[{type:'U1',value:7},{type:'F4',value:1.25}]}
  ]};
  const resolution = resolveEvent({deliveryId:'d1',DATAID:1,CEID:20,RPTID:10,
    typedValues:[value]},snapshot);
  assert.equal(resolution.status,'understood');
  assert.deepEqual(resolution.fields[0].value,value);
  assert.equal(typeof resolution.fields[0].value.value[1].value[0].value,'number');

  const unsupported = resolveEvent({deliveryId:'d2',DATAID:2,CEID:20,RPTID:10,
    typedValues:[{type:'L',value:[{type:'X',value:1}]}]},snapshot);
  assert.equal(unsupported.status,'pending-review');
  assert.ok(unsupported.reasons.some(reason => reason.code === 'value-type-unsupported'));
});

test('设备确认被拒或失败都不改变本地已收事件',async () => {
  const source = await createSource();
  const directory = await temp();
  try {
    const realClient = createClient(source.origin);
    const archive = new Archive(directory);
    const result = await collectReports(realClient,{source:source.origin});
    await archive.reconcile(result.rows,{source:source.origin});

    const refused = async path => path === '/event-ack' ? {accepted:false} : Promise.reject(new Error('unexpected'));
    const [row] = await acknowledge(refused,result.eventRows,{source:source.origin});
    assert.equal(row.requested,true);
    assert.equal(row.accepted,false);
    assert.deepEqual(row.response,{accepted:false});
    assert.equal(row.deliveryId,'d1');

    const failing = async () => {throw new Error('gateway down');};
    const [failed] = await acknowledge(failing,result.eventRows,{source:source.origin});
    assert.equal(failed.accepted,false);
    assert.match(failed.error.message,/gateway down/);

    // The stored event is unchanged by either acknowledgement outcome.
    const stored = (await archive.list()).filter(entry => entry.row.kind === 'event');
    assert.equal(stored.length,1);
    assert.equal(stored[0].row.status,'understood');
    assert.equal(stored[0].row.raw.deliveryId,'d1');
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('追踪区分设备未发送与接入端未理解',async () => {
  const directory = await temp();
  const source = await createSource();
  try {
    const archive = new Archive(directory);
    const state = createState(directory);
    await runOnce({client:createClient(source.origin), archive, state, source:source.origin});
    const rows = (await archive.list()).map(entry => entry.row);
    const event = rows.find(row => row.kind === 'event');
    const api = await createApi(archive,0,{state});
    try {
      const found = await (await fetch(`${api.origin}/trace/${event.deliveryId}`)).json();
      assert.equal(found[0].state,'interpreted');
      assert.equal(found[0].bindingBasis.used,'b1');
      assert.equal(found[0].bindingBasis.eventDeclared,'b1');
      assert.equal(found[0].acknowledgement[0].accepted,true);
      assert.deepEqual(found[0].event.fields,event.fields);

      const missing = await (await fetch(`${api.origin}/trace/DATAID-999`)).json();
      assert.equal(missing[0].state,'not-delivered');
      assert.ok(missing[0].eventPages.length >= 1);
    } finally {await api.close();}
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});
