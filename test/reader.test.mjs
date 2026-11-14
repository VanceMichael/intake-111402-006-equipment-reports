import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect,typed} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('状态读数保留设备类型', async () => {
  assert.deepEqual((await collect(client))[0].state, {type:'U1',value:3});
  assert.deepEqual(typed({type:'L',value:[{type:'A',value:'x'}]}).value[0].type, 'A');
  await assert.rejects(client('/reports'), /409/);
});
