import {createHash} from 'node:crypto';
import {
  ackEvent, establish, eventStorageId, readBinding, readBindingVersion, readEvents, resolveEvent
} from './reader.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => (value === undefined || value === null ? null : String(value));
// Record ids are stable and URL-safe but do not embed credentials or host
// paths; the full source remains in the provenance.
const scopeKey = source => createHash('sha256').update(String(source ?? 'local')).digest('hex').slice(0,12);

class Session {
  constructor(source) {
    this.source = source;
    this.communicationEpoch = null;
    this.bindingVersion = null;
  }
  async establish(client) {
    const {communicationEpoch} = await establish(client);
    this.communicationEpoch = communicationEpoch;
    return communicationEpoch;
  }
  async activeBinding(client) {
    const snapshot = await readBinding(client, {
      communicationEpoch:this.communicationEpoch,
      source:this.source,
      origin:'active'
    });
    this.bindingVersion = snapshot.bindingVersion;
    return snapshot;
  }
}

function provenance(extra = {}) {
  return {adapter:'reports', ...extra};
}

function fetchError(error) {
  return {
    status:error?.status ?? null,
    message:error?.message ?? String(error),
    data:error?.data ?? null
  };
}

function bindingRow(snapshot, source, origin, extra = {}) {
  return {
    kind:'binding',
    id:`binding:${scopeKey(source)}:${snapshot.bindingVersion}:${origin}`,
    bindingVersion:snapshot.bindingVersion,
    communicationEpoch:snapshot.communicationEpoch,
    origin,
    usable:snapshot.usable,
    definitionDigest:snapshot.definitionDigest ?? null,
    conflict:snapshot.conflict ?? null,
    problems:snapshot.problems,
    reports:snapshot.reports,
    links:snapshot.links,
    raw:snapshot.raw,
    ...extra,
    provenance:provenance({kind:'binding', source, origin, bindingVersion:snapshot.bindingVersion})
  };
}

function definitionProblems(snapshot) {
  return (snapshot.problems ?? []).filter(problem => String(problem.code).startsWith('binding-version'));
}

/**
 * One intake pass: establish a communication epoch, read the report/link
 * definitions under it, then read and archive the events reported since the
 * last cursor.  Every return value is an observation row for the archive; the
 * function never claims more than the source actually returned.
 *
 * `options.after` is the delivery cursor that was successfully archived by a
 * previous pass.  It is never advanced here: the caller decides that after the
 * archive write succeeds.
 */
