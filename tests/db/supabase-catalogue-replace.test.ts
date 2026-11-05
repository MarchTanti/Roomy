/**
 * The Supabase catalogue replacement — `deleteProductsExcept`.
 *
 * This is the order the seed depends on: the references to a product have to
 * be cleared *before* the product is deleted. A database whose foreign key
 * carries the plain `references products(id)` rule — which is what Postgres
 * reads as ON DELETE NO ACTION — refuses the delete otherwise, and the seed
 * fails with
 *
 *   update or delete on table "products" violates foreign key constraint
 *   "images_product_id_fkey" on table "images"
 *
 * The live database did exactly that, so the rule is checked here rather than
 * left to the schema.
 *
 * The adapter takes its client as an argument, so a fake can stand in for
 * Postgres and the calls can be read back in order.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { createSupabaseDbClient } from '@/lib/db/supabase';

type Op = 'select' | 'update' | 'delete' | 'in' | 'eq';

interface Logged {
  op: Op;
  table: string;
  column?: string;
  values?: string[];
  payload?: unknown;
}

interface FakeOptions {
  /** The ids the `products` table holds. */
  existingIds: string[];
  /** When set, the update against this table fails with this message. */
  failUpdateOn?: { table: string; message: string };
}

/**
 * A stand-in for the Supabase client.
 *
 * It answers the one query the catalogue replacement makes — list the ids,
 * clear the references, delete the rows — and records every call so a test can
 * check both what was asked for and in which order.
 */
function makeFakeClient(options: FakeOptions): { client: SupabaseClient; log: Logged[] } {
  const log: Logged[] = [];

  const client = {
    from(table: string) {
      const ops: Op[] = [];
      const matched: string[] = [];
      const chain: Record<string, unknown> = {};

      chain.select = (columns?: string) => {
        ops.push('select');
        log.push({ op: 'select', table, payload: columns });
        return chain;
      };

      chain.update = (values: unknown) => {
        ops.push('update');
        log.push({ op: 'update', table, payload: values });
        return chain;
      };

      chain.delete = () => {
        ops.push('delete');
        log.push({ op: 'delete', table });
        return chain;
      };

      chain.in = (column: string, values: string[]) => {
        ops.push('in');
        matched.push(...values);
        log.push({ op: 'in', table, column, values });
        return chain;
      };

      chain.eq = (column: string, value: unknown) => {
        ops.push('eq');
        log.push({ op: 'eq', table, column, values: [String(value)] });
        return chain;
      };

      // Awaiting the chain hands back the rows the query would have returned.
      chain.then = (resolve: (value: unknown) => unknown) => {
        if (options.failUpdateOn?.table === table && ops.includes('update')) {
          return resolve({ data: null, error: { message: options.failUpdateOn.message } });
        }
        if (table !== 'products') return resolve({ data: null, error: null });
        // A delete hands back the rows it removed; a select hands back the
        // rows that are there.
        const rows = ops.includes('delete') ? matched : options.existingIds;
        return resolve({ data: rows.map((id) => ({ id })), error: null });
      };

      return chain;
    },
  };

  return { client: client as unknown as SupabaseClient, log };
}

/** The calls made against one table, in order. */
function callsOn(log: Logged[], table: string): Logged[] {
  return log.filter((entry) => entry.table === table);
}

