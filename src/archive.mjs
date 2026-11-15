import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

const digestOf = (row, provenance) =>
  createHash('sha256').update(JSON.stringify({row,provenance})).digest('hex');

/**
 * Append-only observation store.  A record is (row, provenance, digest); the
 * digest covers exactly what was observed, so identical content from the same
 * source is idempotent while a changed observation is kept as a new version.
 * Rows that repeat byte-for-byte across polls are not re-added; the caller is
 * responsible for making observation rows describe what was observed rather
 * than when it was polled.
 */
export class Archive {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }

  async list() {
    try {return JSON.parse(await readFile(join(this.directory,'records.json'),'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return [];throw error;}
  }

  _append(build) {
    const operation = this.serial.then(async () => {
      await mkdir(this.directory,{recursive:true});
      const current = await this.list();
      const known = new Set(current.map(entry => entry.digest));
      const added = build(current, known);
      const temporary = join(this.directory,`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(current,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,join(this.directory,'records.json'));
      return {added,total:current.length};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  put(rows, provenance) {
    return this._append((current, known) => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) throw new Error('record id required');
      let added = 0;
      for (const row of rows) {
        const digest = digestOf(row,provenance);
        if (!known.has(digest)) {current.push({row,provenance,digest});known.add(digest);added++;}
      }
      return added;
    });
  }

  /**
   * Name used by the intake path.  It is the same append-only, content-digest
   * behaviour as put(); kept separate so callers read as observations rather
   * than as a one-off insertion.
   */
  reconcile(rows, provenance) {
    return this.put(rows, provenance);
  }
}