export async function collectReports(client, options = {}) {
  const source = options.source ?? null;
  const session = new Session(source);
  const knownBindings = new Map(Object.entries(options.knownBindings ?? {}));
  const bindingsSeen = {};

  // A version label is only a label.  If the same label comes back with a
  // different definition, that is a conflict to record, not a silent upgrade.
  // The first definition seen for a label is retained as the reference so the
  // conflict stays visible on later passes instead of being forgotten.
  const checkDefinition = snapshot => {
    const previous = knownBindings.get(snapshot.bindingVersion);
    if (previous && previous !== snapshot.definitionDigest) {
      snapshot.conflict = {
        code:'binding-version-conflict',
        message:`bindingVersion ${snapshot.bindingVersion} was previously ${previous}, now ${snapshot.definitionDigest}`,
        previousDigest:previous,
        currentDigest:snapshot.definitionDigest
      };
      snapshot.usable = false;
    } else if (!previous) {
      knownBindings.set(snapshot.bindingVersion, snapshot.definitionDigest);
    }
    bindingsSeen[snapshot.bindingVersion] = knownBindings.get(snapshot.bindingVersion);
    return snapshot;
  };
  const rows = [];
  // The run row describes the observation, not the wall clock: identical idle
  // passes collapse in the archive instead of growing one row per poll.
  const runRow = extra => ({
    kind:'intake-run',
    id:`intake-run:${scopeKey(source)}:${session.communicationEpoch ?? 'no-communication'}:${extra.after}:${extra.outcome}`,
    ...extra,
    provenance:provenance({kind:'intake-run', source})
  });
  const finish = result => {
    rows.unshift(runRow({
      communicationEpoch:session.communicationEpoch,
      bindingVersion:session.bindingVersion,
      after:Number.isSafeInteger(options.after) ? options.after : 0,
      next:result.next ?? null,
      outcome:result.outcome
    }));
    return {...result, rows, bindingsSeen};
  };
  // 1. Communication establishment is part of the evidence trail.
  let epoch;
  try {
    epoch = await session.establish(client);
  } catch (error) {
    const failure = fetchError(error);
    rows.push({
      kind:'communication',
      id:`communication:${scopeKey(source)}:failed`,
      communicationEpoch:null,
      established:false,
      error:failure,
      provenance:provenance({kind:'communication', source})
    });
    return finish({outcome:'establish-failed', next:null, cursorEpoch:options.cursorEpoch ?? null,
      snapshot:null, page:null, error:failure});
  }
  rows.push({
    kind:'communication',
    id:`communication:${scopeKey(source)}:${epoch}`,
    communicationEpoch:epoch,
    established:true,
    error:null,
    provenance:provenance({kind:'communication', source})
  });

  // 2. Definitions under this epoch.  Failure is an observation, not a reason
  //    to reinterpret events against a stale or guessed catalog.
  let snapshot = null;
  try {
    snapshot = checkDefinition(await session.activeBinding(client));
    rows.push(bindingRow(snapshot, source, 'active'));
  } catch (error) {
    rows.push({
      kind:'binding',
      id:`binding:${scopeKey(source)}:unavailable:active`,
      bindingVersion:null,
      communicationEpoch:epoch,
      origin:'active',
      usable:false,
      problems:[{code:'binding-unavailable', message:error?.message ?? String(error), detail:fetchError(error)}],
      reports:[], links:[], raw:null,
      provenance:provenance({kind:'binding', source, origin:'active'})
    });
  }

  // 3. Events.  An empty page never advances a claim about events that were
  //    not delivered; it is recorded as an empty page.  A cursor belongs to a
  //    communication epoch: a reconnect may restart DATAID numbering, so an
  //    epoch change starts again from the gateway's first available delivery.
  //    Re-reading is safe because events are deduplicated by content.
  const previousCursor = Number.isSafeInteger(options.after) ? options.after : 0;
  const previousCursorEpoch = options.cursorEpoch ? String(options.cursorEpoch) : null;
  const cursorReset = Boolean(previousCursorEpoch && previousCursorEpoch !== String(epoch));
  const after = cursorReset ? 0 : previousCursor;
  let page;
  try {
    page = await readEvents(client, after);
  } catch (error) {
    const failure = fetchError(error);
    rows.push({
      kind:'event-page',
      id:`event-page:${scopeKey(source)}:${epoch}:${after}:failed`,
      communicationEpoch:epoch,
      bindingVersion:snapshot?.bindingVersion ?? null,
      after,
      previousCursor,
      cursorReset,
      next:null,
      received:0,
      error:failure,
      provenance:provenance({kind:'event-page', source})
    });
    return finish({outcome:'events-failed', next:null, snapshot, page:null, error:failure,
      cursorEpoch:previousCursorEpoch ?? String(epoch)});
  }

  rows.push({
    kind:'event-page',
    id:`event-page:${scopeKey(source)}:${epoch}:${after}:${page.next}`,
    communicationEpoch:epoch,
    bindingVersion:snapshot?.bindingVersion ?? null,
    after,
    previousCursor,
    cursorReset,
    next:page.next,
    received:page.items.length,
    error:null,
    provenance:provenance({kind:'event-page', source})
  });

  const snapshots = new Map();
  if (snapshot) snapshots.set(snapshot.bindingVersion, snapshot);
  const historyRequests = new Map();
  const eventRows = [];

  for (const item of page.items) {
    const storageId = eventStorageId(item);
    const eventEpoch = id(item?.communicationEpoch);
    const eventBinding = id(item?.bindingVersion);

    // Only the document the event names can explain it.  The active binding is
    // used solely when the event names none and the epochs still agree.
    let chosen = null;
    let unresolved = null;
    const sameEpoch = !eventEpoch || eventEpoch === id(epoch);

    if (eventBinding && snapshot?.bindingVersion === eventBinding && sameEpoch) {
      // The event names the definition that is active in this very session.
      chosen = snapshot;
    } else if (eventBinding) {
      // The equipment may have re-linked and dropped the old definition, or
      // the event may belong to an earlier epoch of the same version.  Ask the
      // gateway for that binding; never assume the current catalog applies.
      if (!historyRequests.has(eventBinding)) {
        historyRequests.set(eventBinding, (async () => {
          try {
            return await readBindingVersion(client, eventBinding, {
              communicationEpoch:eventEpoch ?? epoch,
              source,
              origin:'history'
            });
          } catch (error) {
            return error;
          }
        })());
      }
      const history = await historyRequests.get(eventBinding);
      if (history instanceof Error) {
        unresolved = {
          code:'binding-history-unavailable',
          message:`binding ${eventBinding} is unavailable: ${history.message}`,
          detail:fetchError(history)
        };
      } else if (definitionProblems(history).length) {
        unresolved = {
          code:'binding-history-mismatch',
          message:`gateway returned binding ${history.bindingVersion} when ${eventBinding} was requested`
        };
      } else {
        chosen = checkDefinition(history);
        snapshots.set(eventBinding, chosen);
        rows.push(bindingRow(chosen, source, 'history', {requestedVersion:eventBinding}));
      }
    } else if (sameEpoch) {
      chosen = snapshot;
      if (!chosen) {
        unresolved = {code:'binding-not-determined', message:'no active binding is available'};
      }
    } else {
      unresolved = {
        code:'binding-not-determined',
        message:`event epoch ${eventEpoch} has no bindingVersion to explain it`
      };
    }

    if (!chosen && !unresolved) {
      unresolved = {
        code:'binding-not-determined',
        message:eventBinding
          ? `binding ${eventBinding} is not the active binding and no history is available`
          : 'no binding is available to explain the event'
      };
    }

    const resolution = resolveEvent(item, chosen, {
      activeEpoch:epoch,
      activeBindingVersion:snapshot?.bindingVersion ?? null
    });
    if (unresolved) {
      resolution.status = 'pending-review';
      resolution.reasons.unshift(unresolved);
      resolution.fields = null;
      resolution.report = null;
      resolution.link = null;
    }

    const row = {
      kind:'event',
      id:`event:${scopeKey(source)}:${storageId}`,
      deliveryId:isObject(item) && typeof item.deliveryId === 'string' ? item.deliveryId : null,
      DATAID:item?.DATAID ?? null,
      CEID:item?.CEID ?? null,
      RPTID:item?.RPTID ?? null,
      communicationEpoch:item?.communicationEpoch ?? null,
      bindingVersion:item?.bindingVersion ?? null,
      status:resolution.status,
      reasons:resolution.reasons,
      flags:resolution.flags,
      fields:resolution.fields,
      values:resolution.values,
      report:resolution.report,
      link:resolution.link,
      raw:item,
      interpretation:{
        bindingVersion:chosen?.bindingVersion ?? null,
        bindingOrigin:chosen?.origin ?? null,
        communicationEpoch:chosen?.communicationEpoch ?? null
      },
      provenance:provenance({
        kind:'event',
        source,
        deliveryId:isObject(item) && typeof item.deliveryId === 'string' ? item.deliveryId : null,
        bindingVersion:chosen?.bindingVersion ?? eventBinding,
        bindingOrigin:chosen?.origin ?? 'none'
      })
    };
    rows.push(row);
    eventRows.push(row);
  }

  const pending = eventRows.filter(row => row.status !== 'understood').length;
  return finish({
    outcome:page.items.length === 0 ? 'no-events' : (pending ? 'events-pending-review' : 'events-understood'),
    next:page.next,
    cursorEpoch:String(epoch),
    snapshot,
    page,
    eventRows,
    error:null
  });
}

