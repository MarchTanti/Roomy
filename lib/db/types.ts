/**
 * Row types and the single database interface.
 *
 * Field names are snake_case on purpose: they match the SQL in
 * `supabase/migrations/0001_init.sql` exactly, and the seed file is
 * "an array of objects with the same fields as products". This keeps the
 * Supabase adapter free of a mapping layer.
 *
 * All dimensions are centimetres. All money is THB.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type ProductSource = 'ikea' | 'homepro' | 'manual';

// ---------------------------------------------------------------------------
// products — global, not session-scoped
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  source: ProductSource;
  source_url: string;
  name_th: string;
  name_en: string;
  category: string;
  style_tags: string[];
  color: string | null;
  material: string | null;
  price_thb: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  image_url: string;
  in_stock: boolean;
}

export interface ProductFilter {
  category?: string;
  style?: string;
  max_price_thb?: number;
  color?: string;
  in_stock_only?: boolean;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Geometry shared by the client, the session state and the fit check
// ---------------------------------------------------------------------------

/** Normalised (0..1) rectangle against the room photo. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Normalised (0..1) line used to derive a real-world scale. */
export interface ReferenceLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RoomAnalysis {
  style: string;
  colors: string[];
  lighting: string;
  free_areas?: string[];
}

export interface Preferences {
  style: string | null;
  budget_thb: number | null;
  category: string | null;
}

/**
 * One piece the room has to have.
 *
 * The brief keeps the *request*, not the catalogue row: the row's price and
 * dimensions are read again when the picture is made, so a price that changed
 * in the database can never be quoted from a stale copy.
 */
export interface BriefItem {
  /** The catalogue category, e.g. 'bed'. */
  category: string;
  /** The user's own words about this piece. */
  note: string;
  /** The size the user asked for, in their own words ("3.5 ฟุต"). */
  requested_width: string | null;
  /**
   * The catalogue row chosen for this piece.
   *
   * Kept so that a later version of the same room keeps the same pieces: the
   * user asks to change the colour, not to get a different sofa.
   */
  product_id: string | null;
}

/**
 * What the user asked the room to be.
 *
 * Stored in the session so the next turn refines it instead of starting over —
 * "เปลี่ยนเป็นสีฟ้า" needs the rest of the brief to mean anything.
 */
export interface RoomBrief {
  /** The style, in the user's or the model's words. */
  style: string;
  /** The colour theme, when there is one. */
  theme: string | null;
  /** What the room is for — "ห้องนอน", "ห้องทำงาน". */
  purpose: string | null;
  /** The size of the room, in the user's own words ("24 ตารางเมตร"). */
  room_size: string | null;
  /** The floor area in square metres, parsed from `room_size` by the code. */
  room_size_m2: number | null;
  /** The floor, in centimetres, when the size is known. */
  width_cm: number | null;
  depth_cm: number | null;
  /** The budget, when the user said one. */
  budget_thb: number | null;
  items: BriefItem[];
  /** The change asked for in this version, in the user's own words. */
  instruction: string | null;
}

/**
 * The exact shape the spec sends to the LLM on every turn, as compact JSON.
 */
export interface SessionState {
  room_image_id: string | null;
  room_analysis: RoomAnalysis | null;
  preferences: Preferences;
  reference_cm: number | null;
  reference_line: ReferenceLine | null;
  selected_area: Area | null;
  shown_products: string[];
  selected_product_id: string | null;
  generated_image_ids: string[];
  /** The room the user asked to have designed, when there is one. */
  design_brief: RoomBrief | null;
}

export function emptySessionState(): SessionState {
  return {
    room_image_id: null,
    room_analysis: null,
    preferences: { style: null, budget_thb: null, category: null },
    reference_cm: null,
    reference_line: null,
    selected_area: null,
    shown_products: [],
    selected_product_id: null,
    generated_image_ids: [],
    design_brief: null,
  };
}

/**
 * Fills in every missing field of a stored `state` row.
 *
 * The `sessions.state` column is jsonb, and its SQL default is `'{}'` — so a
 * row created outside the app (or under an older schema) arrives with no
 * fields at all. Callers assume the full shape, so both adapters normalise on
 * read rather than trusting what is on disk.
 *
 * `preferences` is merged one level deep: a partial `{style}` must keep
 * `budget_thb` and `category` present.
 */
export function normalizeSessionState(raw: unknown): SessionState {
  const base = emptySessionState();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;

  const r = raw as Partial<SessionState>;
  const preferences =
    typeof r.preferences === 'object' && r.preferences !== null && !Array.isArray(r.preferences)
      ? r.preferences
      : {};

  return {
    room_image_id: r.room_image_id ?? base.room_image_id,
    room_analysis: r.room_analysis ?? base.room_analysis,
    preferences: { ...base.preferences, ...preferences },
    reference_cm: r.reference_cm ?? base.reference_cm,
    reference_line: r.reference_line ?? base.reference_line,
    selected_area: r.selected_area ?? base.selected_area,
    shown_products: Array.isArray(r.shown_products) ? r.shown_products : base.shown_products,
    selected_product_id: r.selected_product_id ?? base.selected_product_id,
    generated_image_ids: Array.isArray(r.generated_image_ids)
      ? r.generated_image_ids
      : base.generated_image_ids,
    design_brief: r.design_brief ?? base.design_brief,
  };
}

