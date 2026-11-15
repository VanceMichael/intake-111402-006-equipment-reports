import {createHash} from 'node:crypto';

// SECS-II item types we know how to carry without flattening.  The value is
// intentionally kept as a typed object ({type, value}) all the way through the
// archive and API; callers must opt in to any presentation of the value.
const TYPES = new Set([
  'L', 'A', 'B', 'BOOLEAN', 'BOOL',
  'U1', 'U2', 'U4', 'U8',
  'I1', 'I2', 'I4', 'I8',
  'F4', 'F8'
]);

export class SourceShapeError extends Error {
  constructor(message, data = null) {
    super(message);
    this.name = 'SourceShapeError';
    this.code = 'source-shape';
    this.data = data;
  }
}

const NUMERIC = new Set(['U1','U2','U4','U8','I1','I2','I4','I8','F4','F8']);

function validScalarOrArray(value, accept) {
  const values = Array.isArray(value) ? value : [value];
  return values.every(accept);
}

function checkTypeShape(type, value) {
  if (type === 'L') {
    if (!Array.isArray(value)) throw new Error('list value required');
    return;
  }
  if (type === 'A') {
    if (!validScalarOrArray(value, item => typeof item === 'string')) throw new Error('A value must be a string');
    return;
  }
  if (type === 'BOOLEAN' || type === 'BOOL') {
    if (!validScalarOrArray(value, item => typeof item === 'boolean')) throw new Error(`${type} value must be a boolean`);
    return;
  }
  if (NUMERIC.has(type)) {
    if (!validScalarOrArray(value, item => typeof item === 'number' && Number.isFinite(item))) {
      throw new Error(`${type} value must be numeric; values are not coerced`);
    }
    return;
  }
  // B (binary) is carried as the source expressed it; we do not decode or
  // re-encode it here.
}

export function typed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('typed value required');
  if (typeof value.type !== 'string' || !TYPES.has(value.type)) throw new Error('unsupported type');
  if (!Object.hasOwn(value, 'value')) throw new Error('typed value required');
  checkTypeShape(value.type, value.value);
  const copy = structuredClone(value);
  if (value.type === 'L') copy.value = value.value.map(item => typed(item));
  return copy;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasId(value) {
  return value !== undefined && value !== null && value !== '';
}

