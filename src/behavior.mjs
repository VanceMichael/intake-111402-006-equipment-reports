export function behavior(entry,state,fixture,scenario) {
if (entry.path === '/events' && Number(entry.query.after) > 0) return {body:{next:Number(entry.query.after),items:[]}};
if (entry.path === '/event-ack' && !entry.body?.deliveryId) return {status:400,body:{error:'deliveryId required'}};
return null;
}
