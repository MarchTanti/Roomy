/**
 * Supabase adapter — the real Postgres + Storage backend.
 *
 * Implements the same `DbClient` interface as the local adapter, so switching is
 * `DB_ADAPTER=supabase` plus `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
 *
 * Status: written to the schema in `supabase/migrations/0001_init.sql`, but it
 * cannot be exercised until a Supabase project exists. The local adapter is the
 * tested path. See README "Swapping to Supabase".
 *
 * Security note: this uses the SERVICE ROLE key, which bypasses RLS by design.
 * That is the correct choice for a server-side adapter that already scopes every
 * query by `session_id`. The RLS policies in the migration exist to stop a
 * leaked anon/browser key from reading another session's rows — not to protect
 * this server path.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { requireEnv } from '../env';
import { settings } from '../env';
import {
  isMissingColumnError,
  isMissingRelationError,
  MissingColumnError,
  MissingTableError,
} from './errors';
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

/** Wraps a supabase-js error into a thrown Error, since every method rejects. */
function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(`Supabase: ${error.message}`);
  if (data === null) throw new Error('Supabase: query returned no rows');
  return data;
}

/**
 * The `sessions.user_id` column arrives with `0003_auth.sql`.
 *
 * Until the user applies that migration the chat still has to work, so the
 * insert tries with the column and falls back to leaving it out. The first
 * failure decides for the rest of the process — the answer cannot change
 * while the server is up.
 */
let hasUserIdColumn: boolean | null = null;

