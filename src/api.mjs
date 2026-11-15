import {createServer} from 'node:http';

const send = (response,status,body) => {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(body,null,2));
};

const segments = path => path.split('/').filter(Boolean);

const matches = (path, pattern) => {
  const actual = segments(path);
  const expected = segments(pattern);
  return actual.length === expected.length &&
    expected.every((part, index) => part.startsWith(':') || part === actual[index]);
};

const param = (path, name) => {
  const parts = segments(path);
  return parts[name];
};

const filterRecords = (records, query) => records.filter(entry => {
  const kind = query.get('kind');
  const status = query.get('status');
  const id = query.get('id');
  if (kind && entry.row?.kind !== kind) return false;
  if (id && entry.row?.id !== id) return false;
  if (status && entry.row?.status !== status) return false;
  return true;
});

const sameId = (left, right) => left !== null && left !== undefined && right !== null && right !== undefined &&
  String(left) === String(right);

export async function createApi(archive, port = 0, options = {}) {
  const state = options.state ?? null;
  const server = createServer(async (request,response) => {
    try {
      if (request.method !== 'GET') return send(response,404,{error:'not found'});
      const url = new URL(request.url,'http://127.0.0.1');
      const path = url.pathname;
      if (path === '/health') return send(response,200,{status:'ok'});
      if (path === '/records') return send(response,200,await archive.list());
      if (path === '/collector') {
        return send(response,200,state ? await state.read() : {error:'state not configured'});
      }
      if (path === '/records/find') {
        return send(response,200,filterRecords(await archive.list(),url.searchParams));
      }
      if (matches(path,'/records/:id')) {
        const id = decodeURIComponent(param(path,1));
        const found = (await archive.list()).filter(entry => entry.row?.id === id);
        return found.length ? send(response,200,found) : send(response,404,{error:'unknown record'});
      }
      // Answer the question that matters during a stoppage: for one delivery,
      // show the raw item, the binding snapshot used to read it, why that
      // snapshot was chosen, and whether the gateway acknowledged delivery.
      if (matches(path,'/trace/:eventId')) {
        return send(response,200,await trace(await archive.list(),decodeURIComponent(param(path,1))));
      }
      return send(response,404,{error:'not found'});
    } catch(error) {return send(response,500,{error:error.message});}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}

/**
 * Reconstruct one event's evidence.  The lookup key may be the archive record
 * id, the gateway deliveryId, or (when investigating "did the equipment ever
 * send this?") a DATAID.  A miss is reported as not-delivered together with
 * the event pages that were polled, which separates "equipment never sent it"
 * from "equipment sent it and the adapter could not interpret it".
 */
export async function trace(records, key) {
  const events = records.filter(entry => entry.row?.kind === 'event' && (
    entry.row.id === key ||
    sameId(entry.row.deliveryId, key) ||
    sameId(entry.row.DATAID, key)));
  const pages = records.filter(entry => entry.row?.kind === 'event-page');

  if (!events.length) {
    // No event row can mean three different things.  Keeping them apart is the
    // whole point of the trace: a failed poll is not evidence of absence.
    const failed = pages.filter(entry => entry.row.error);
    const state = failed.length ? 'delivery-unknown'
      : pages.length ? 'not-delivered'
      : 'not-observed';
    return [{
      lookup:key,
      state,
      explanation:state === 'delivery-unknown'
        ? 'the event page could not be read, so absence cannot be concluded'
        : state === 'not-delivered'
          ? 'event pages were read successfully but none carried this identifier'
          : 'no event page has been recorded yet',
      event:null,
      binding:[],
      bindingBasis:null,
      acknowledgement:[],
      reasons:[],
      flags:[],
      eventPages:pages.map(entry => entry.row)
    }];
  }

  return events.map(entry => {
    const row = entry.row;
    const usedVersion = row.interpretation?.bindingVersion ?? null;
    const usedOrigin = row.interpretation?.bindingOrigin ?? null;
    const related = records.filter(other =>
      other.row?.kind === 'binding' &&
      other.provenance?.source === entry.provenance?.source &&
      (usedVersion === null || sameId(other.row.bindingVersion, usedVersion)) &&
      (usedOrigin === null || other.row.origin === usedOrigin));
    const acknowledgements = records.filter(other => other.row?.kind === 'acknowledgement' &&
      (sameId(other.row.deliveryId, row.deliveryId) || other.row.eventId === row.id));
    return {
      lookup:key,
      state:row.status === 'understood' ? 'interpreted' : 'awaiting-review',
      event:row,
      // The definition the event itself named, including its origin
      // (active session or historical binding endpoint).
      binding:related.map(other => other.row),
      bindingBasis:{
        eventDeclared:row.bindingVersion,
        used:usedVersion,
        origin:usedOrigin,
        communicationEpoch:row.interpretation?.communicationEpoch ?? null
      },
      acknowledgement:acknowledgements.map(other => other.row),
      reasons:row.reasons ?? [],
      flags:row.flags ?? []
    };
  });
}
