import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

process.env.NODE_ENV = 'test';

import { attachWebSocketHub, createLandConnectApp } from '../server.ts';
import { CallSignalingEngine } from '../server/callEngine.ts';
import { SqliteStore } from '../server/store.ts';

let tmpDir: string;
let dbPath: string;
let uploadsDir: string;
let store: SqliteStore;
let engine: CallSignalingEngine;
let server: http.Server;
let baseUrl: string;
let wsBaseUrl: string;
let heartbeatTimer: ReturnType<typeof setInterval>;

async function apiJson<T = Record<string, unknown>>(
  reqPath: string,
  options: RequestInit & { token?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; headers: Headers; body: T }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
  };
  const res = await fetch(`${baseUrl}${reqPath}`, { ...options, headers });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : {}) as T;
  return { status: res.status, headers: res.headers, body };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landconnect-test-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  uploadsDir = path.join(tmpDir, 'uploads');

  store = new SqliteStore(dbPath);
  engine = new CallSignalingEngine(store);
  const { app } = createLandConnectApp({ store, callEngine: engine, uploadsDir });
  server = http.createServer(app);
  const hub = attachWebSocketHub(server, store, engine);
  heartbeatTimer = hub.heartbeatTimer;

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsBaseUrl = `ws://127.0.0.1:${addr.port}`;
});

after(async () => {
  clearInterval(heartbeatTimer);
  engine.shutdownTimers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SQLite runs in WAL mode and /health/deep reports healthy', async () => {
  const { status, body } = await apiJson<{
    status: string;
    checks: { datastore: { engine: string; journal_mode: string; users: number; listings: number } };
  }>('/health/deep');
  assert.equal(status, 200);
  assert.equal(body.status, 'healthy');
  assert.equal(body.checks.datastore.engine, 'sqlite_wal');
  assert.equal(body.checks.datastore.journal_mode, 'wal');
  assert.ok(body.checks.datastore.users >= 3);
  assert.ok(body.checks.datastore.listings >= 11);
});

test('Public showcase & listings support ₹50 Lakhs budget and Karnataka-wide city filtering', async () => {
  const pubRes = await apiJson<{ count: number; listings: Array<{ id: string; price_inr: number; city: string }> }>(
    '/api/v1/public/listings?sort=price_asc',
  );
  assert.equal(pubRes.status, 200);
  assert.ok(pubRes.body.listings.some((l) => l.price_inr === 5000000 && l.city === 'Mysuru'));
  assert.ok(pubRes.body.listings.some((l) => l.city === 'Mangaluru'));
  assert.ok(pubRes.body.listings.some((l) => l.city === 'Hubballi'));
  assert.ok(pubRes.body.listings.some((l) => l.city === 'Chikkamagaluru'));
  assert.ok(pubRes.body.listings.some((l) => l.city === 'Belagavi'));

  const buyer = (
    await apiJson<{ access_token: string }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'BUYER' }),
    })
  ).body;

  const budget50L = await apiJson<{ listings: Array<{ price_inr: number; city: string }> }>(
    '/api/v1/listings?max_price=5000000&sort=price_asc',
    { token: buyer.access_token },
  );
  assert.equal(budget50L.status, 200);
  assert.ok(budget50L.body.listings.length >= 1);
  assert.ok(budget50L.body.listings.every((l) => l.price_inr <= 5000000));

  const mysuruOnly = await apiJson<{ listings: Array<{ city: string }> }>(
    '/api/v1/listings?city=Mysuru',
    { token: buyer.access_token },
  );
  assert.equal(mysuruOnly.status, 200);
  assert.ok(mysuruOnly.body.listings.length >= 1);
  assert.ok(mysuruOnly.body.listings.every((l) => l.city === 'Mysuru'));
});

