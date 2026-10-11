import 'dotenv/config';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';

const sql = postgres(process.env.DATABASE_URL);

try {
  const migrationSql = await readFile(
    new URL('../prisma/sql/full_text_search.sql', import.meta.url),
    'utf8'
  );
  const approachCSql = await readFile(
    new URL('../prisma/sql/approach_c_search.sql', import.meta.url),
    'utf8'
  );

  await sql.unsafe(migrationSql);
  await sql.unsafe(approachCSql);

  console.log('Full-text search and Approach C setup completed successfully.');
} catch (error) {
  console.error('Full-text search setup failed.');
  console.error(error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
