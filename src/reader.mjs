export function typed(value) {
  if (!['A','U1','F4','L'].includes(value.type)) throw new Error('unsupported type');
  return value.type === 'L' ? {type:'L',value:value.value.map(typed)} : structuredClone(value);
}
export async function collect(client) {
  const status = await client('/status');
  return [{id:status.equipment,state:typed(status.state)}];
}
