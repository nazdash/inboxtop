/** Bounded asynchronous queue. All waiters observe cancellation; no polling timers. */
export class WorkQueue<T> {
  private items: T[] = [];
  private ended = false;
  private waiters = new Set<() => void>();
  constructor(
    private signal: AbortSignal,
    private capacity = 32,
    private compare?: (a: T, b: T) => number,
  ) {}
  private wake() {
    for (const done of [...this.waiters]) done();
  }
  private async wait() {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(this.signal.reason);
      };
      const cleanup = () => {
        this.waiters.delete(done);
        this.signal.removeEventListener('abort', abort);
      };
      this.waiters.add(done);
      this.signal.addEventListener('abort', abort, { once: true });
    });
  }
  async put(item: T) {
    while (this.items.length >= this.capacity && !this.ended) await this.wait();
    this.signal.throwIfAborted();
    if (this.ended) throw new Error('Queue is closed.');
    this.items.push(item);
    this.wake();
  }
  async take(): Promise<T | undefined> {
    while (!this.items.length && !this.ended) await this.wait();
    this.signal.throwIfAborted();
    if (this.compare) this.items.sort(this.compare);
    const item = this.items.shift();
    this.wake();
    return item;
  }
  end() {
    this.ended = true;
    this.wake();
  }
}
