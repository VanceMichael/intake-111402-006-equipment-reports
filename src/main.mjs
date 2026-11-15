import {pathToFileURL} from 'node:url';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collectReports, acknowledge} from './intake.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';
import {createState} from './state.mjs';

export async function runOnce({client, archive, state, source = null}) {
  const previous = await state.read();
  const result = await collectReports(client, {
    source,
    after:previous.cursor ?? 0,
    cursorEpoch:previous.cursorEpoch ?? null,
    knownBindings:previous.bindings ?? {}
  });

  // Events and their definitions are written first.  The cursor only advances
  // after that write succeeds, so a crash cannot silently skip an event.
  // Gateway acknowledgement is requested afterwards and is a separate
  // observation; it is never a precondition for local receipt, and its failure
  // does not roll back the cursor.
  let write;
  try {
    write = await archive.reconcile(result.rows, {source, adapter:'reports'});
  } catch (error) {
    await state.write({...previous, lastAttempt:{at:new Date().toISOString(), outcome:'archive-failed', error:error.message}});
    return {...result, archived:null, acknowledgement:null, archiveError:error.message};
  }

  let acknowledgement = null;
  if (result.eventRows?.length) {
    const ackRows = await acknowledge(client, result.eventRows, {source});
    acknowledgement = {
      requested:ackRows.length,
      accepted:ackRows.filter(row => row.accepted).length,
      refused:ackRows.filter(row => row.requested && !row.accepted).length
    };
    try {
      await archive.reconcile(ackRows, {source, adapter:'reports'});
    } catch (error) {
      acknowledgement.archiveError = error.message;
    }
  }

  const next = result.next === null ? previous.cursor ?? 0 : result.next;
  const communication = result.rows.find(row => row.kind === 'communication' && row.established);
  await state.write({
    ...previous,
    cursor:next,
    cursorEpoch:result.cursorEpoch ?? previous.cursorEpoch ?? null,
    // Remembering which definition went with each version label lets the next
    // pass flag "same version, different definition" instead of trusting it.
    bindings:{...(previous.bindings ?? {}), ...result.bindingsSeen},
    communicationEpoch:communication?.communicationEpoch ?? previous.communicationEpoch ?? null,
    bindingVersion:result.snapshot?.bindingVersion ?? previous.bindingVersion ?? null,
    lastAttempt:{
      at:new Date().toISOString(),
      outcome:watchOutcome(result),
      archived:write.added,
      acknowledgement
    }
  });
  return {...result, archived:write, acknowledgement};
}

export function watchOutcome(result) {
  if (result.error) return result.outcome;
  if (!result.eventRows?.length) return result.outcome;
  const pending = result.eventRows.filter(row => row.status !== 'understood').length;
  return pending ? `events-understood:${result.eventRows.length - pending},pending-review:${pending}` : 'events-understood';
}

export function delay(milliseconds, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {clearTimeout(timer);signal?.removeEventListener('abort', done);resolve();}
    signal?.addEventListener('abort', done, {once:true});
  });
}

export async function watch({client, archive, state, interval = 1000, source = null, signal = null}) {
  let stopped = false;
  const stop = () => {stopped = true;};
  signal?.addEventListener('abort', stop, {once:true});
  try {
    while (!stopped) {
      try {
        await runOnce({client, archive, state, source});
      } catch (error) {
        // A transient source or archive error is recorded on the state file,
        // not thrown away; the next pass retries from the same cursor.
        const previous = await state.read().catch(() => ({}));
        await state.write({...previous, lastAttempt:{at:new Date().toISOString(), outcome:'error', error:error.message}}).catch(() => {});
      }
      if (stopped) break;
      await delay(interval, signal);
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  return {stopped:true};
}

async function main() {
  const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
  const dataDirectory = process.env.DATA_DIR ?? '.state';
  const archive = new Archive(dataDirectory);
  const state = createState(dataDirectory);
  const api = await createApi(archive, Number(process.env.PORT ?? 4020), {state});
  const client = createClient(source.origin);
  console.log(JSON.stringify({source:source.origin,api:api.origin}));

  const controller = new AbortController();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    await Promise.all([source.close(),api.close()]);
  };
  process.on('SIGINT',stop);process.on('SIGTERM',stop);

  try {
    await watch({
      client, archive, state, source:source.origin,
      interval:Number(process.env.POLL_MS ?? 1000),
      signal:controller.signal
    });
  } finally {
    await stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
