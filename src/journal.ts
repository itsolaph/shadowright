import { readJson, writeJson } from './files.ts';
import type { StoredMemory } from './memory.ts';

export interface JournalEntry extends StoredMemory {
  digest: string;
  storedAt: string;
}

/**
 * Local record of which decisions were already written to Walrus Memory, so repeated
 * `replay --write` runs continue where the last one stopped instead of writing duplicates.
 * It is a convenience cache only: the memories themselves live on Walrus.
 */
export class Journal {
  private readonly path: string;
  private readonly entries: Map<string, JournalEntry>;

  private constructor(path: string, entries: JournalEntry[]) {
    this.path = path;
    this.entries = new Map(entries.map((entry) => [entry.digest, entry]));
  }

  static async open(path: string): Promise<Journal> {
    return new Journal(path, (await readJson<JournalEntry[]>(path)) ?? []);
  }

  has(digest: string): boolean {
    return this.entries.has(digest);
  }

  get size(): number {
    return this.entries.size;
  }

  async add(digest: string, stored: StoredMemory): Promise<void> {
    this.entries.set(digest, { digest, ...stored, storedAt: new Date().toISOString() });
    await writeJson(this.path, [...this.entries.values()]);
  }
}
