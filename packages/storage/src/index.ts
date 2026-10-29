import type { JsonStore, RawKv } from "../../contracts/src/index";
/** No process-wide cache: every read observes the instance's durable source. */
export class KvStore implements JsonStore {
  constructor(private kv: RawKv) {}
  async get<T>(key: string): Promise<T | null> {
    const value = await this.kv.get(key);
    return value === null ? null : (JSON.parse(value) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    await this.kv.put(key, JSON.stringify(value));
  }
}
export class MemoryStore implements JsonStore {
  private values = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : (JSON.parse(value) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, JSON.stringify(value));
  }
}

export interface CheckpointStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
/** Actor checkpoint supplies read-your-writes across restarts; KV remains exportable.
 * A KV mirror error cannot turn a durable accepted submission back into a retry.
 */
export class CoordinatedKvStore implements JsonStore {
  private kvStore: KvStore;
  constructor(
    kv: RawKv,
    private checkpoint: CheckpointStore,
    private warn: (message: string) => void = console.warn,
  ) {
    this.kvStore = new KvStore(kv);
  }
  async get<T>(key: string): Promise<T | null> {
    const current = await this.checkpoint.get<T>(key);
    return current === undefined ? this.kvStore.get<T>(key) : current;
  }
  async put<T>(key: string, value: T): Promise<void> {
    await this.checkpoint.put(key, value);
    try {
      await this.kvStore.put(key, value);
    } catch {
      this.warn(
        "KV mirror write failed; durable coordinator checkpoint retained",
      );
    }
  }
}
