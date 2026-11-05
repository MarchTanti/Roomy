/**
 * Errors the database adapters raise.
 *
 * The Supabase adapter talks to a database the user applies the migrations to
 * by hand. When a table is not there yet, the failure is not a bug in the app
 * — it is a step that has not happened. These errors let the route handlers
 * say so in plain language instead of returning a stack trace.
 */

/** The table this part of the app needs does not exist yet. */
export class MissingTableError extends Error {
  readonly table: string;

  constructor(table: string) {
    super(`table "${table}" does not exist`);
    this.name = 'MissingTableError';
    this.table = table;
  }
}

/** The column this part of the app needs does not exist yet. */
export class MissingColumnError extends Error {
  readonly column: string;

  constructor(column: string) {
    super(`column "${column}" does not exist`);
    this.name = 'MissingColumnError';
    this.column = column;
  }
}

/**
 * True when a Postgres error means "that table is not in this database".
 *
 * PostgREST says it in a few ways depending on whether the schema cache was
 * warm, so the check looks for the words rather than one exact sentence.
 */
export function isMissingRelationError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('does not exist') && (m.includes('relation') || m.includes('table'))) return true;
  return m.includes('schema cache');
}

/** True when a Postgres error means "that column is not in this table". */
export function isMissingColumnError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('does not exist') && m.includes('column');
}