describe('deleteProductsExcept (Supabase)', () => {
  it('clears the references before it deletes the products', async () => {
    const { client, log } = makeFakeClient({ existingIds: ['keep', 'old-a', 'old-b'] });
    const db = createSupabaseDbClient(client);

    await db.deleteProductsExcept(['keep']);

    const indexOfOp = (table: string, op: Op): number =>
      log.findIndex((entry) => entry.table === table && entry.op === op);

    const updateImages = indexOfOp('images', 'update');
    const updateJobs = indexOfOp('generation_jobs', 'update');
    const deleteProducts = indexOfOp('products', 'delete');

    // The delete must come after both updates — this is the whole point.
    expect(updateImages).toBeGreaterThanOrEqual(0);
    expect(updateJobs).toBeGreaterThanOrEqual(0);
    expect(deleteProducts).toBeGreaterThan(updateImages);
    expect(deleteProducts).toBeGreaterThan(updateJobs);
  });

  it('nulls the product reference on every row that points at a dropped product', async () => {
    const { client, log } = makeFakeClient({ existingIds: ['keep', 'old-a', 'old-b'] });
    const db = createSupabaseDbClient(client);

    await db.deleteProductsExcept(['keep']);

    for (const table of ['images', 'generation_jobs']) {
      const update = callsOn(log, table).find((entry) => entry.op === 'update');
      expect(update?.payload).toEqual({ product_id: null });

      const filter = callsOn(log, table).find((entry) => entry.op === 'in');
      expect(filter?.column).toBe('product_id');
      expect(filter?.values).toEqual(['old-a', 'old-b']);
    }
  });

  it('deletes exactly the products the catalogue no longer lists', async () => {
    const { client, log } = makeFakeClient({ existingIds: ['keep', 'old-a', 'old-b'] });
    const db = createSupabaseDbClient(client);

    await db.deleteProductsExcept(['keep']);

    const deleteCall = callsOn(log, 'products').find((entry) => entry.op === 'delete');
    expect(deleteCall).toBeDefined();

    const filter = callsOn(log, 'products').find(
      (entry) => entry.op === 'in' && entry.column === 'id',
    );
    expect(filter?.values).toEqual(['old-a', 'old-b']);
  });

  it('reports how many rows it removed', async () => {
    const { client } = makeFakeClient({ existingIds: ['keep', 'old-a', 'old-b'] });
    const db = createSupabaseDbClient(client);

    await expect(db.deleteProductsExcept(['keep'])).resolves.toBe(2);
  });

  it('touches nothing when every product is kept', async () => {
    const { client, log } = makeFakeClient({ existingIds: ['keep', 'also-kept'] });
    const db = createSupabaseDbClient(client);

    await expect(db.deleteProductsExcept(['keep', 'also-kept'])).resolves.toBe(0);

    // Only the listing query — no update, no delete.
    expect(log.filter((entry) => entry.op === 'update')).toHaveLength(0);
    expect(log.filter((entry) => entry.op === 'delete')).toHaveLength(0);
  });

  it('does not delete the products when clearing a reference fails', async () => {
    const { client, log } = makeFakeClient({
      existingIds: ['keep', 'old-a'],
      failUpdateOn: { table: 'images', message: 'permission denied' },
    });
    const db = createSupabaseDbClient(client);

    await expect(db.deleteProductsExcept(['keep'])).rejects.toThrow('permission denied');

    // The delete must not have run — a half-cleared catalogue is worse than
    // an untouched one.
    expect(log.filter((entry) => entry.op === 'delete')).toHaveLength(0);
  });

  it('skips a table that has no product column yet', async () => {
    const { client, log } = makeFakeClient({
      existingIds: ['keep', 'old-a'],
      failUpdateOn: { table: 'images', message: 'column images.product_id does not exist' },
    });
    const db = createSupabaseDbClient(client);

    // A table without the column holds no references, so there is nothing to
    // clear on it and the replacement still goes ahead.
    await expect(db.deleteProductsExcept(['keep'])).resolves.toBe(1);
    expect(log.filter((entry) => entry.op === 'delete')).toHaveLength(1);
  });

  it('says what to do when the column cannot hold null', async () => {
    const { client } = makeFakeClient({
      existingIds: ['keep', 'old-a'],
      failUpdateOn: {
        table: 'images',
        message: 'null value in column "product_id" violates not-null constraint',
      },
    });
    const db = createSupabaseDbClient(client);

    await expect(db.deleteProductsExcept(['keep'])).rejects.toThrow(
      /0004_product_fk_set_null\.sql/,
    );
  });
});

describe('deleteSession (Supabase)', () => {
  it('removes the child rows before the session, the jobs before the images', async () => {
    const { client, log } = makeFakeClient({ existingIds: [] });
    const db = createSupabaseDbClient(client);

    await db.deleteSession('session-1');

    // A job may point at an image, so the jobs have to go first.
    expect(log.filter((entry) => entry.op === 'delete').map((entry) => entry.table)).toEqual([
      'generation_jobs',
      'images',
      'messages',
      'sessions',
    ]);
  });

  it('takes the rows of that session only', async () => {
    const { client, log } = makeFakeClient({ existingIds: [] });
    const db = createSupabaseDbClient(client);

    await db.deleteSession('session-1');

    for (const table of ['generation_jobs', 'images', 'messages']) {
      const filter = callsOn(log, table).find((entry) => entry.op === 'eq');
      expect(filter?.column).toBe('session_id');
      expect(filter?.values).toEqual(['session-1']);
    }

    const sessionFilter = callsOn(log, 'sessions').find((entry) => entry.op === 'eq');
    expect(sessionFilter?.column).toBe('id');
    expect(sessionFilter?.values).toEqual(['session-1']);
  });
});