test('Real registration, login, refresh token rotation, and logout revocation work', async () => {
  const email = 'rohan.test@landconnect.in';
  const password = 'StrongPassword#2026';

  const weakRes = await apiJson('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: '123', display_name: 'Rohan', role: 'SELLER' }),
  });
  assert.equal(weakRes.status, 400);

  const regRes = await apiJson<{
    access_token: string;
    refresh_token: string;
    user: { user_uuid: string; role: string; email: string };
  }>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      display_name: 'Rohan Kulkarni',
      role: 'SELLER',
      phone: '+91-98111-22334',
      city: 'Mysuru',
    }),
  });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.body.user.role, 'SELLER');
  assert.ok(regRes.body.access_token);

  const dupRes = await apiJson('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: 'Dup', role: 'BUYER' }),
  });
  assert.equal(dupRes.status, 409);

  const refresh1 = await apiJson<{ access_token: string; refresh_token: string }>('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: regRes.body.refresh_token }),
  });
  assert.equal(refresh1.status, 200);

  // Reusing rotated refresh token must fail
  const reuse = await apiJson('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: regRes.body.refresh_token }),
  });
  assert.equal(reuse.status, 401);

  // Logout revokes the active refresh token
  await apiJson('/api/v1/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refresh1.body.refresh_token }),
  });
  const afterLogout = await apiJson('/api/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refresh1.body.refresh_token }),
  });
  assert.equal(afterLogout.status, 401);
});

test('1-click Demo Role Switcher works for BUYER, SELLER, and BROKER', async () => {
  for (const role of ['BUYER', 'SELLER', 'BROKER'] as const) {
    const res = await apiJson<{ access_token: string; user: { role: string } }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, role);
    assert.ok(res.body.access_token);
  }
});

test('RBAC, idempotency, optimistic concurrency, spatial filters, and upload validation enforce guarantees', async () => {
  const buyer = (
    await apiJson<{ access_token: string }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'BUYER' }),
    })
  ).body;
  const seller = (
    await apiJson<{ access_token: string }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'SELLER' }),
    })
  ).body;
  const broker = (
    await apiJson<{ access_token: string }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'BROKER' }),
    })
  ).body;

  // Buyer cannot create listing
  const buyerCreate = await apiJson('/api/v1/listings', {
    method: 'POST',
    token: buyer.access_token,
    body: JSON.stringify({
      title: 'Unauthorized Buyer Plot',
      price_inr: 5000000,
      area_sqft: 2400,
      land_type: 'RESIDENTIAL',
      latitude: 12.97,
      longitude: 77.59,
    }),
  });
  assert.equal(buyerCreate.status, 403);

  // Seller creates listing with Idempotency-Key
  const idemKey = 'test_listing_idem_001';
  const create1 = await apiJson<{ id: string; version: number; price_inr: number }>('/api/v1/listings', {
    method: 'POST',
    token: seller.access_token,
    idempotencyKey: idemKey,
    body: JSON.stringify({
      title: 'Yelahanka Lakefront Villa Parcel',
      description: 'Surveyed clear title residential parcel near Yelahanka bypass.',
      price_inr: 42000000,
      area_sqft: 6000,
      land_type: 'RESIDENTIAL',
      latitude: 13.1007,
      longitude: 77.5963,
    }),
  });
  assert.equal(create1.status, 201);

  const createReplay = await apiJson<{ id: string }>('/api/v1/listings', {
    method: 'POST',
    token: seller.access_token,
    idempotencyKey: idemKey,
    body: JSON.stringify({
      title: 'Yelahanka Lakefront Villa Parcel',
      price_inr: 42000000,
      area_sqft: 6000,
      land_type: 'RESIDENTIAL',
      latitude: 13.1007,
      longitude: 77.5963,
    }),
  });
  assert.equal(createReplay.status, 201);
  assert.equal(createReplay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(createReplay.body.id, create1.body.id);

  // Optimistic update succeeds with version=1, conflicts with stale version=1
  const updOk = await apiJson<{ version: number }>(`/api/v1/listings/${create1.body.id}`, {
    method: 'PATCH',
    token: seller.access_token,
    body: JSON.stringify({ price_inr: 43500000, version: 1 }),
  });
  assert.equal(updOk.status, 200);
  assert.equal(updOk.body.version, 2);

  const updStale = await apiJson(`/api/v1/listings/${create1.body.id}`, {
    method: 'PATCH',
    token: seller.access_token,
    body: JSON.stringify({ price_inr: 44000000, version: 1 }),
  });
  assert.equal(updStale.status, 409);

  // Broker verifies parcel
  const verifyRes = await apiJson<{ verification_status: string }>(
    `/api/v1/listings/${create1.body.id}/verify`,
    {
      method: 'PATCH',
      token: broker.access_token,
      body: JSON.stringify({ verification_status: 'RERA_APPROVED' }),
    },
  );
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.body.verification_status, 'RERA_APPROVED');

  // Spatial nearby & bbox queries find created parcel
  const nearby = await apiJson<{ count: number; listings: Array<{ id: string }> }>(
    '/api/v1/listings/nearby?lat=13.1007&lng=77.5963&radius_km=5',
    { token: buyer.access_token },
  );
  assert.equal(nearby.status, 200);
  assert.ok(nearby.body.listings.some((l) => l.id === create1.body.id));

  const bbox = await apiJson<{ listings: Array<{ id: string }> }>(
    '/api/v1/listings/bbox?min_lng=77.55&min_lat=13.05&max_lng=77.65&max_lat=13.15',
    { token: buyer.access_token },
  );
  assert.equal(bbox.status, 200);
  assert.ok(bbox.body.listings.some((l) => l.id === create1.body.id));

  // Image upload blocks spoofed non-PNG bytes
  const badUpload = await apiJson('/api/v1/listings/upload-image', {
    method: 'POST',
    token: seller.access_token,
    body: JSON.stringify({
      filename: 'fake.png',
      data_url: `data:image/png;base64,${Buffer.from('not-a-real-png-header-at-all').toString('base64')}`,
    }),
  });
  assert.equal(badUpload.status, 400);

  // Valid PNG magic header succeeds
  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const okUpload = await apiJson<{ url: string }>('/api/v1/listings/upload-image', {
    method: 'POST',
    token: seller.access_token,
    body: JSON.stringify({
      filename: 'plot.png',
      data_url: `data:image/png;base64,${validPng.toString('base64')}`,
    }),
  });
  assert.equal(okUpload.status, 201);
  assert.ok(okUpload.body.url.startsWith('/uploads/'));
});