export function createSupabaseDbClient(injected?: SupabaseClient): DbClient {
  // The client can be handed in so a test can drive the adapter without a
  // database. In production nothing is passed, and the real client is built
  // from the environment.
  const client: SupabaseClient =
    injected ??
    createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  return {
    // ----- products -----
    async upsertProducts(products: Product[]): Promise<number> {
      if (products.length === 0) return 0;
      const { error } = await client.from('products').upsert(products, { onConflict: 'id' });
      if (error) throw new Error(`Supabase: ${error.message}`);
      return products.length;
    },

    async deleteProductsExcept(keep: string[]): Promise<number> {
      // The ids of the rows that are no longer in the catalogue. Asking for
      // them first keeps the delete list short — a `not.in` over the whole
      // catalogue would put every id in the query string.
      const { data: existing, error: listError } = await client
        .from('products')
        .select('id');
      if (listError) throw new Error(`Supabase: ${listError.message}`);

      const wanted = new Set(keep);
      const stale = (existing ?? [])
        .map((row) => row.id as string)
        .filter((id) => !wanted.has(id));
      if (stale.length === 0) return 0;

      // Cut the references before the delete, not after.
      //
      // `supabase/migrations/0001_init.sql` gives these two columns
      // `ON DELETE SET NULL`, so the database would clear them by itself — but
      // a database created from an earlier version of that file has the plain
      // `references products(id)` rule, and Postgres then refuses the delete
      // with "violates foreign key constraint images_product_id_fkey". Clearing
      // the links here works under either rule, and means the same thing: the
      // image and the job stay, they just stop pointing at a product that is
      // gone. This is what the local adapter does, and what
      // `supabase/migrations/0004_product_fk_set_null.sql` puts the database
      // back in step with.
      for (const table of ['images', 'generation_jobs'] as const) {
        const { error } = await client
          .from(table)
          .update({ product_id: null })
          .in('product_id', stale);
        if (!error) continue;
        // A table or a column that is not there yet holds no references, so
        // there is nothing to clear on it.
        if (isMissingColumnError(error.message) || isMissingRelationError(error.message)) continue;
        throw new Error(
          `Supabase: could not clear ${table}.product_id — ${error.message}. ` +
            'If the column is NOT NULL, run supabase/migrations/0004_product_fk_set_null.sql in the SQL editor.',
        );
      }

      // `select` asks PostgREST to hand back the rows it deleted, so the
      // count is the rows themselves rather than a header.
      const { data: deleted, error: deleteError } = await client
        .from('products')
        .delete()
        .in('id', stale)
        .select('id');
      if (deleteError) throw new Error(`Supabase: ${deleteError.message}`);
      return deleted?.length ?? stale.length;
    },

    async getProduct(id: string): Promise<Product | null> {
      const { data, error } = await client
        .from('products')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return data as Product | null;
    },

    async searchProducts(filter: ProductFilter): Promise<Product[]> {
      let query = client.from('products').select('*');
      if (filter.category) query = query.eq('category', filter.category);
      if (filter.max_price_thb !== undefined) query = query.lte('price_thb', filter.max_price_thb);
      if (filter.color) query = query.ilike('color', `%${filter.color}%`);
      if (filter.in_stock_only) query = query.eq('in_stock', true);
      if (filter.style) query = query.contains('style_tags', [filter.style]);
      query = query.order('price_thb', { ascending: true });
      if (typeof filter.limit === 'number') query = query.limit(filter.limit);
      return unwrap(await query) as Product[];
    },

    async countProducts(): Promise<number> {
      const { count, error } = await client
        .from('products')
        .select('id', { count: 'exact', head: true });
      if (error) throw new Error(`Supabase: ${error.message}`);
      return count ?? 0;
    },

    // ----- sessions -----
    async createSession(userId?: string | null): Promise<Session> {
      const base = {
        state: emptySessionState(),
        image_quota_left: settings.imageQuotaPerSession(),
      };

      if (hasUserIdColumn === false) {
        return unwrap(
          await client.from('sessions').insert(base).select('*').single(),
        ) as unknown as Session;
      }

      const withOwner = { ...base, user_id: userId ?? null };
      const { data, error } = await client.from('sessions').insert(withOwner).select('*').single();
      if (error) {
        if (isMissingColumnError(error.message)) {
          // The migration has not been applied yet. Chat still works.
          hasUserIdColumn = false;
          return unwrap(
            await client.from('sessions').insert(base).select('*').single(),
          ) as unknown as Session;
        }
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as Session;
    },

    async getSession(id: string): Promise<Session | null> {
      const { data, error } = await client.from('sessions').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      if (data === null) return null;
      const row = data as unknown as Session;
      // jsonb default is '{}'; normalise so callers always see all 9 fields.
      return { ...row, state: normalizeSessionState(row.state) };
    },

    async updateSessionState(id: string, state: SessionState): Promise<void> {
      const { error } = await client.from('sessions').update({ state }).eq('id', id);
      if (error) throw new Error(`Supabase: ${error.message}`);
    },

    async consumeImageQuota(id: string): Promise<QuotaResult> {
      // Atomic: the SQL function decrements only when the balance is positive.
      const left = unwrap(await client.rpc('consume_image_quota', { p_session_id: id }));
      return { ok: left > 0, left };
    },

    async deleteSession(id: string): Promise<void> {
      // The child rows go first, in the order the foreign keys allow: a job
      // points at a session, an image and a product; an image points at a
      // session and a product; a message points at a session.
      //
      // The migration gives all three `on delete cascade`, so deleting the
      // session alone would be enough — but a database whose foreign keys
      // carry the plain `references sessions(id)` rule refuses the delete
      // instead, and the session stays with all of its rows. Removing the
      // children here works under either rule, and it is what the local
      // adapter does.
      //
      // The order matters: the jobs go before the images, because a job may
      // point at an image that is about to be deleted.
      const children: { table: string; column: string }[] = [
        { table: 'generation_jobs', column: 'session_id' },
        { table: 'images', column: 'session_id' },
        { table: 'messages', column: 'session_id' },
      ];

      for (const { table, column } of children) {
        const { error } = await client.from(table).delete().eq(column, id);
        if (error) throw new Error(`Supabase: ${error.message}`);
      }

      const { error } = await client.from('sessions').delete().eq('id', id);
      if (error) throw new Error(`Supabase: ${error.message}`);
    },

    async listSessionIdsCreatedBefore(cutoff: Date): Promise<string[]> {
      const rows = unwrap(
        await client
          .from('sessions')
          .select('id')
          .lt('created_at', cutoff.toISOString()),
      );
      return rows.map((row) => String(row.id));
    },

    async listSessionsForUser(userId: string, limit = 50): Promise<Session[]> {
      const { data, error } = await client
        .from('sessions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) {
        if (isMissingColumnError(error.message)) {
          hasUserIdColumn = false;
          return [];
        }
        throw new Error(`Supabase: ${error.message}`);
      }
      return (data as unknown as Session[]).map((row) => ({
        ...row,
        state: normalizeSessionState(row.state),
      }));
    },

    async attachSessionToUser(sessionId: string, userId: string): Promise<void> {
      const { error } = await client.from('sessions').update({ user_id: userId }).eq('id', sessionId);
      if (error) {
        if (isMissingColumnError(error.message)) {
          hasUserIdColumn = false;
          return;
        }
        throw new Error(`Supabase: ${error.message}`);
      }
    },

    // ----- messages -----
    async addMessage(sessionId: string, msg: NewMessage): Promise<Message> {
      const row = unwrap(
        await client
          .from('messages')
          .insert({ session_id: sessionId, role: msg.role, content: msg.content })
          .select('*')
          .single(),
      );
      return row as unknown as Message;
    },

    async listMessages(sessionId: string): Promise<Message[]> {
      const rows = unwrap(
        await client
          .from('messages')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true }),
      );
      return rows as Message[];
    },

    // ----- images -----
    async addImage(input: NewImage): Promise<ImageRecord> {
      const row = unwrap(
        await client
          .from('images')
          .insert({
            session_id: input.session_id,
            kind: input.kind,
            storage_path: input.storage_path,
            product_id: input.product_id ?? null,
            area: input.area ?? null,
          })
          .select('*')
          .single(),
      );
      return row as unknown as ImageRecord;
    },

    async getImage(id: string): Promise<ImageRecord | null> {
      const { data, error } = await client.from('images').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return data as ImageRecord | null;
    },

    async listImages(sessionId: string): Promise<ImageRecord[]> {
      const rows = unwrap(
        await client
          .from('images')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true }),
      );
      return rows as ImageRecord[];
    },

    // ----- generation jobs -----
    async createJob(input: NewJob): Promise<GenerationJob> {
      const row = unwrap(
        await client
          .from('generation_jobs')
          .insert({
            session_id: input.session_id,
            room_image_id: input.room_image_id,
            product_id: input.product_id,
            area: input.area,
          })
          .select('*')
          .single(),
      );
      return row as unknown as GenerationJob;
    },

    async getJob(id: string): Promise<GenerationJob | null> {
      const { data, error } = await client
        .from('generation_jobs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return data as GenerationJob | null;
    },

    async updateJob(id: string, patch: JobPatch): Promise<GenerationJob> {
      const row = unwrap(
        await client.from('generation_jobs').update(patch).eq('id', id).select('*').single(),
      );
      return row as unknown as GenerationJob;
    },

    // ----- accounts -----
    async createUser(input: NewUser): Promise<User | null> {
      const { data, error } = await client
        .from('users')
        .insert({
          email: input.email.trim().toLowerCase(),
          display_name: input.display_name ?? null,
          provider: input.provider,
          provider_id: input.provider_id ?? null,
          password_hash: input.password_hash ?? null,
        })
        .select('*')
        .single();

      if (error) {
        // 23505 is the unique violation: the email is already taken.
        if (error.code === '23505') return null;
        if (isMissingRelationError(error.message)) throw new MissingTableError('users');
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as User;
    },

    async getUser(id: string): Promise<User | null> {
      const { data, error } = await client.from('users').select('*').eq('id', id).maybeSingle();
      if (error) {
        if (isMissingRelationError(error.message)) throw new MissingTableError('users');
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as User | null;
    },

    async getUserByEmail(email: string): Promise<User | null> {
      const { data, error } = await client
        .from('users')
        .select('*')
        .eq('email', email.trim().toLowerCase())
        .maybeSingle();
      if (error) {
        if (isMissingRelationError(error.message)) throw new MissingTableError('users');
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as User | null;
    },

    async getUserByProvider(provider: AuthProvider, providerId: string): Promise<User | null> {
      const { data, error } = await client
        .from('users')
        .select('*')
        .eq('provider', provider)
        .eq('provider_id', providerId)
        .maybeSingle();
      if (error) {
        if (isMissingRelationError(error.message)) throw new MissingTableError('users');
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as User | null;
    },

    // ----- signed-in sessions -----
    async createAuthSession(input: NewAuthSession): Promise<AuthSession> {
      const { data, error } = await client
        .from('auth_sessions')
        .insert({
          user_id: input.user_id,
          token_hash: input.token_hash,
          expires_at: input.expires_at,
        })
        .select('*')
        .single();
      if (error) {
        if (isMissingRelationError(error.message)) throw new MissingTableError('auth_sessions');
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as AuthSession;
    },

    async getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSession | null> {
      const { data, error } = await client
        .from('auth_sessions')
        .select('*')
        .eq('token_hash', tokenHash)
        .maybeSingle();
      if (error) {
        if (isMissingRelationError(error.message)) throw new MissingTableError('auth_sessions');
        throw new Error(`Supabase: ${error.message}`);
      }
      return data as unknown as AuthSession | null;
    },

    async revokeAuthSession(id: string): Promise<void> {
      const { error } = await client
        .from('auth_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', id);
      if (error) {
        if (isMissingRelationError(error.message)) throw new MissingTableError('auth_sessions');
        throw new Error(`Supabase: ${error.message}`);
      }
    },
  };
}