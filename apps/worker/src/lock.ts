/**
 * Serialises async work per key within this process. With more than one worker
 * process this no longer holds; see docs/runbook.md ("Concurrent messages").
 */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.tails.set(key, next)
    try {
      return await next
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
  }
}
