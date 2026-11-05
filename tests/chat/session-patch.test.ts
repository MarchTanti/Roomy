/**
 * `PATCH /api/session` — where the area picker saves a measurement.
 *
 * These are validation tests for untrusted input, and they run against the real
 * local adapter so the assertions are about what is actually persisted, not
 * about a return value nobody else reads.
 *
 * The merge semantics matter as much as the validation: the chat UI holds a
 * stale copy of the session state in memory, and a patch that rewrote the
 * whole object would let an older copy clobber a newer measurement.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Session, SessionState } from '@/lib/db/types';

// lib/db/local.ts snapshots ROOMY_DATA_DIR into a module-level const at import
// time, and a static import is hoisted above anything in this body. So the
// assignment and every import that reaches the DB have to happen dynamically,
// in this order.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'roomy-session-'));
process.env.ROOMY_DATA_DIR = DATA_DIR;
delete process.env.DB_ADAPTER;
delete process.env.GEMINI_API_KEY;

type RouteHandler = (request: Request) => Promise<Response>;

let PATCH: RouteHandler;
let POST: RouteHandler;
let getDb: Awaited<typeof import('@/lib/db')>['getDb'];
let resetDb: () => void;

beforeAll(async () => {
  ({ PATCH, POST } = await import('@/app/api/session/route'));
  ({ getDb, resetDb } = await import('@/lib/db'));
});

beforeEach(() => {
  resetDb();
});

async function newSessionId(): Promise<string> {
  const res = await POST(new Request('http://localhost/api/session', { method: 'POST' }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { session_id: string }).session_id;
}

function patch(sessionId: string, body: unknown): Request {
  return new Request('http://localhost/api/session', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, ...(body as object) }),
  });
}

const AREA = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
const LINE = { x1: 0.1, y1: 0.5, x2: 0.35, y2: 0.5 };

async function stateOf(sessionId: string): Promise<Session['state']> {
  const session = (await getDb().getSession(sessionId)) as Session;
  return session.state;
}

/** PATCH, assert the status, return the body. */
async function patchJson(sessionId: string, body: unknown, status: number): Promise<Record<string, unknown>> {
  const res = await PATCH(patch(sessionId, body));
  expect(res.status, `body was ${await res.clone().text()}`).toBe(status);
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('PATCH /api/session — saving a measurement', () => {
  it('stores the drawn area, the reference line and its real length', async () => {
    const sessionId = await newSessionId();

    const body = await patchJson(
      sessionId,
      { selected_area: AREA, reference_line: LINE, reference_cm: 60 },
      200,
    );

    expect(body.state).toMatchObject({ selected_area: AREA, reference_line: LINE, reference_cm: 60 });
    expect((await stateOf(sessionId)).selected_area).toEqual(AREA);
  });

  it('changes only the fields it was given', async () => {
    // A patch, not a replace: the chat UI keeps its own copy of the state and
    // sends back what it thinks is true.
    const sessionId = await newSessionId();
    await patchJson(sessionId, { selected_area: AREA, reference_line: LINE, reference_cm: 60 }, 200);

    await patchJson(sessionId, { reference_cm: 120 }, 200);

    const state = await stateOf(sessionId);
    expect(state.reference_cm).toBe(120);
    expect(state.selected_area).toEqual(AREA);
    expect(state.reference_line).toEqual(LINE);
  });

  it('leaves the rest of the session alone', async () => {
    const sessionId = await newSessionId();
    const before = (await stateOf(sessionId)) as SessionState;
    await getDb().updateSessionState(sessionId, {
      ...before,
      room_image_id: 'img-1',
      preferences: { style: 'japandi', budget_thb: 20000, category: 'sofa' },
    });

    await patchJson(sessionId, { selected_area: AREA, reference_line: LINE, reference_cm: 60 }, 200);

    const state = await stateOf(sessionId);
    expect(state.room_image_id).toBe('img-1');
    expect(state.preferences.style).toBe('japandi');
  });

  it('clears a measurement when null is sent', async () => {
    const sessionId = await newSessionId();
    await patchJson(sessionId, { selected_area: AREA, reference_line: LINE, reference_cm: 60 }, 200);

    await patchJson(sessionId, { selected_area: null, reference_line: null, reference_cm: null }, 200);

    const state = await stateOf(sessionId);
    expect(state.selected_area).toBeNull();
    expect(state.reference_line).toBeNull();
    expect(state.reference_cm).toBeNull();
  });

  it('rejects a partial area', async () => {
    const sessionId = await newSessionId();

    await patchJson(sessionId, { selected_area: { x: 0.1, y: 0.2 } }, 400);
    expect((await stateOf(sessionId)).selected_area).toBeNull();
  });

  it('rejects a partial line', async () => {
    const sessionId = await newSessionId();

    await patchJson(sessionId, { reference_line: { x1: 0, y1: 0 } }, 400);
  });

  it('rejects extra keys inside the geometry', async () => {
    const sessionId = await newSessionId();

    await patchJson(sessionId, { selected_area: { ...AREA, sneaky: 1 } }, 400);
  });

  it('rejects unknown top-level keys', async () => {
    // A typo like `reference_cm2` would otherwise be silently ignored, and the
    // user would wonder why their measurement never arrived.
    const sessionId = await newSessionId();

    await patchJson(sessionId, { reference_cm2: 60 }, 400);
  });

  it('rejects coordinates outside the photo', async () => {
    const sessionId = await newSessionId();

    await patchJson(sessionId, { selected_area: { ...AREA, x: 1.5 } }, 400);
    await patchJson(sessionId, { selected_area: { ...AREA, y: -0.1 } }, 400);
    await patchJson(sessionId, { reference_line: { ...LINE, x2: 2 } }, 400);
  });

  it('rejects an area with no extent', async () => {
    // A zero-sized box would divide by zero the moment anything tried to use it.
    const sessionId = await newSessionId();

    await patchJson(sessionId, { selected_area: { x: 0.1, y: 0.1, w: 0, h: 0.5 } }, 400);
    await patchJson(sessionId, { selected_area: { x: 0.1, y: 0.1, w: 0.5, h: 0 } }, 400);
  });

  it('rejects a reference length that is not a real length', async () => {
    const sessionId = await newSessionId();

    await patchJson(sessionId, { reference_cm: 0 }, 400);
    await patchJson(sessionId, { reference_cm: -60 }, 400);
    await patchJson(sessionId, { reference_cm: '60' }, 400);
  });

  it('rejects a non-finite coordinate', async () => {
    const sessionId = await newSessionId();
    const body = JSON.stringify({ session_id: sessionId, reference_cm: 60, selected_area: AREA });
    const res = await PATCH(
      new Request('http://localhost/api/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: body.replace('"w":0.5', '"w":1e999'),
      }),
    );

    expect(res.status).toBe(400);
  });

  it('rejects a bad session id with 400 and an unknown one with 404', async () => {
    await patchJson('not-a-uuid', { reference_cm: 60 }, 400);
    await patchJson('00000000-0000-4000-8000-000000000000', { reference_cm: 60 }, 404);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await PATCH(
      new Request('http://localhost/api/session', { method: 'PATCH', body: 'nope' }),
    );

    expect(res.status).toBe(400);
  });
});