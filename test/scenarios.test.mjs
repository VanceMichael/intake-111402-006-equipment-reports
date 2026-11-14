import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('relinked');
await assert.rejects(client('/reports'),error => error.status === 409);
assert.equal((await client('/establish',{method:'POST',body:{}})).communicationEpoch,'e2');
const reports = await client('/reports');
const event = (await client('/events?after=0')).items[0];
assert.equal(reports.reports[0].reportId,event.RPTID);
assert.equal(event.communicationEpoch,'e2');
assert.equal(reports.reports[0].vids[0],'recipe');
} finally {await source.close();}
});