/**
 * Confirm to the gateway that a delivery was received.  This is the only place
 * allowed to mark an event acknowledged; an HTTP 200 with {accepted:false} is
 * preserved as a refused acknowledgement.  Acknowledgement rows are separate
 * from event rows so that neither the original report nor its interpretation
 * is mutated by the gateway's answer.
 *
 * `deliveries` may be intake event rows or plain {deliveryId, eventId,
 * communicationEpoch} entries (used when retrying an earlier failure).
 */
export async function acknowledge(client, deliveries, options = {}) {
  const source = options.source ?? null;
  const rows = [];
  for (const delivery of deliveries) {
    const deliveryId = delivery?.deliveryId;
    if (typeof deliveryId !== 'string' || !deliveryId) continue;
    const eventId = delivery.eventId ?? delivery.id ?? null;
    let acknowledgement;
    try {
      const body = await ackEvent(client, deliveryId);
      acknowledgement = {requested:true, accepted:body?.accepted === true, response:body ?? null, error:null};
    } catch (error) {
      acknowledgement = {requested:true, accepted:false, response:null, error:fetchError(error)};
    }
    rows.push({
      kind:'acknowledgement',
      id:`acknowledgement:${scopeKey(source)}:${deliveryId}`,
      deliveryId,
      eventId,
      communicationEpoch:delivery.communicationEpoch ?? null,
      ...acknowledgement,
      // Delivery acknowledgement is the gateway's statement about delivery.
      // It is deliberately unrelated to whether the local archive write
      // succeeded and unrelated to whether the report was understood.
      provenance:provenance({kind:'acknowledgement', source, deliveryId})
    });
  }
  return rows;
}
