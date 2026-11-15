import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectReports} from '../src/intake.mjs';
import {Archive} from '../src/archive.mjs';
import {createState} from '../src/state.mjs';
import {runOnce} from '../src/main.mjs';
import {createApi} from '../src/api.mjs';

const temp = () => mkdtemp(join(tmpdir(),'intake-edge-'));

function fakeClient(routes) {
  const calls = [];
  const client = async (path, request = {}) => {
    const key = `${request.method ?? 'GET'} ${path}`;
    calls.push(key);
    if (!Object.hasOwn(routes,key)) {const error = new Error(`not found ${key}`);error.status = 404;throw error;}
    const value = routes[key];
    return typeof value === 'function' ? value() : structuredClone(value);
  };
  return {client, calls};
}

const binding = (version, reports, links) => ({bindingVersion:version, reports, links});
const base = {
  'POST /establish':{communicationEpoch:'e1'},
  'GET /reports':binding('b1',[{reportId:10,vids:['lot','reason']}],[{ceid:20,reportIds:[10]}]),
  'GET /links':{bindingVersion:'b1',links:[{ceid:20,reportIds:[10]}]}
};

test('通信未建立时保留失败证据且不读取报告',async () => {
  const {client, calls} = fakeClient({
    'POST /establish':() => {const error = new Error('gateway down');error.status = 503;throw error;}
  });
  const result = await collectReports(client,{source:'fake',after:0});
  assert.equal(result.outcome,'establish-failed');
  assert.equal(result.next,null);
  const communication = result.rows.find(row => row.kind === 'communication');
  assert.equal(communication.established,false);
  assert.equal(communication.error.status,503);
  assert.equal(calls.some(call => call.includes('/reports')),false);
});

test('报告定义不可读时事件留待核对，仍保留原始事件',async () => {
  const {client} = fakeClient({
    ...base,
    'GET /reports':() => {const error = new Error('source state precondition');error.status = 409;throw error;},
    'GET /events?after=0':{items:[{
      deliveryId:'d1',DATAID:1,CEID:20,RPTID:10,
      typedValues:[{type:'A',value:'LOT-A'},{type:'U1',value:7}],
      bindingVersion:'b1',communicationEpoch:'e1'
    }],next:1},
    'GET /bindings/b1':() => {const error = new Error('not found');error.status = 404;throw error;}
  });
  const result = await collectReports(client,{source:'fake'});
  const event = result.eventRows[0];
  assert.equal(event.status,'pending-review');
  assert.ok(event.reasons.some(reason => reason.code === 'binding-history-unavailable'));
  assert.equal(event.raw.typedValues[1].type,'U1');
  const unavailable = result.rows.find(row => row.kind === 'binding');
  assert.equal(unavailable.usable,false);
  assert.equal(unavailable.problems[0].code,'binding-unavailable');
});

test('事件页读取失败不推进游标且记录失败页',async () => {
  const source = await createSource();
  const directory = await temp();
  const state = createState(directory);
  try {
    const archive = new Archive(directory);
    const working = createClient(source.origin);
    // A client that succeeds except for the events page.
    const flaky = async (path, request = {}) => {
      if (path.startsWith('/events')) {const error = new Error('events unavailable');error.status = 503;throw error;}
      return working(path, request);
    };
    const result = await runOnce({client:flaky, archive, state, source:source.origin});
    assert.equal(result.outcome,'events-failed');
    assert.equal((await state.read()).cursor ?? 0,0);
    const pages = (await archive.list()).filter(entry => entry.row.kind === 'event-page');
    assert.equal(pages.length,1);
    assert.equal(pages[0].row.error.status,503);
    assert.equal(pages[0].row.received,0);
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('重连换 epoch 时从头重读而不会漏掉新编号的事件',async () => {
  let epoch = 'e1';
  let events = {items:[{deliveryId:'d1',DATAID:1,CEID:20,RPTID:10,
    typedValues:[{type:'A',value:'LOT-A'},{type:'U1',value:7}],
    bindingVersion:'b1',communicationEpoch:'e1'}],next:1};
  const {client} = fakeClient({
    'POST /establish':() => ({communicationEpoch:epoch}),
    'GET /reports':binding('b1',[{reportId:10,vids:['lot','reason']}],[{ceid:20,reportIds:[10]}]),
    'GET /links':{bindingVersion:'b1',links:[{ceid:20,reportIds:[10]}]},
    'GET /events?after=0':() => events,
    'GET /events?after=1':() => events
  });
  const first = await collectReports(client,{source:'fake',after:0,cursorEpoch:'e1'});
  assert.equal(first.eventRows.length,1);
  // Reconnect: new epoch, DATAID numbering restarts at 1.
  epoch = 'e2';
  events = {items:[{deliveryId:'d2',DATAID:1,CEID:20,RPTID:10,
    typedValues:[{type:'A',value:'LOT-B'},{type:'U1',value:9}],
    bindingVersion:'b1',communicationEpoch:'e2'}],next:1};
  const second = await collectReports(client,{
    source:'fake',after:first.next,cursorEpoch:first.cursorEpoch
  });
  assert.equal(second.eventRows.length,1);
  assert.equal(second.eventRows[0].deliveryId,'d2');
  assert.equal(second.eventRows[0].status,'understood');
  const page = second.rows.find(row => row.kind === 'event-page');
  assert.equal(page.cursorReset,true);
  assert.equal(page.after,0);
});

test('缓存定义不因同版本号的新内容而漂移',async () => {
  let definition = binding('b1',[{reportId:10,vids:['lot','reason']}],[{ceid:20,reportIds:[10]}]);
  const {client} = fakeClient({
    'POST /establish':{communicationEpoch:'e1'},
    'GET /reports':() => definition,
    'GET /links':() => ({bindingVersion:'b1',links:definition.links}),
    'GET /events?after=0':{items:[],next:0}
  });
  const first = await collectReports(client,{source:'fake',knownBindings:{}});
  const known = first.bindingsSeen;
  definition = binding('b1',[{reportId:10,vids:['recipe','pressure']}],[{ceid:20,reportIds:[10]}]);
  const second = await collectReports(client,{source:'fake',knownBindings:known});
  const third = await collectReports(client,{source:'fake',knownBindings:second.bindingsSeen});
  assert.deepEqual(second.bindingsSeen,known);
  assert.deepEqual(third.bindingsSeen,known);
});

test('追踪把失败轮询与确认分开呈现',async () => {
  const source = await createSource();
  const directory = await temp();
  try {
    const archive = new Archive(directory);
    const state = createState(directory);
    await runOnce({client:createClient(source.origin),archive,state,source:source.origin});
    const api = await createApi(archive,0,{state});
    try {
      const records = await (await fetch(`${api.origin}/records/find?kind=event`)).json();
      assert.equal(records.length,1);
      const trace = await (await fetch(`${api.origin}/trace/${records[0].row.id}`)).json();
      assert.equal(trace[0].state,'interpreted');
      assert.equal(trace[0].binding[0].definitionDigest.length,64);
      assert.equal(trace[0].acknowledgement[0].requested,true);
      assert.equal(trace[0].acknowledgement[0].accepted,true);

      const unknown = await (await fetch(`${api.origin}/trace/no-such-delivery`)).json();
      assert.equal(unknown[0].state,'not-delivered');
      assert.ok(unknown[0].explanation.length > 0);
    } finally {await api.close();}
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});