function sameId(left, right) {
  return hasId(left) && hasId(right) && String(left) === String(right);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requireArray(body, name) {
  if (!Array.isArray(body?.[name])) throw new SourceShapeError(`${name} must be an array`, body);
  return body[name];
}

function normalizeReports(input) {
  const problems = [];
  const reports = input.map((entry, index) => {
    if (!isObject(entry)) {
      problems.push({code:'report-definition-invalid', index, message:'report entry must be an object'});
      return {index, valid:false, raw:clone(entry)};
    }
    const validId = hasId(entry.reportId);
    const validVids = Array.isArray(entry.vids) && entry.vids.every(vid => typeof vid === 'string' && vid.length > 0);
    if (!validId) problems.push({code:'report-id-missing', index, message:'reportId is required'});
    if (!validVids) problems.push({code:'report-vids-invalid', index, reportId:entry.reportId ?? null, message:'vids must be an array of non-empty strings'});
    return {...clone(entry), index, valid:validId && validVids};
  });
  return {reports, problems};
}

function normalizeLinks(input) {
  const problems = [];
  const links = input.map((entry, index) => {
    if (!isObject(entry)) {
      problems.push({code:'link-definition-invalid', index, message:'link entry must be an object'});
      return {index, valid:false, raw:clone(entry)};
    }
    const validCeid = hasId(entry.ceid);
    const validReports = Array.isArray(entry.reportIds) && entry.reportIds.every(id => hasId(id));
    if (!validCeid) problems.push({code:'link-ceid-missing', index, message:'ceid is required'});
    if (!validReports) problems.push({code:'link-report-ids-invalid', index, ceid:entry.ceid ?? null, message:'reportIds must be an array of ids'});
    return {...clone(entry), index, valid:validCeid && validReports};
  });
  return {links, problems};
}

/**
 * Normalize the two binding projections from the gateway into one immutable
 * snapshot.  A snapshot always carries its raw evidence so that an event can be
 * explained later even after the equipment has been re-bound.
 */
export function normalizeBinding(raw, context = {}) {
  if (!isObject(raw)) throw new SourceShapeError('binding body must be an object', raw);
  const reportInput = requireArray(raw, 'reports');
  const linkInput = requireArray(raw, 'links');
  const reportsVersion = raw.reportsBindingVersion ?? raw.bindingVersion;
  const linksVersion = raw.linksBindingVersion ?? raw.bindingVersion;
  const expected = context.expectedVersion;
  const version = expected ?? raw.bindingVersion ?? reportsVersion ?? linksVersion;

  if (!hasId(version)) throw new SourceShapeError('bindingVersion is required', raw);

  const problems = [];
  if (hasId(reportsVersion) && hasId(linksVersion) && reportsVersion !== linksVersion) {
    problems.push({
      code:'binding-version-mismatch',
      message:`reports=${reportsVersion} links=${linksVersion}`,
      reportsBindingVersion:reportsVersion,
      linksBindingVersion:linksVersion
    });
  }
  if (expected && hasId(raw.bindingVersion) && raw.bindingVersion !== expected) {
    problems.push({
      code:'binding-version-mismatch',
      message:`requested ${expected}, source returned ${raw.bindingVersion}`,
      expectedVersion:expected,
      returnedVersion:raw.bindingVersion
    });
  }

  const reportResult = normalizeReports(reportInput);
  const linkResult = normalizeLinks(linkInput);
  problems.push(...reportResult.problems, ...linkResult.problems);

  return {
    bindingVersion:String(version),
    communicationEpoch:context.communicationEpoch ?? null,
    source:context.source ?? null,
    origin:context.origin ?? 'active',
    fetchedAt:context.fetchedAt ?? new Date().toISOString(),
    definitionDigest:createHash('sha256').update(JSON.stringify({
      reports:reportResult.reports.map(report => ({reportId:report.reportId, vids:report.vids, valid:report.valid})),
      links:linkResult.links.map(link => ({ceid:link.ceid, reportIds:link.reportIds, valid:link.valid}))
    })).digest('hex'),
    reports:reportResult.reports,
    links:linkResult.links,
    problems,
    usable:!problems.some(problem => problem.code === 'binding-version-mismatch'),
    raw:clone({bindingVersion:raw.bindingVersion, reports:reportInput, links:linkInput})
  };
}

export async function readStatus(client) {
  const status = await client('/status');
  if (!isObject(status) || typeof status.equipment !== 'string' || !status.equipment) {
    throw new SourceShapeError('status equipment is required', status);
  }
  return {id:status.equipment, state:typed(status.state)};
}

// The legacy adapter: status polling only.  New report collection lives in
// intake.mjs; keeping this function separate means existing callers that rely
// on "no communication session yet" still observe the source's 409.
export async function collect(client) {
  return [await readStatus(client)];
}

export async function establish(client) {
  const body = await client('/establish', {method:'POST', body:{}});
  if (!isObject(body) || typeof body.communicationEpoch !== 'string' || !body.communicationEpoch) {
    throw new SourceShapeError('communicationEpoch is required', body);
  }
  return {communicationEpoch:body.communicationEpoch};
}

export async function readBinding(client, context = {}) {
  const reportsBody = await client('/reports');
  const linksBody = await client('/links');
  if (!isObject(reportsBody) || !isObject(linksBody)) {
    throw new SourceShapeError('reports and links must be objects', {reportsBody, linksBody});
  }
  return normalizeBinding({
    bindingVersion:reportsBody.bindingVersion ?? linksBody.bindingVersion,
    reportsBindingVersion:reportsBody.bindingVersion,
    linksBindingVersion:linksBody.bindingVersion,
    reports:reportsBody.reports,
    links:linksBody.links
  }, {...context, origin:context.origin ?? 'active'});
}

/**
 * Fetch the definition that a particular binding version had at the time.
 * A missing historical binding is a legitimate "not determinable yet" result,
 * not an error to invent a mapping from the current catalog.
 */
export async function readBindingVersion(client, bindingVersion, context = {}) {
  const body = await client(`/bindings/${encodeURIComponent(bindingVersion)}`);
  if (!isObject(body)) throw new SourceShapeError('binding body must be an object', body);
  return normalizeBinding(body, {...context, expectedVersion:bindingVersion, origin:context.origin ?? 'history'});
}

export async function readEvents(client, after = 0) {
  const body = await client(`/events?after=${encodeURIComponent(String(after))}`);
  if (!isObject(body)) throw new SourceShapeError('events body must be an object', body);
  const items = requireArray(body, 'items').map(item => clone(item));
  const next = Number(body.next);
  if (!Number.isSafeInteger(next) || next < 0) throw new SourceShapeError('events next must be a non-negative integer', body);
  return {items, next, raw:clone(body)};
}

export async function ackEvent(client, deliveryId) {
  if (typeof deliveryId !== 'string' || !deliveryId) throw new Error('deliveryId required');
  return client('/event-ack', {method:'POST', body:{deliveryId}});
}

function valueReason(code, message, extra = {}) {
  return {code, message, ...extra};
}

/**
 * Interpret one event only with the binding snapshot identified by the event
 * itself.  Anything ambiguous is returned as pending-review with the raw item
 * intact and explicit reasons; we never fall back to the current catalog.
 */
export function resolveEvent(item, snapshot, context = {}) {
  const reasons = [];
  const flags = [];
  const seen = new Set();
  const addReason = reason => {
    const key = `${reason.code}\u0000${reason.message ?? ''}\u0000${reason.index ?? ''}`;
    if (!seen.has(key)) {seen.add(key); reasons.push(reason);}
  };

  if (!isObject(item)) {
    addReason(valueReason('event-malformed', 'event item must be an object'));
    return {status:'pending-review', reasons, flags, report:null, link:null, fields:null, values:null};
  }
  if (!isObject(snapshot)) {
    addReason(valueReason('binding-not-determined', 'no binding snapshot available'));
    return {status:'pending-review', reasons, flags, report:null, link:null, fields:null, values:null};
  }

  if (snapshot.conflict) {
    addReason(valueReason('binding-version-conflict',
      `bindingVersion ${snapshot.bindingVersion} was observed with different definitions`));
  }
  for (const problem of snapshot.problems ?? []) {
    // Version mismatches invalidate the whole snapshot.  Other per-entry
    // problems are considered below only when the event actually uses them.
    if (String(problem.code).startsWith('binding-version')) addReason(problem);
  }

  if (!hasId(item.CEID)) addReason(valueReason('ceid-missing', 'CEID is required'));
  if (!hasId(item.RPTID)) addReason(valueReason('rptid-missing', 'RPTID is required'));
  if (!hasId(item.DATAID)) flags.push({code:'dataid-missing', message:'DATAID is absent'});
  if (!hasId(item.deliveryId)) addReason(valueReason('delivery-id-missing', 'deliveryId is required to track receipt'));
  if (!hasId(item.communicationEpoch)) {
    flags.push({code:'communication-epoch-absent', message:'event did not carry communicationEpoch'});
  } else if (context.activeEpoch && String(item.communicationEpoch) !== String(context.activeEpoch)) {
    flags.push({
      code:'communication-epoch-mismatch',
      message:`event epoch ${item.communicationEpoch}, current epoch ${context.activeEpoch}`
    });
  }
  if (hasId(item.bindingVersion) && context.activeBindingVersion &&
      String(item.bindingVersion) !== String(context.activeBindingVersion)) {
    flags.push({
      code:'binding-version-changed',
      message:`event binding ${item.bindingVersion}, current binding ${context.activeBindingVersion}`
    });
  }

  const reportMatches = (snapshot.reports ?? []).filter(report => sameId(report.reportId, item.RPTID));
  let report = null;
  if (reportMatches.length === 0) {
    addReason(valueReason('report-not-defined', `RPTID ${item.RPTID} is not defined in binding ${snapshot.bindingVersion}`));
  } else if (reportMatches.length > 1) {
    addReason(valueReason('duplicate-report-definition', `RPTID ${item.RPTID} has multiple definitions`));
  } else {
    report = reportMatches[0];
    if (!report.valid) {
      addReason(valueReason('report-definition-invalid', `RPTID ${item.RPTID} has an invalid definition`));
    } else if (new Set(report.vids).size !== report.vids.length) {
      addReason(valueReason('ambiguous-vids', `RPTID ${item.RPTID} contains duplicate VIDs`));
    }
  }

  const linkMatches = (snapshot.links ?? []).filter(link => sameId(link.ceid, item.CEID));
  let link = null;
  if (linkMatches.length === 0) {
    addReason(valueReason('ceid-not-linked', `CEID ${item.CEID} has no report link in binding ${snapshot.bindingVersion}`));
  } else if (linkMatches.length > 1) {
    addReason(valueReason('duplicate-link-definition', `CEID ${item.CEID} has multiple link definitions`));
  } else {
    link = linkMatches[0];
    if (!link.valid) {
      addReason(valueReason('link-definition-invalid', `CEID ${item.CEID} has an invalid link definition`));
    } else if (hasId(item.RPTID) && !link.reportIds.some(id => sameId(id, item.RPTID))) {
      addReason(valueReason('report-not-linked', `RPTID ${item.RPTID} is not linked to CEID ${item.CEID}`));
    }
  }

  let values = null;
  if (!Array.isArray(item.typedValues)) {
    addReason(valueReason('typed-values-missing', 'typedValues must be an array'));
  } else {
    values = [];
    for (let index = 0; index < item.typedValues.length; index++) {
      try {
        values.push(typed(item.typedValues[index]));
      } catch (error) {
        addReason(valueReason('value-type-unsupported', error.message, {index}));
        values = null;
        break;
      }
    }
  }

  if (values && report?.valid && values.length !== report.vids.length) {
    addReason(valueReason('value-count-mismatch',
      `RPTID ${item.RPTID} has ${report.vids.length} VIDs but ${values.length} values`));
  }

  let fields = null;
  if (reasons.length === 0) {
    fields = report.vids.map((vid, index) => ({vid, value:values[index]}));
  }

  return {
    status:reasons.length === 0 ? 'understood' : 'pending-review',
    reasons,
    flags,
    report:report ? clone(report) : null,
    link:link ? clone(link) : null,
    fields,
    values
  };
}

export function eventStorageId(item) {
  if (isObject(item) && typeof item.deliveryId === 'string' && item.deliveryId) return item.deliveryId;
  return `raw-${createHash('sha256').update(JSON.stringify(item ?? null)).digest('hex')}`;
}
