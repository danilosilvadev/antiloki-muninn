import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Structural db type both drivers satisfy (postgres-js in prod, pglite in tests).
export type Db = Pick<PostgresJsDatabase<typeof schema>, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export function createDb(url: string): { db: Db; end: () => Promise<void> } {
  // prepare:false keeps this safe behind either Supabase pooler mode
  const sql = postgres(url, { max: 5, prepare: false });
  const db = drizzle(sql, { schema });
  return { db, end: () => sql.end({ timeout: 5 }) };
}
