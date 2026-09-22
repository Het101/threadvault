import { SCHEMA_SQL } from './schema.ts';
import type { PgClient } from './pg.ts';

export function schemaSql(): string {
  return SCHEMA_SQL;
}

export async function applySchema(client: PgClient): Promise<void> {
  await client.query(SCHEMA_SQL);
}
