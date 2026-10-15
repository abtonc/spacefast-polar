import { DatabaseSync } from "node:sqlite";
import type { D1DatabaseLike } from "../src/functions/index.ts";

/** A D1-shaped binding over a real SQLite database, like the one Spacefast gives a worker. */
export function sqliteD1(): D1DatabaseLike & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  return {
    sqlite,
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...(values as never[])) ?? null) as T | null;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...(values as never[]));
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
  };
}
