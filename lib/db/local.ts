/**
 * Local database adapter — JSON files under `.data/`.
 *
 * This is the zero-credential default so the whole app runs before a Supabase
 * project exists. It implements the same `DbClient` interface as the Supabase
 * adapter, so switching is one env var (`DB_ADAPTER=supabase`).
 *
 * Trade-offs, on purpose:
 *  - No read cache. Every call re-reads the file. For a demo catalog of ~50
 *    products and a handful of live sessions that is cheap, and it removes a
 *    whole class of stale-cache bugs between `scripts/seed.ts` and the dev server.
 *  - Writes are serialised in-process with a promise chain, so a read-modify-
 *    write from two concurrent route handlers cannot interleave. This does NOT
 *    protect across processes — the demo runs one.
 *  - No RLS. The Supabase adapter plus the migration's policies cover that.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { settings } from '../env';
import {
  emptySessionState,
  normalizeSessionState,
  type AuthProvider,
  type AuthSession,
  type DbClient,
  type GenerationJob,
  type ImageRecord,
  type JobPatch,
  type Message,
  type NewAuthSession,
  type NewImage,
  type NewJob,
  type NewMessage,
  type NewUser,
  type Product,
  type ProductFilter,
  type QuotaResult,
  type Session,
  type SessionState,
  type User,
} from './types';

type Collection =
  | 'products'
  | 'sessions'
  | 'messages'
  | 'images'
  | 'generation_jobs'
  | 'users'
  | 'auth_sessions';

const DATA_DIR = process.env.ROOMY_DATA_DIR ?? path.join(process.cwd(), '.data');

function fileFor(collection: Collection): string {
  return path.join(DATA_DIR, `${collection}.json`);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readCollection<T>(collection: Collection): Promise<T[]> {
  try {
    const raw = await fs.readFile(fileFor(collection), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** Write via a temp file + rename so a crash mid-write cannot truncate a collection. */