// ---------------------------------------------------------------------------
// Session-scoped tables
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  created_at: string;
  state: SessionState;
  image_quota_left: number;
  /**
   * The account this session belongs to, when there is one.
   *
   * A guest session has no owner: it belongs to whoever holds its id, and it
   * is erased with the retention sweep like any other. A session that was
   * signed in belongs to that account and is listed in its history.
   */
  user_id?: string | null;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type AuthProvider = 'local' | 'supabase';

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  provider: AuthProvider;
  /** The id the identity provider knows this person by. */
  provider_id: string | null;
  /** The scrypt hash, for a local account. Null for a provider account. */
  password_hash: string | null;
  created_at: string;
}

/** A new account. The id and the timestamp are the database's job. */
export interface NewUser {
  email: string;
  display_name?: string | null;
  provider: AuthProvider;
  provider_id?: string | null;
  password_hash?: string | null;
}

/**
 * A signed-in session of our own.
 *
 * The token never reaches the database: only its SHA-256 does. A dump of the
 * table is then useless to anyone who finds it, which is the whole point of
 * hashing it.
 */
export interface AuthSession {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface NewAuthSession {
  user_id: string;
  token_hash: string;
  expires_at: string;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: Json;
  created_at: string;
}

export type ImageKind = 'room' | 'generated';

export interface ImageRecord {
  id: string;
  session_id: string;
  kind: ImageKind;
  storage_path: string;
  product_id: string | null;
  area: Area | null;
  created_at: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface GenerationJob {
  id: string;
  session_id: string;
  status: JobStatus;
  room_image_id: string | null;
  product_id: string | null;
  area: Area;
  result_image_id: string | null;
  error: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------------

export type NewMessage = { role: MessageRole; content: Json };

export type NewImage = {
  session_id: string;
  kind: ImageKind;
  storage_path: string;
  product_id?: string | null;
  area?: Area | null;
};

export type NewJob = {
  session_id: string;
  room_image_id: string | null;
  /**
   * The piece this job places.
   *
   * Null for a room *design*: the picture is of a whole room, not of one
   * product, so there is no single row to point at.
   */
  product_id: string | null;
  area: Area;
};

export type JobPatch = {
  status?: JobStatus;
  result_image_id?: string | null;
  error?: string | null;
};

export interface QuotaResult {
  ok: boolean;
  left: number;
}

// ---------------------------------------------------------------------------
// The interface both adapters implement
// ---------------------------------------------------------------------------

/**
 * Every persistence call in the app goes through this. Two adapters implement
 * it: `local` (JSON files, zero credentials — the default) and `supabase`.
 * Swapping is one env var.
 */
export interface DbClient {
  // products
  upsertProducts(products: Product[]): Promise<number>;
  /**
   * Deletes every product whose id is not in `keep`.
   *
   * The catalogue is a whole, not a set of patches: the seed file *is* the
   * catalogue, so a piece that is no longer in it has to go — otherwise the
   * bot keeps offering furniture the app has no photograph of. Rows that
   * reference a deleted product (a placed image, a generation job) keep
   * their row and lose the reference, which is what the SQL's
   * `ON DELETE SET NULL` does.
   *
   * Returns how many rows were removed.
   */
  deleteProductsExcept(keep: string[]): Promise<number>;
  getProduct(id: string): Promise<Product | null>;
  searchProducts(filter: ProductFilter): Promise<Product[]>;
  countProducts(): Promise<number>;

  // sessions
  /**
   * Creates a chat session.
   *
   * `userId` is the signed-in account, when there is one. A guest gets a
   * session with no owner.
   */
  createSession(userId?: string | null): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  updateSessionState(id: string, state: SessionState): Promise<void>;
  /** Atomically take one unit of quota. ok=false when the quota is spent. */
  consumeImageQuota(id: string): Promise<QuotaResult>;
  deleteSession(id: string): Promise<void>;
  /**
   * The ids of every session created before `cutoff`.
   *
   * The retention sweep needs them: the rows are deleted by the adapter (and
   * cascade to messages, images and jobs), but the photos have to be removed
   * from storage first — the database does not know about the files.
   */
  listSessionIdsCreatedBefore(cutoff: Date): Promise<string[]>;
  /** The sessions of one account, newest first. */
  listSessionsForUser(userId: string, limit?: number): Promise<Session[]>;
  /** Gives a guest session an owner. Used when someone signs in mid-chat. */
  attachSessionToUser(sessionId: string, userId: string): Promise<void>;

  // messages
  addMessage(sessionId: string, msg: NewMessage): Promise<Message>;
  listMessages(sessionId: string): Promise<Message[]>;

  // images
  addImage(input: NewImage): Promise<ImageRecord>;
  getImage(id: string): Promise<ImageRecord | null>;
  listImages(sessionId: string): Promise<ImageRecord[]>;

  // generation jobs
  createJob(input: NewJob): Promise<GenerationJob>;
  getJob(id: string): Promise<GenerationJob | null>;
  updateJob(id: string, patch: JobPatch): Promise<GenerationJob>;

  // accounts
  /** Creates an account. Returns null when the email is already taken. */
  createUser(input: NewUser): Promise<User | null>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getUserByProvider(provider: AuthProvider, providerId: string): Promise<User | null>;

  // signed-in sessions
  createAuthSession(input: NewAuthSession): Promise<AuthSession>;
  /** Looks a signed-in session up by the hash of its token. */
  getAuthSessionByTokenHash(tokenHash: string): Promise<AuthSession | null>;
  /** Ends a signed-in session. The token stops working straight away. */
  revokeAuthSession(id: string): Promise<void>;
}