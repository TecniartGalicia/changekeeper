import * as assert from 'assert';
import { decideAfterValidation, decideOffline, FetchLike, LicenseState, looksLikeLicenseKey, polarActivate, polarDeactivate, polarValidate, reasonForStatus } from '../../core/license';

describe('licence state machine', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const iso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString();

  it('offline decisions', () => {
    assert.deepStrictEqual(decideOffline({}, now), { pro: false, reason: 'no-key' });
    assert.deepStrictEqual(decideOffline({}, now, true), { pro: true, source: 'dev' });
    assert.deepStrictEqual(decideOffline({ key: 'k', lastValidatedAt: iso(1), status: 'granted' }, now), { pro: true, source: 'validated' });
    assert.strictEqual(decideOffline({ key: 'k', lastValidatedAt: iso(30), status: 'granted' }, now), undefined, 'older than 24h → revalidate');
    assert.strictEqual(decideOffline({ key: 'k', lastValidatedAt: iso(1), status: 'granted' }, now, false, true), undefined, 'force → always ask');
    assert.strictEqual(decideOffline({ key: 'k', lastValidatedAt: new Date(now.getTime() + 3600_000).toISOString() }, now), undefined, 'clock skew forward → revalidate');
  });

  it('a non-granted status is retried after 24h (no permanent trap)', () => {
    assert.deepStrictEqual(decideOffline({ key: 'k', status: 'revoked', lastCheckedAt: iso(1) }, now), { pro: false, reason: 'revoked' }, 'recently checked → trust it');
    assert.strictEqual(decideOffline({ key: 'k', status: 'revoked', lastCheckedAt: iso(25) }, now), undefined, 'stale → ask again');
    assert.strictEqual(decideOffline({ key: 'k', status: 'revoked' }, now), undefined, 'never checked → ask');
    assert.deepStrictEqual(decideOffline({ key: 'k', status: 'granted', lastValidatedAt: iso(1), lastCheckedAt: iso(1), expiresAt: iso(2) }, now), { pro: false, reason: 'expired' });
    assert.strictEqual(decideOffline({ key: 'k', status: 'granted', lastValidatedAt: iso(1), lastCheckedAt: iso(30), expiresAt: iso(2) }, now), undefined, 'expired but stale check → ask (renewals happen)');
  });

  it('after validation: granted / revoked → re-granted / expired / soft failures honour grace', () => {
    const base: LicenseState = { key: 'k', activationId: 'a', lastValidatedAt: iso(48) };
    let r = decideAfterValidation(base, now, { ok: true, status: 'granted', expiresAt: null });
    assert.deepStrictEqual(r.decision, { pro: true, source: 'validated' });
    assert.strictEqual(r.next.lastValidatedAt, now.toISOString());
    assert.strictEqual(r.next.lastCheckedAt, now.toISOString());
    r = decideAfterValidation(base, now, { ok: true, status: 'revoked' });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'revoked' });
    const regranted = decideAfterValidation(r.next, new Date(now.getTime() + 48 * 3600_000), { ok: true, status: 'granted', expiresAt: null });
    assert.deepStrictEqual(regranted.decision, { pro: true, source: 'validated' }, 'revoked → granted again works');
    r = decideAfterValidation(base, now, { ok: true, status: 'granted', expiresAt: iso(1) });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'expired' });
    r = decideAfterValidation(base, now, { ok: false, kind: 'invalid' });
    assert.deepStrictEqual(r.decision, { pro: true, source: 'grace' }, 'a 4xx within grace is a soft failure');
    assert.notStrictEqual(r.next.status, 'revoked', 'a 4xx never persists a revoked status');
    r = decideAfterValidation({ ...base, lastValidatedAt: iso(24 * 10) }, now, { ok: false, kind: 'network' });
    assert.deepStrictEqual(r.decision, { pro: true, source: 'grace' }, '10 days offline → still Pro');
    r = decideAfterValidation({ ...base, lastValidatedAt: iso(24 * 15) }, now, { ok: false, kind: 'network' });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'grace-expired' });
    r = decideAfterValidation({ ...base, lastValidatedAt: iso(24 * 15) }, now, { ok: false, kind: 'invalid' });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'invalid' });
    r = decideAfterValidation({ key: 'k' }, now, { ok: false, kind: 'network' });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'network' });
    r = decideAfterValidation({ ...base, lastValidatedAt: new Date(now.getTime() + 3600_000).toISOString() }, now, { ok: false, kind: 'network' });
    assert.deepStrictEqual(r.decision, { pro: true, source: 'grace' }, 'clock skew + no network → grace, not "14 days offline"');
  });

  it('key shape', () => {
    assert.ok(looksLikeLicenseKey('ABCD-1234-EFGH-5678-IJKL'));
    assert.ok(!looksLikeLicenseKey('short'));
    assert.ok(!looksLikeLicenseKey('has spaces in it and is long enough'));
  });

  it('polar calls: request shape, response mapping, transient vs invalid (fake fetch)', async () => {
    const calls: { url: string; body: any; signal?: AbortSignal }[] = [];
    const fake =
      (status: number, data: any): FetchLike =>
      async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
        return { ok: status >= 200 && status < 300, status, json: async () => data };
      };
    const cfg = { organizationId: 'org_1', checkoutUrl: '' };
    const a = await polarActivate(fake(200, { id: 'act_1', license_key: { status: 'granted', expires_at: null } }), cfg, 'KEY', 'my-pc', { platform: 'win32' });
    assert.deepStrictEqual(a, { ok: true, activationId: 'act_1', status: 'granted', expiresAt: null });
    assert.ok(calls[0].url.endsWith('/activate'));
    assert.ok(calls[0].signal, 'a timeout signal is passed');
    assert.deepStrictEqual(calls[0].body, { key: 'KEY', organization_id: 'org_1', label: 'my-pc', meta: { platform: 'win32' } });
    assert.deepStrictEqual(await polarActivate(fake(404, { detail: 'nope' }), cfg, 'KEY', 'pc', {}), { ok: false, kind: 'invalid', message: 'License key not found' });
    const lim = await polarActivate(fake(403, { detail: [{ msg: 'License key activation limit already reached' }] }), cfg, 'KEY', 'pc', {});
    assert.ok(!lim.ok && lim.kind === 'limit' && /limit already reached/.test(lim.message), JSON.stringify(lim));
    assert.strictEqual((await polarActivate(fake(429, {}), cfg, 'KEY', 'pc', {}, { retryBusy: false }) as any).kind, 'busy');
    assert.strictEqual((await polarActivate(fake(503, {}), cfg, 'KEY', 'pc', {}, { retryBusy: false }) as any).kind, 'network');
    assert.strictEqual((await polarActivate(fake(200, { weird: true }), cfg, 'KEY', 'pc', {}) as any).kind, 'unexpected');
    const v = await polarValidate(fake(200, { status: 'granted', expires_at: '2027-01-01T00:00:00Z' }), cfg, 'KEY', 'act_1');
    assert.deepStrictEqual(v, { ok: true, status: 'granted', expiresAt: '2027-01-01T00:00:00Z' });
    assert.deepStrictEqual(calls[calls.length - 1].body, { key: 'KEY', organization_id: 'org_1', activation_id: 'act_1' });
    assert.deepStrictEqual(await polarValidate(fake(404, {}), cfg, 'KEY'), { ok: false, kind: 'invalid' });
    assert.deepStrictEqual(await polarValidate(fake(503, {}), cfg, 'KEY'), { ok: false, kind: 'network' });
    const throwing: FetchLike = async () => {
      throw new Error('offline');
    };
    assert.deepStrictEqual(await polarValidate(throwing, cfg, 'KEY'), { ok: false, kind: 'network' });
  });

  it('polar 429: one retry honouring Retry-After (capped), only when asked', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const seq = (answers: { status: number; data: any; retryAfter?: string }[]): FetchLike => {
      let i = 0;
      return async () => {
        const a = answers[Math.min(i++, answers.length - 1)];
        return { ok: a.status < 300, status: a.status, json: async () => a.data, headers: { get: (n: string) => (n === 'retry-after' ? (a.retryAfter ?? null) : null) } };
      };
    };
    const cfg = { organizationId: 'org_1', checkoutUrl: '' };
    const okAfter = seq([{ status: 429, data: {}, retryAfter: '30' }, { status: 200, data: { id: 'act_2', license_key: { status: 'granted' } } }]);
    const a = await polarActivate(okAfter, cfg, 'KEY', 'pc', {}, { retryBusy: true, sleep });
    assert.ok(a.ok && a.activationId === 'act_2', 'activated on the retry');
    assert.deepStrictEqual(waits, [30_500], 'waited Retry-After (+0.5 s)');
    waits.length = 0;
    const capped = seq([{ status: 429, data: {}, retryAfter: '600' }, { status: 200, data: { status: 'granted', expires_at: null } }]);
    assert.deepStrictEqual(await polarValidate(capped, cfg, 'KEY', undefined, { retryBusy: true, sleep }), { ok: true, status: 'granted', expiresAt: null });
    assert.deepStrictEqual(waits, [60_000], 'wait capped at 60 s');
    waits.length = 0;
    const noHeader = seq([{ status: 429, data: {} }, { status: 200, data: {} }]);
    assert.strictEqual(await polarDeactivate(noHeader, cfg, 'KEY', 'act', { retryBusy: true, sleep }), true);
    assert.deepStrictEqual(waits, [30_000], 'default wait without Retry-After');
    waits.length = 0;
    // background validation never waits: 429 is a transient network failure (grace period applies)
    assert.deepStrictEqual(await polarValidate(seq([{ status: 429, data: {}, retryAfter: '30' }]), cfg, 'KEY'), { ok: false, kind: 'network' });
    assert.deepStrictEqual(waits, []);
    // still 429 after the retry → busy
    const still = seq([{ status: 429, data: {}, retryAfter: '30' }]);
    assert.strictEqual((await polarActivate(still, cfg, 'KEY', 'pc', {}, { retryBusy: true, sleep }) as any).kind, 'busy');
    assert.strictEqual(waits.length, 1, 'exactly one retry');
  });

  it('polar 404 with an explicit error body is definitive: revoked/disabled key switches Pro off now (and comes back when re-enabled)', async () => {
    const cfg = { organizationId: 'org_1', checkoutUrl: '' };
    const fake =
      (status: number, data: any): FetchLike =>
      async () => ({ ok: status < 300, status, json: async () => data });
    // Observed on api.polar.sh (2026-08-15) after "Disable"/"Revoke" in the dashboard:
    const revoked = await polarValidate(fake(404, { error: 'ResourceNotFound', detail: 'License key is no longer active.' }), cfg, 'KEY', 'act');
    assert.deepStrictEqual(revoked, { ok: false, kind: 'invalid', definitive: true, detail: 'License key is no longer active.' });
    const unknown = await polarValidate(fake(404, { error: 'ResourceNotFound', detail: 'Not found' }), cfg, 'KEY');
    assert.ok(!unknown.ok && unknown.kind === 'invalid' && unknown.definitive === true && !unknown.activationGone);
    // a bare 404 (no body) or a 404 page from a proxy stays a soft failure
    assert.deepStrictEqual(await polarValidate(fake(404, undefined), cfg, 'KEY'), { ok: false, kind: 'invalid' });
    assert.deepStrictEqual(await polarValidate(fake(404, { error: 'Not Found', detail: 'nginx' }), cfg, 'KEY'), { ok: false, kind: 'invalid' });

    const now = new Date('2026-08-15T12:00:00Z');
    const iso = (hAgo: number) => new Date(now.getTime() - hAgo * 3600_000).toISOString();
    const state: LicenseState = { key: 'k', activationId: 'a', lastValidatedAt: iso(2), status: 'granted' };
    let r = decideAfterValidation(state, now, revoked);
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'revoked' }, 'off immediately, no 14-day grace after a refund');
    assert.strictEqual(r.next.status, 'revoked');
    assert.strictEqual(r.next.lastCheckedAt, now.toISOString());
    // held offline for REVALIDATE_HOURS, then asked again — no permanent trap
    assert.deepStrictEqual(decideOffline(r.next, new Date(now.getTime() + 3600_000)), { pro: false, reason: 'revoked' });
    assert.strictEqual(decideOffline(r.next, new Date(now.getTime() + 25 * 3600_000)), undefined, 'revalidation due after 24 h');
    const back = decideAfterValidation(r.next, new Date(now.getTime() + 25 * 3600_000), { ok: true, status: 'granted', expiresAt: null });
    assert.deepStrictEqual(back.decision, { pro: true, source: 'validated' }, 're-enabled key comes back on its own');
    r = decideAfterValidation(state, now, unknown);
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'invalid' });
    assert.strictEqual(r.next.status, 'not-found');
    assert.deepStrictEqual(decideOffline(r.next, new Date(now.getTime() + 3600_000)), { pro: false, reason: 'invalid' }, 'not-found reads as invalid offline too');
    // soft invalid (no body) keeps the audited grace behaviour
    r = decideAfterValidation(state, now, { ok: false, kind: 'invalid' });
    assert.deepStrictEqual(r.decision, { pro: true, source: 'grace' });
    // ...but a persisted negative status never comes back through the grace period, only through a fresh 200
    r = decideAfterValidation({ ...state, status: 'revoked', lastCheckedAt: iso(25) }, now, { ok: false, kind: 'network' });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'revoked' }, 'offline after a revocation: still off');
    assert.strictEqual(r.next.lastCheckedAt, now.toISOString(), 'and re-asked after 24 h (no trap)');
    r = decideAfterValidation({ ...state, status: 'activation-removed' }, now, { ok: false, kind: 'invalid' });
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'activation-removed' });
    assert.deepStrictEqual(['expired', 'not-found', 'activation-removed', 'revoked', 'disabled', 'whatever'].map(reasonForStatus), ['expired', 'invalid', 'activation-removed', 'revoked', 'revoked', 'revoked']);
  });

  it("polar 404 'Not found' with an activation id: a second key-only call tells a removed activation from an unknown key", async () => {
    const cfg = { organizationId: 'org_1', checkoutUrl: '' };
    const bodies: any[] = [];
    const seq = (answers: { status: number; data: any }[]): FetchLike => {
      let i = 0;
      return async (_u, init) => {
        bodies.push(JSON.parse(init.body));
        const a = answers[Math.min(i++, answers.length - 1)];
        return { ok: a.status < 300, status: a.status, json: async () => a.data };
      };
    };
    const nf = { error: 'ResourceNotFound', detail: 'Not found' };
    // key fine, activation gone (deactivated from the portal / another computer)
    let v = await polarValidate(seq([{ status: 404, data: nf }, { status: 200, data: { status: 'granted', expires_at: null } }]), cfg, 'KEY', 'act_old');
    assert.deepStrictEqual(v, { ok: false, kind: 'invalid', definitive: true, detail: 'Not found', activationGone: true });
    assert.deepStrictEqual(bodies.map((b) => 'activation_id' in b), [true, false], 'second call is key-only');
    const now = new Date('2026-08-15T12:00:00Z');
    const state: LicenseState = { key: 'k', activationId: 'act_old', lastValidatedAt: new Date(now.getTime() - 3600_000).toISOString(), status: 'granted' };
    const r = decideAfterValidation(state, now, v);
    assert.deepStrictEqual(r.decision, { pro: false, reason: 'activation-removed' });
    assert.strictEqual(r.next.status, 'activation-removed');
    assert.strictEqual(r.next.activationId, 'act_old', 'stale id kept: re-activation is required, the limit is not bypassed');
    assert.deepStrictEqual(decideOffline(r.next, new Date(now.getTime() + 3600_000)), { pro: false, reason: 'activation-removed' });
    // key unknown: both calls 404 → plain not-found
    bodies.length = 0;
    v = await polarValidate(seq([{ status: 404, data: nf }]), cfg, 'KEY', 'act_old');
    assert.deepStrictEqual(v, { ok: false, kind: 'invalid', definitive: true, detail: 'Not found' });
    assert.strictEqual(bodies.length, 2);
    // second call rate limited / down: cannot tell → soft failure (grace), never definitive
    assert.deepStrictEqual(await polarValidate(seq([{ status: 404, data: nf }, { status: 429, data: {} }]), cfg, 'KEY', 'act_old'), { ok: false, kind: 'network' });
    assert.deepStrictEqual(await polarValidate(seq([{ status: 404, data: nf }, { status: 503, data: {} }]), cfg, 'KEY', 'act_old'), { ok: false, kind: 'network' });
    assert.deepStrictEqual(await polarValidate(seq([{ status: 404, data: nf }, { status: 422, data: { detail: [] } }]), cfg, 'KEY', 'act_old'), { ok: false, kind: 'invalid' });
    // revoked with an activation id: definitive at once, no second call
    bodies.length = 0;
    v = await polarValidate(seq([{ status: 404, data: { error: 'ResourceNotFound', detail: 'License key is no longer active.' } }]), cfg, 'KEY', 'act_old');
    assert.ok(!v.ok && v.definitive && !v.activationGone && bodies.length === 1);
    // key-only validation never makes a second call
    bodies.length = 0;
    v = await polarValidate(seq([{ status: 404, data: nf }]), cfg, 'KEY');
    assert.ok(!v.ok && v.definitive && bodies.length === 1);
  });

  it('polar 429: cancellation skips the retry; a fetch without headers uses the default wait', async () => {
    const cfg = { organizationId: 'org_1', checkoutUrl: '' };
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    let calls = 0;
    const busyNoHeaders: FetchLike = async () => {
      calls++;
      return { ok: false, status: 429, json: async () => ({}) };
    };
    const a = await polarActivate(busyNoHeaders, cfg, 'KEY', 'pc', {}, { sleep, isCancelled: () => true });
    assert.strictEqual((a as any).kind, 'busy');
    assert.strictEqual(calls, 1, 'cancelled during the wait → no second call');
    assert.deepStrictEqual(waits, [30_000], 'no Retry-After header → default wait');
    calls = 0;
    waits.length = 0;
    const d = await polarDeactivate(busyNoHeaders, cfg, 'KEY', 'act', { sleep });
    assert.strictEqual(d, false);
    assert.strictEqual(calls, 2, 'defaults still retry once when only sleep is overridden');
  });
});