test('Privacy consent masking and real-time 2-tab WS chat + call signaling work end-to-end', async () => {
  const buyerLogin = (
    await apiJson<{ access_token: string; user: { user_uuid: string } }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'BUYER' }),
    })
  ).body;
  const sellerLogin = (
    await apiJson<{ access_token: string; user: { user_uuid: string } }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'SELLER' }),
    })
  ).body;

  // Before consent, buyer sees seller contact masked
  const usersBefore = await apiJson<{
    users: Array<{ user_uuid: string; phone?: string; contact_revealed: boolean }>;
  }>('/api/v1/users', { token: buyerLogin.access_token });
  const sellerBefore = usersBefore.body.users.find((u) => u.user_uuid === sellerLogin.user.user_uuid)!;
  assert.equal(sellerBefore.contact_revealed, false);
  assert.equal(sellerBefore.phone, undefined);

  // Seller grants consent to Buyer
  const consentRes = await apiJson<{ consented_peer_uuids?: string[] }>('/api/v1/auth/privacy', {
    method: 'PATCH',
    token: sellerLogin.access_token,
    body: JSON.stringify({
      show_contact_after_consent: true,
      consent_peer_uuid: buyerLogin.user.user_uuid,
    }),
  });
  assert.equal(consentRes.status, 200);
  assert.ok(consentRes.body.consented_peer_uuids?.includes(buyerLogin.user.user_uuid));

  const usersAfter = await apiJson<{
    users: Array<{ user_uuid: string; phone?: string; contact_revealed: boolean; consented_peer_uuids?: string[] }>;
  }>('/api/v1/users', { token: buyerLogin.access_token });
  const sellerAfter = usersAfter.body.users.find((u) => u.user_uuid === sellerLogin.user.user_uuid)!;
  assert.equal(sellerAfter.contact_revealed, true);
  assert.ok(sellerAfter.phone);
  assert.equal(sellerAfter.consented_peer_uuids, undefined);

  // Seller revokes consent and phone/email are masked again
  await apiJson('/api/v1/auth/privacy', {
    method: 'PATCH',
    token: sellerLogin.access_token,
    body: JSON.stringify({ revoke_peer_uuid: buyerLogin.user.user_uuid }),
  });
  const usersRevoked = await apiJson<{
    users: Array<{ user_uuid: string; phone?: string; contact_revealed: boolean }>;
  }>('/api/v1/users', { token: buyerLogin.access_token });
  const sellerRevoked = usersRevoked.body.users.find((u) => u.user_uuid === sellerLogin.user.user_uuid)!;
  assert.equal(sellerRevoked.contact_revealed, false);
  assert.equal(sellerRevoked.phone, undefined);

  // Maps config endpoint returns clean status without leaking server secrets
  const mapsCfg = await apiJson<{ configured: boolean; geminiApiKey?: string }>('/api/v1/config/maps');
  assert.equal(mapsCfg.status, 200);
  assert.equal(typeof mapsCfg.body.configured, 'boolean');
  assert.equal(mapsCfg.body.geminiApiKey, undefined);

  // Connect both users over WebSockets
  const buyerEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sellerEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const buyerWs = new WebSocket(`${wsBaseUrl}/ws?token=${encodeURIComponent(buyerLogin.access_token)}`);
  const sellerWs = new WebSocket(`${wsBaseUrl}/ws?token=${encodeURIComponent(sellerLogin.access_token)}`);

  await Promise.all([
    new Promise<void>((res) => buyerWs.once('open', () => res())),
    new Promise<void>((res) => sellerWs.once('open', () => res())),
  ]);
  buyerWs.on('message', (d) => buyerEvents.push(JSON.parse(d.toString())));
  sellerWs.on('message', (d) => sellerEvents.push(JSON.parse(d.toString())));

  // Buyer initiates call inside seeded direct room
  const initRes = await apiJson<{ call: { call_id: string; state: string } }>('/api/v1/calls/initiate', {
    method: 'POST',
    token: buyerLogin.access_token,
    idempotencyKey: 'call_idem_e2e_1',
    body: JSON.stringify({ room_id: 'chat_direct_sarjapur_01', mode: 'VIDEO' }),
  });
  assert.equal(initRes.status, 201);
  assert.equal(initRes.body.call.state, 'RINGING');

  await new Promise((r) => setTimeout(r, 80));
  assert.ok(sellerEvents.some((e) => e.event === 'call.invite'));

  // Seller accepts call
  const acceptRes = await apiJson<{ call: { state: string } }>(
    `/api/v1/calls/${initRes.body.call.call_id}/accept`,
    { method: 'POST', token: sellerLogin.access_token },
  );
  assert.equal(acceptRes.status, 200);
  assert.equal(acceptRes.body.call.state, 'CONNECTED');

  // End call
  const endRes = await apiJson<{ call: { state: string } }>(
    `/api/v1/calls/${initRes.body.call.call_id}/end`,
    { method: 'POST', token: buyerLogin.access_token },
  );
  assert.equal(endRes.status, 200);
  assert.equal(endRes.body.call.state, 'ENDED');

  buyerWs.close();
  sellerWs.close();

  // Crash recovery check: simulate leftover RINGING row in SQLite and verify reconcileOnBoot closes it as MISSED
  store.createCallSession({
    call_id: 'call_orphan_boot_1',
    room_id: 'chat_direct_sarjapur_01',
    listing_id: 'lst_sarjapur_02',
    caller_uuid: buyerLogin.user.user_uuid,
    callee_uuids: [sellerLogin.user.user_uuid],
    mode: 'AUDIO',
    state: 'RINGING',
    webrtc_room_name: 'lc_orphan',
    started_at: new Date().toISOString(),
    duration_seconds: 0,
  });
  const fixed = engine.reconcileOnBoot();
  assert.ok(fixed >= 1);
  const reconciled = store.findCallById('call_orphan_boot_1');
  assert.equal(reconciled?.state, 'MISSED');
  assert.equal(reconciled?.end_reason, 'server_restart');
});

