import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Saved } from './domain.ts';
export interface Store {
  load(): Promise<Saved>;
  save(value: Saved): Promise<void>;
  close(): Promise<void>;
}
export class EncryptedStore implements Store {
  private key!: Buffer;
  private lock = false;
  private pending = Promise.resolve();
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, 'session.lock');
    for (let attempt = 0; attempt < 2; attempt++)
      try {
        const f = await open(lock, 'wx', 0o600);
        await f.writeFile(String(process.pid));
        await f.close();
        this.lock = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = Number(await readFile(lock, 'utf8'));
        let alive = true;
        if (!Number.isSafeInteger(pid) || pid < 1)
          throw new Error('Invalid cache lock. Inspect session.lock before continuing.');
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive || !Number.isSafeInteger(pid) || pid < 1)
          throw new Error('Another inboxtop process owns this cache. Close it before continuing.');
        await unlink(lock);
      }
    try {
      try {
        this.key = await readFile(join(this.directory, 'cache.key'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        try {
          await readFile(join(this.directory, 'session.enc'));
          throw new Error('Cache key is missing. Restore cache.key before continuing.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.key = randomBytes(32);
        await writeFile(join(this.directory, 'cache.key'), this.key, { mode: 0o600, flag: 'wx' });
      }
      if (this.key.length !== 32) throw new Error('Invalid cache key.');
    } catch (e) {
      await this.close();
      throw e;
    }
    return this;
  }
  async load(): Promise<Saved> {
    let data: Buffer;
    try {
      data = await readFile(join(this.directory, 'session.enc'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, cache: {} };
      throw e;
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from('inboxtop-terminal-v1'));
      decipher.setAuthTag(data.subarray(12, 28));
      const saved = JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(),
      ) as Saved;
      if (saved.version !== 1 || typeof saved.cache !== 'object') throw new Error();
      return saved;
    } catch {
      throw new Error('Encrypted cache could not be opened. It was left untouched.');
    }
  }
  save(value: Saved): Promise<void> {
    const plain = JSON.stringify(value);
    const work = this.pending.then(async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from('inboxtop-terminal-v1'));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tmp = join(this.directory, 'session.tmp');
      await writeFile(tmp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
      await rename(tmp, join(this.directory, 'session.enc'));
    });
    this.pending = work.catch(() => {});
    return work;
  }
  async close() {
    await this.pending;
    if (this.lock) {
      await unlink(join(this.directory, 'session.lock')).catch(() => {});
      this.lock = false;
    }
  }
}
export class MemoryStore implements Store {
  value: Saved = { version: 1, cache: {} };
  async load() {
    return structuredClone(this.value);
  }
  async save(value: Saved) {
    this.value = structuredClone(value);
  }
  async close() {}
}
