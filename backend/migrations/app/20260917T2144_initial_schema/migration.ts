#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/42d08a24d9338ab9b1925109fac843f05b26792bbf689cf2148644d61a881826/contract';
import endContract from '../../snapshots/42d08a24d9338ab9b1925109fac843f05b26792bbf689cf2148644d61a881826/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'public',
        table: 'question',
        columns: [
          col('answer_count', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('body', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('content_license', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('custom_score', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('id', 'SERIAL', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('question_id', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('score', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('tags', 'text[]', { notNull: true, codecRef: { codecId: 'pg/text@1', many: true } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('url', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('view_count', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'question_tags_elem_not_null_aecbe9e2',
            'array_position("tags", NULL) IS NULL',
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'question',
        constraint: 'question_question_id_key',
        columns: ['question_id'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