test('Enterprise upgrades: pagination, Deal Room PDF attachments, blocking, reporting, profile/password updates, and env-gated controls', async () => {
  // 1. Pagination metadata
  const page1 = await apiJson<{
    count: number;
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
    listings: Array<{ id: string }>;
  }>('/api/v1/public/listings?limit=4&offset=0');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.count, 4);
  assert.equal(page1.body.limit, 4);
  assert.equal(page1.body.offset, 0);
  assert.ok(page1.body.total >= 11);
  assert.equal(page1.body.has_more, true);

  // 2. Register two independent accounts and test profile + password updates
  const p1 = await apiJson<{
    access_token: string;
    user: { user_uuid: string; display_name: string };
  }>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'ananya.buyer@landconnect.in',
      password: 'Password#1234',
      display_name: 'Ananya Rao',
      role: 'BUYER',
      city: 'Bengaluru',
    }),
  });
  assert.equal(p1.status, 201);

  const p2 = await apiJson<{
    access_token: string;
    user: { user_uuid: string };
  }>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: 'suresh.seller@landconnect.in',
      password: 'Password#1234',
      display_name: 'Suresh Gowda',
      role: 'SELLER',
      city: 'Mysuru',
    }),
  });
  assert.equal(p2.status, 201);

  const profPatch = await apiJson<{ display_name: string; city: string }>('/api/v1/auth/profile', {
    method: 'PATCH',
    token: p1.body.access_token,
    body: JSON.stringify({ display_name: 'Ananya K. Rao', city: 'Mysuru', bio: 'Agricultural investor' }),
  });
  assert.equal(profPatch.status, 200);
  assert.equal(profPatch.body.display_name, 'Ananya K. Rao');
  assert.equal(profPatch.body.city, 'Mysuru');

  const pwBad = await apiJson('/api/v1/auth/change-password', {
    method: 'POST',
    token: p1.body.access_token,
    body: JSON.stringify({ current_password: 'WrongPassword', new_password: 'NewStrongPassword#99' }),
  });
  assert.equal(pwBad.status, 401);

  const pwOk = await apiJson('/api/v1/auth/change-password', {
    method: 'POST',
    token: p1.body.access_token,
    body: JSON.stringify({ current_password: 'Password#1234', new_password: 'NewStrongPassword#99' }),
  });
  assert.equal(pwOk.status, 200);

  const loginNewPw = await apiJson('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ananya.buyer@landconnect.in', password: 'NewStrongPassword#99' }),
  });
  assert.equal(loginNewPw.status, 200);

  // 3. Deal Room PDF attachment magic-byte check & persistence
  const sellerCreate = await apiJson<{ id: string }>('/api/v1/listings', {
    method: 'POST',
    token: p2.body.access_token,
    body: JSON.stringify({
      title: 'Hunsur Organic Estate Plot',
      price_inr: 6500000,
      area_sqft: 21780,
      land_type: 'AGRICULTURAL',
      latitude: 12.305,
      longitude: 76.288,
    }),
  });
  assert.equal(sellerCreate.status, 201);

  const directRoom = await apiJson<{ id: string }>('/api/v1/chats/direct', {
    method: 'POST',
    token: p1.body.access_token,
    body: JSON.stringify({ listing_id: sellerCreate.body.id, peer_uuid: p2.body.user.user_uuid }),
  });
  assert.equal(directRoom.status, 201);

  const badPdf = await apiJson(`/api/v1/chats/${directRoom.body.id}/attachments`, {
    method: 'POST',
    token: p2.body.access_token,
    body: JSON.stringify({
      filename: 'spoof.pdf',
      data_url: `data:application/pdf;base64,${Buffer.from('NOT_A_PDF_FILE').toString('base64')}`,
    }),
  });
  assert.equal(badPdf.status, 400);

  const validPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
  const okPdf = await apiJson<{ attachment_url: string; attachment_name: string; attachment_type: string }>(
    `/api/v1/chats/${directRoom.body.id}/attachments`,
    {
      method: 'POST',
      token: p2.body.access_token,
      body: JSON.stringify({
        filename: 'bhoomi-rtc.pdf',
        data_url: `data:application/pdf;base64,${validPdfBytes.toString('base64')}`,
        body: 'Latest Bhoomi RTC extract attached',
      }),
    },
  );
  assert.equal(okPdf.status, 201);
  assert.ok(okPdf.body.attachment_url.startsWith('/uploads/attachments/'));
  assert.equal(okPdf.body.attachment_name, 'bhoomi-rtc.pdf');
  assert.equal(okPdf.body.attachment_type, 'application/pdf');

  // 4. Listing report & User blocking enforcement on messages and calls
  const reportRes = await apiJson<{ id: string; listing_id: string }>(
    `/api/v1/listings/${sellerCreate.body.id}/report`,
    {
      method: 'POST',
      token: p1.body.access_token,
      body: JSON.stringify({ reason: 'Incorrect coordinates or zoning', details: 'Check boundary' }),
    },
  );
  assert.equal(reportRes.status, 201);
  assert.equal(reportRes.body.listing_id, sellerCreate.body.id);

  const blockRes = await apiJson('/api/v1/users/' + p1.body.user.user_uuid + '/block', {
    method: 'POST',
    token: p2.body.access_token,
    body: JSON.stringify({ reason: 'Test block' }),
  });
  assert.equal(blockRes.status, 201);

  const msgBlocked = await apiJson(`/api/v1/chats/${directRoom.body.id}/messages`, {
    method: 'POST',
    token: p1.body.access_token,
    body: JSON.stringify({ body: 'Can you hear me?' }),
  });
  assert.equal(msgBlocked.status, 403);

  const callBlocked = await apiJson('/api/v1/calls/initiate', {
    method: 'POST',
    token: p1.body.access_token,
    body: JSON.stringify({ room_id: directRoom.body.id, mode: 'AUDIO' }),
  });
  assert.equal(callBlocked.status, 403);

  await apiJson('/api/v1/users/' + p1.body.user.user_uuid + '/block', {
    method: 'DELETE',
    token: p2.body.access_token,
  });

  const msgAfterUnblock = await apiJson(`/api/v1/chats/${directRoom.body.id}/messages`, {
    method: 'POST',
    token: p1.body.access_token,
    body: JSON.stringify({ body: 'Unblocked follow-up message' }),
  });
  assert.equal(msgAfterUnblock.status, 201);

  // 5. Env-gated demo auth & metrics bearer token + grounding cache store
  store.setGroundingCache(sellerCreate.body.id, 'highway', {
    listing_id: sellerCreate.body.id,
    search_summary: 'Cached highway insight',
  });
  const cachedHit = store.getGroundingCache(sellerCreate.body.id, 'highway', 12);
  assert.equal(cachedHit?.search_summary, 'Cached highway insight');

  const prevDemo = process.env.ENABLE_DEMO_AUTH;
  const prevMetrics = process.env.METRICS_TOKEN;
  try {
    process.env.ENABLE_DEMO_AUTH = 'false';
    process.env.METRICS_TOKEN = 'secret-prom-token';

    const pubCfg = await apiJson<{ demoAuthEnabled: boolean }>('/api/v1/config/public');
    assert.equal(pubCfg.status, 200);
    assert.equal(pubCfg.body.demoAuthEnabled, false);

    const demoBlocked = await apiJson('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'BUYER' }),
    });
    assert.equal(demoBlocked.status, 403);

    const metricsUnauth = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsUnauth.status, 401);

    const metricsAuth = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: 'Bearer secret-prom-token' },
    });
    assert.equal(metricsAuth.status, 200);
  } finally {
    if (prevDemo === undefined) delete process.env.ENABLE_DEMO_AUTH;
    else process.env.ENABLE_DEMO_AUTH = prevDemo;
    if (prevMetrics === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = prevMetrics;
  }
});

