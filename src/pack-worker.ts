/**
 * Worker thread for src/pack.ts: Argon2id hashes of phone numbers. Self-contained (imports only
 * hash-wasm) so it also runs straight from the .ts source under the tests.
 */
import { parentPort } from 'node:worker_threads';
import { argon2id } from 'hash-wasm';

interface Job {
  id: number;
  phones: string[];
  salt: Uint8Array;
  t: number;
  m: number;
  p: number;
}

parentPort!.on('message', async (job: Job) => {
  try {
    const out: Uint8Array[] = [];
    for (const phone of job.phones) {
      out.push(
        await argon2id({
          password: phone,
          salt: job.salt,
          iterations: job.t,
          memorySize: job.m,
          parallelism: job.p,
          hashLength: 32,
          outputType: 'binary',
        }),
      );
    }
    parentPort!.postMessage({ id: job.id, hashes: out });
  } catch (err) {
    parentPort!.postMessage({ id: job.id, error: (err as Error).message });
  }
});
