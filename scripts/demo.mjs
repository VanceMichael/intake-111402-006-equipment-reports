import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {runOnce} from '../src/main.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';
import {createState} from '../src/state.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const state = createState(directory);
const api = await createApi(archive, 0, {state});
try {
  console.log('本地来源', source.origin);
  const first = await runOnce({client:createClient(source.origin), archive, state, source:source.origin});
  console.log('首次采集', JSON.stringify({
    outcome:first.outcome,
    archived:first.archived,
    acknowledgement:first.acknowledgement
  }));

  const second = await runOnce({client:createClient(source.origin), archive, state, source:source.origin});
  console.log('再次采集', JSON.stringify({outcome:second.outcome, archived:second.archived}));

  const failure = await runOnce({
    client:async path => {const error = new Error('simulated source failure');error.status = 503;throw error;},
    archive, state, source:source.origin
  });
  console.log('来源故障', JSON.stringify({outcome:failure.outcome, cursor:(await state.read()).cursor}));

  const records = await (await fetch(`${api.origin}/records/find?kind=event`)).json();
  for (const entry of records) {
    const trace = await (await fetch(`${api.origin}/trace/${encodeURIComponent(entry.row.deliveryId)}`)).json();
    console.log('事件追踪', JSON.stringify({
      deliveryId:entry.row.deliveryId,
      state:trace[0].state,
      bindingBasis:trace[0].bindingBasis,
      fields:entry.row.fields,
      reasons:entry.row.reasons,
      acknowledgement:trace[0].acknowledgement.map(row => ({accepted:row.accepted}))
    }));
  }
  console.log('采集游标', JSON.stringify(await state.read()));
} finally {
  await Promise.all([source.close(),api.close()]);
  await rm(directory,{recursive:true,force:true});
}
