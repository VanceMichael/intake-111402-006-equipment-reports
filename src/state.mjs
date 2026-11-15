import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/**
 * Collector-side progress that is deliberately separate from the archive.
 * The cursor means "all events up to this point were written to the archive",
 * not "the equipment said it delivered them" and not "the gateway acknowledged
 * them".
 */
export function createState(directory) {
  const path = join(directory,'collector.json');
  let serial = Promise.resolve();
  return {
    path,
    read() {
      return readFile(path,'utf8').then(text => JSON.parse(text), error => {
        if (error.code === 'ENOENT') return {cursor:0};
        throw error;
      });
    },
    write(value) {
      const operation = serial.then(async () => {
        await mkdir(directory,{recursive:true});
        const temporary = join(directory,`${randomUUID()}.state.tmp`);
        await writeFile(temporary,JSON.stringify(value,null,2)+'\n');
        const handle = await open(temporary,'r');
        try {await handle.sync();} finally {await handle.close();}
        await rename(temporary,path);
      });
      serial = operation.catch(() => {});
      return operation;
    }
  };
}