async function writeCollection<T>(collection: Collection, rows: T[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const target = fileFor(collection);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

/** Serialises read-modify-write sequences inside this process. */
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function now(): string {
  return new Date().toISOString();
}

function matchesProduct(p: Product, filter: ProductFilter): boolean {
  if (filter.category && p.category !== filter.category) return false;
  if (filter.max_price_thb !== undefined && p.price_thb > filter.max_price_thb) return false;
  if (filter.color && !(p.color ?? '').toLowerCase().includes(filter.color.toLowerCase())) {
    return false;
  }
  if (filter.in_stock_only && !p.in_stock) return false;
  if (filter.style) {
    const needle = filter.style.toLowerCase();
    if (!p.style_tags.some((tag) => tag.toLowerCase().includes(needle))) return false;
  }
  return true;
}

export function createLocalDbClient(): DbClient {
  return {
    // ----- products -----
    async upsertProducts(products: Product[]): Promise<number> {
      return withWriteLock(async () => {
        const rows = await readCollection<Product>('products');
        const byId = new Map(rows.map((r) => [r.id, r]));
        for (const product of products) byId.set(product.id, product);
        const next = [...byId.values()];
        await writeCollection('products', next);
        return products.length;
      });
    },

    async deleteProductsExcept(keep: string[]): Promise<number> {
      return withWriteLock(async () => {
        const wanted = new Set(keep);
        const rows = await readCollection<Product>('products');
        const stale = rows.filter((row) => !wanted.has(row.id));
        if (stale.length === 0) return 0;

        const staleIds = new Set(stale.map((row) => row.id));
        await writeCollection(
          'products',
          rows.filter((row) => wanted.has(row.id)),
        );

        // Mirror the SQL's ON DELETE SET NULL: the placed image and the job
        // stay, they just stop pointing at a product that is gone. The files
        // are only rewritten when a reference actually changes.
        const images = await readCollection<ImageRecord>('images');
        const nextImages = images.map((image) =>
          image.product_id && staleIds.has(image.product_id)
            ? { ...image, product_id: null }
            : image,
        );
        if (nextImages.some((image, index) => image !== images[index])) {
          await writeCollection('images', nextImages);
        }

        const jobs = await readCollection<GenerationJob>('generation_jobs');
        const nextJobs = jobs.map((job) =>
          job.product_id && staleIds.has(job.product_id)
            ? { ...job, product_id: null }
            : job,
        );
        if (nextJobs.some((job, index) => job !== jobs[index])) {
          await writeCollection('generation_jobs', nextJobs);
        }

        return stale.length;
      });
    },

    async getProduct(id: string): Promise<Product | null> {
      const rows = await readCollection<Product>('products');
      return rows.find((p) => p.id === id) ?? null;
    },

    async searchProducts(filter: ProductFilter): Promise<Product[]> {
      const rows = await readCollection<Product>('products');
      const matched = rows.filter((p) => matchesProduct(p, filter));
      // Cheapest first: the bot is usually working to a budget.
      matched.sort((a, b) => a.price_thb - b.price_thb);
      return typeof filter.limit === 'number' ? matched.slice(0, filter.limit) : matched;
    },

    async countProducts(): Promise<number> {
      return (await readCollection<Product>('products')).length;
    },

    // ----- sessions -----
    async createSession(userId?: string | null): Promise<Session> {
      return withWriteLock(async () => {
        const rows = await readCollection<Session>('sessions');
        const session: Session = {
          id: randomUUID(),
          created_at: now(),
          state: emptySessionState(),
          image_quota_left: settings.imageQuotaPerSession(),
          user_id: userId ?? null,
        };
        rows.push(session);
        await writeCollection('sessions', rows);
        return session;
      });
    },

    async getSession(id: string): Promise<Session | null> {
      const rows = await readCollection<Session>('sessions');
      const found = rows.find((s) => s.id === id);
      if (!found) return null;
      // Same guarantee as the Supabase adapter, in case the JSON file was
      // hand-edited or written by an older version.
      return { ...found, state: normalizeSessionState(found.state) };
    },

    async updateSessionState(id: string, state: SessionState): Promise<void> {
      await withWriteLock(async () => {
        const rows = await readCollection<Session>('sessions');
        const index = rows.findIndex((s) => s.id === id);
        if (index === -1) return;
        rows[index] = { ...rows[index], state };
        await writeCollection('sessions', rows);
      });
    },

    async consumeImageQuota(id: string): Promise<QuotaResult> {
      return withWriteLock(async () => {
        const rows = await readCollection<Session>('sessions');
        const index = rows.findIndex((s) => s.id === id);
        if (index === -1) return { ok: false, left: 0 };
        const session = rows[index];
        if (session.image_quota_left <= 0) {
          return { ok: false, left: 0 };
        }
        session.image_quota_left -= 1;
        rows[index] = session;
        await writeCollection('sessions', rows);
        return { ok: true, left: session.image_quota_left };
      });
    },

    async deleteSession(id: string): Promise<void> {
      await withWriteLock(async () => {
        const sessions = await readCollection<Session>('sessions');
        await writeCollection(
          'sessions',
          sessions.filter((s) => s.id !== id),
        );
        // Mirror the SQL's ON DELETE CASCADE.
        const messages = await readCollection<Message>('messages');
        await writeCollection(
          'messages',
          messages.filter((m) => m.session_id !== id),
        );
        const images = await readCollection<ImageRecord>('images');
        await writeCollection(
          'images',
          images.filter((i) => i.session_id !== id),
        );
        const jobs = await readCollection<GenerationJob>('generation_jobs');
        await writeCollection(
          'generation_jobs',
          jobs.filter((j) => j.session_id !== id),
        );
      });
    },

    async listSessionIdsCreatedBefore(cutoff: Date): Promise<string[]> {
      const rows = await readCollection<Session>('sessions');
      const limit = cutoff.toISOString();
      // ISO-8601 timestamps compare correctly as strings, so no Date parsing
      // is needed — and a row written with a different timezone still sorts.
      return rows.filter((s) => s.created_at < limit).map((s) => s.id);
    },

    async listSessionsForUser(userId: string, limit = 50): Promise<Session[]> {
      const rows = await readCollection<Session>('sessions');
      return rows
        .filter((s) => s.user_id === userId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((s) => ({ ...s, state: normalizeSessionState(s.state) }));
    },

    async attachSessionToUser(sessionId: string, userId: string): Promise<void> {
      await withWriteLock(async () => {
        const rows = await readCollection<Session>('sessions');
        const index = rows.findIndex((s) => s.id === sessionId);
        if (index === -1) return;
        rows[index] = { ...rows[index], user_id: userId };
        await writeCollection('sessions', rows);
      });
    },

    // ----- messages -----
    async addMessage(sessionId: string, msg: NewMessage): Promise<Message> {
      return withWriteLock(async () => {
        const rows = await readCollection<Message>('messages');
        const record: Message = {
          id: randomUUID(),
          session_id: sessionId,
          role: msg.role,
          content: msg.content,
          created_at: now(),
        };
        rows.push(record);
        await writeCollection('messages', rows);
        return record;
      });
    },

    async listMessages(sessionId: string): Promise<Message[]> {
      const rows = await readCollection<Message>('messages');
      return rows
        .filter((m) => m.session_id === sessionId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    // ----- images -----
    async addImage(input: NewImage): Promise<ImageRecord> {
      return withWriteLock(async () => {
        const rows = await readCollection<ImageRecord>('images');
        const record: ImageRecord = {
          id: randomUUID(),
          session_id: input.session_id,
          kind: input.kind,
          storage_path: input.storage_path,
          product_id: input.product_id ?? null,
          area: input.area ?? null,
          created_at: now(),
        };
        rows.push(record);
        await writeCollection('images', rows);
        return record;
      });
    },

    async getImage(id: string): Promise<ImageRecord | null> {
      const rows = await readCollection<ImageRecord>('images');
      return rows.find((i) => i.id === id) ?? null;
    },

    async listImages(sessionId: string): Promise<ImageRecord[]> {
      const rows = await readCollection<ImageRecord>('images');
      return rows
        .filter((i) => i.session_id === sessionId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    // ----- generation jobs -----
    async createJob(input: NewJob): Promise<GenerationJob> {
      return withWriteLock(async () => {
        const rows = await readCollection<GenerationJob>('generation_jobs');
        const record: GenerationJob = {
          id: randomUUID(),
          session_id: input.session_id,
          status: 'queued',
          room_image_id: input.room_image_id,
          product_id: input.product_id,
          area: input.area,
          result_image_id: null,
          error: null,
          created_at: now(),
        };
        rows.push(record);
        await writeCollection('generation_jobs', rows);
        return record;
      });
    },

    async getJob(id: string): Promise<GenerationJob | null> {
      const rows = await readCollection<GenerationJob>('generation_jobs');
      return rows.find((j) => j.id === id) ?? null;
    },

    async updateJob(id: string, patch: JobPatch): Promise<GenerationJob> {
      return withWriteLock(async () => {
        const rows = await readCollection<GenerationJob>('generation_jobs');
        const index = rows.findIndex((j) => j.id === id);
        if (index === -1) throw new Error(`generation job not found: ${id}`);
        const updated: GenerationJob = { ...rows[index], ...patch };
        rows[index] = updated;
        await writeCollection('generation_jobs', rows);
        return updated;
      });
    },

    // ----- accounts -----
    async createUser(input: NewUser): Promise<User | null> {
      return withWriteLock(async () => {
        const rows = await readCollection<User>('users');
        const email = input.email.trim().toLowerCase();
        if (rows.some((u) => u.email === email)) return null;
        const user: User = {
          id: randomUUID(),
          email,
          display_name: input.display_name ?? null,
          provider: input.provider,
          provider_id: input.provider_id ?? null,
          password_hash: input.password_hash ?? null,
          created_at: now(),
        };
        rows.push(user);
        await writeCollection('users', rows);
        return user;
      });
    },

    async getUser(id: string): Promise<User | null> {
      const rows = await readCollection<User>('users');
      return rows.find((u) => u.id === id) ?? null;
    },

    async getUserByEmail(email: string): Promise<User | null> {
      const needle = email.trim().toLowerCase();
      const rows = await readCollection<User>('users');
      return rows.find((u) => u.email === needle) ?? null;
    },

    async getUserByProvider(provider: AuthProvider, providerId: string): Promise<User | null> {
      const rows = await readCollection<User>('users');
      return rows.find((u) => u.provider === provider && u.provider_id === providerId) ?? null;
    },

    // ----- signed-in sessions -----
    async createAuthSession(input: NewAuthSession): Promise<AuthSession> {
      return withWriteLock(async () => {
        const rows = await readCollection<AuthSession>('auth_sessions');
        const record: AuthSession = {
          id: randomUUID(),
          user_id: input.user_id,
          token_hash: input.token_hash,
          created_at: now(),
          expires_at: input.expires_at,
          revoked_at: null,
        };
        rows.push(record);
        await writeCollection('auth_sessions', rows);
        return record;
      });
    },

    async getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
      const rows = await readCollection<AuthSession>('auth_sessions');
      return rows.find((s) => s.token_hash === tokenHash) ?? null;
    },

    async revokeAuthSession(id: string): Promise<void> {
      await withWriteLock(async () => {
        const rows = await readCollection<AuthSession>('auth_sessions');
        const index = rows.findIndex((s) => s.id === id);
        if (index === -1) return;
        rows[index] = { ...rows[index], revoked_at: now() };
        await writeCollection('auth_sessions', rows);
      });
    },
  };
}