test('Scalability suite: probes, wire-level gzip, FTS5 search, paginated users, and batch hydration', async () => {
  // 1. Liveness & readiness probes
  const live = await apiJson<{ status: string; uptime_sec: number }>('/health/live');
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'alive');
  assert.equal(typeof live.body.uptime_sec, 'number');

  const ready = await apiJson<{ status: string; journal_mode: string }>('/health/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
  assert.equal(ready.body.journal_mode, 'wal');

  // Verify /health/ready returns 503 when draining
  let draining = true;
  const drainApp = createLandConnectApp({ store, callEngine: engine, uploadsDir, isShuttingDown: () => draining });
  const drainServer = http.createServer(drainApp.app);
  await new Promise<void>((resolve) => drainServer.listen(0, '127.0.0.1', () => resolve()));
  const drainAddr = drainServer.address();
  assert(drainAddr && typeof drainAddr === 'object');
  const drainRes = await fetch(`http://127.0.0.1:${drainAddr.port}/health/ready`);
  assert.equal(drainRes.status, 503);
  draining = false;
  const readyAgainRes = await fetch(`http://127.0.0.1:${drainAddr.port}/health/ready`);
  assert.equal(readyAgainRes.status, 200);
  await new Promise<void>((resolve) => drainServer.close(() => resolve()));

  // 2. Wire-level gzip compression + Cache-Control on /api/v1/public/listings
  const zlib = await import('node:zlib');
  const rawGzip = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.get(
      `${baseUrl}/api/v1/public/listings?limit=24`,
      { headers: { 'Accept-Encoding': 'gzip' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
  });
  assert.equal(rawGzip.statusCode, 200);
  assert.equal(rawGzip.headers['content-encoding'], 'gzip');
  assert.match(String(rawGzip.headers['cache-control'] || ''), /public, max-age=60/);
  const decompressed = JSON.parse(zlib.gunzipSync(rawGzip.body).toString('utf8')) as {
    listings: Array<{ id: string }>;
  };
  assert.ok(decompressed.listings.length >= 11);

  // 3. FTS5 search & paginated directory + batch chat/call hydration
  const buyerLogin = (
    await apiJson<{ access_token: string }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ role: 'BUYER' }),
    })
  ).body;

  const ftsRes = await apiJson<{ listings: Array<{ id: string; title: string }> }>(
    '/api/v1/listings?q=Airport',
    { token: buyerLogin.access_token },
  );
  assert.equal(ftsRes.status, 200);
  assert.ok(ftsRes.body.listings.some((l) => l.title.includes('Airport')));

  const usersPage = await apiJson<{
    users: Array<{ user_uuid: string }>;
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }>('/api/v1/users?limit=2&offset=0', { token: buyerLogin.access_token });
  assert.equal(usersPage.status, 200);
  assert.equal(usersPage.body.users.length, 2);
  assert.equal(usersPage.body.limit, 2);
  assert.equal(usersPage.body.offset, 0);
  assert.ok(usersPage.body.total >= 4);
  assert.equal(usersPage.body.has_more, true);

  const chatsRes = await apiJson<{
    chats: Array<{ id: string; participants: Array<{ user_uuid: string }>; unread_count: number }>;
  }>('/api/v1/chats', { token: buyerLogin.access_token });
  assert.equal(chatsRes.status, 200);
  assert.ok(chatsRes.body.chats.length >= 2);
  assert.ok(chatsRes.body.chats.every((c) => c.participants.length >= 2));

  const callsLogsRes = await apiJson<{
    logs: Array<{ call_id: string; caller_profile: { user_uuid: string } | null }>;
  }>('/api/v1/calls/logs', { token: buyerLogin.access_token });
  assert.equal(callsLogsRes.status, 200);
  assert.ok(callsLogsRes.body.logs.length >= 1);
  assert.ok(callsLogsRes.body.logs.every((l) => l.caller_profile !== null));
});

