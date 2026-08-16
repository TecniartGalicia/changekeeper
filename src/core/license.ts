/**
 * Licence state machine, pure and testable. The VS Code layer supplies storage (secrets/globalState),
 * a fetch implementation and the clock.
 *
 * Polar customer-portal endpoints (unauthenticated, per https://polar.sh/docs/features/benefits/license-keys):
 *   POST /v1/customer-portal/license-keys/activate   { key, organization_id, label, meta? }  → { id, ... } (activation)
 *   POST /v1/customer-portal/license-keys/validate   { key, organization_id, activation_id? } → { status, expires_at, ... }
 *   POST /v1/customer-portal/license-keys/deactivate { key, organization_id, activation_id }
 *
 * Rules:
 *  - A licence validated within REVALIDATE_HOURS is Pro without touching the network.
 *  - Offline grace: a licence last *validated* within GRACE_DAYS keeps working when the network is down
 *    or the API answers something we do not understand.
 *  - A negative answer is never final: we ask again after REVALIDATE_HOURS (disputes get resolved,
 *    activations get restored, APIs have bad days). What is persisted as a non-"granted" status: a 200 with an
 *    explicit status, or a *definitive* 404 from Polar (observed 2026-08: revoked/disabled key →
 *    {"error":"ResourceNotFound","detail":"License key is no longer active."}; unknown key or unknown/deactivated
 *    activation → {"error":"ResourceNotFound","detail":"Not found"}). Any other 4xx/5xx is a soft failure.
 *  - Rate limit: the endpoints answer 429 + Retry-After (≈30 s) after a handful of calls; user-initiated calls
 *    may wait once (CallOptions.retryBusy), background validation never does.
 */
export const POLAR_BASE = 'https://api.polar.sh/v1/customer-portal/license-keys';
export const GRACE_DAYS = 14;
export const REVALIDATE_HOURS = 24;

export interface LicenseState {
  version?: 1;
  key?: string;
  activationId?: string;
  /** ISO of the last successful validation with status "granted". */
  lastValidatedAt?: string;
  /** ISO of the last time we asked the API (any outcome) — throttles retries after a bad answer. */
  lastCheckedAt?: string;
  /** Last explicit status: from a 200 answer, or derived from a definitive 404 ('not-found', 'activation-removed'). */
  status?: 'granted' | 'revoked' | 'disabled' | 'expired' | 'not-found' | 'activation-removed' | string;
  expiresAt?: string | null;
  label?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; headers?: { get(name: string): string | null } }>;

export interface PolarConfig {
  organizationId: string;
  checkoutUrl: string;
}

export type ProDecision =
  | { pro: true; source: 'dev' | 'validated' | 'grace' }
  | { pro: false; reason: 'no-key' | 'not-configured' | 'invalid' | 'expired' | 'grace-expired' | 'revoked' | 'activation-removed' | 'network' };

/** Maps a persisted non-"granted" status to the reason shown to the user. */
export function reasonForStatus(status: string): 'expired' | 'revoked' | 'invalid' | 'activation-removed' {
  if (status === 'expired') return 'expired';
  if (status === 'not-found') return 'invalid';
  if (status === 'activation-removed') return 'activation-removed';
  return 'revoked';
}

const H = 3600_000;
const D = 86400_000;

function ageMs(iso: string | undefined, now: Date): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? now.getTime() - t : undefined;
}

/**
 * Purely from stored state + clock: can we decide without touching the network?
 * Returns undefined when a (re)validation is due — including after a previous bad answer, once
 * REVALIDATE_HOURS have passed. `force` always asks the network when a key exists.
 */
export function decideOffline(state: LicenseState, now: Date, devOverride = false, force = false): ProDecision | undefined {
  if (devOverride) return { pro: true, source: 'dev' };
  if (!state.key) return { pro: false, reason: 'no-key' };
  if (force) return undefined;
  const checkedAge = ageMs(state.lastCheckedAt, now);
  const recentlyChecked = checkedAge !== undefined && checkedAge >= 0 && checkedAge < REVALIDATE_HOURS * H;
  if (state.status && state.status !== 'granted') {
    return recentlyChecked ? { pro: false, reason: reasonForStatus(state.status) } : undefined;
  }
  if (state.expiresAt && new Date(state.expiresAt).getTime() < now.getTime()) {
    return recentlyChecked ? { pro: false, reason: 'expired' } : undefined;
  }
  const validatedAge = ageMs(state.lastValidatedAt, now);
  if (validatedAge !== undefined && validatedAge >= 0 && validatedAge < REVALIDATE_HOURS * H) return { pro: true, source: 'validated' };
  return undefined; // due (or clock skew) → revalidate
}

/**
 * `definitive` marks an explicit negative from Polar (404 with an error body: revoked, disabled or unknown key)
 * as opposed to a 4xx we cannot interpret; only definitive answers switch Pro off at once (see decideAfterValidation).
 */
export type ValidationResult =
  | { ok: true; status: string; expiresAt?: string | null }
  | {
      ok: false;
      kind: 'network' | 'invalid';
      definitive?: boolean;
      detail?: string;
      /** The key itself is fine, but this computer's activation no longer exists (deactivated from the portal / elsewhere). */
      activationGone?: boolean;
    };

/** Applies a validation attempt's outcome. Always records lastCheckedAt. */
export function decideAfterValidation(state: LicenseState, now: Date, result: ValidationResult): { decision: ProDecision; next: LicenseState } {
  const nowIso = now.toISOString();
  if (result.ok) {
    const expired = !!result.expiresAt && new Date(result.expiresAt).getTime() < now.getTime();
    const next: LicenseState = { ...state, status: result.status, expiresAt: result.expiresAt ?? null, lastCheckedAt: nowIso };
    if (result.status === 'granted' && !expired) {
      next.lastValidatedAt = nowIso;
      return { decision: { pro: true, source: 'validated' }, next };
    }
    return { decision: { pro: false, reason: result.status === 'expired' || expired ? 'expired' : 'revoked' }, next };
  }
  if (result.kind === 'invalid' && result.definitive) {
    // Polar said so explicitly. Off now; decideOffline keeps this answer for REVALIDATE_HOURS and then asks again,
    // so a re-enabled key comes back on its own (no permanent trap). The stale activation id is kept on purpose:
    // an activation removed elsewhere must be re-created here (enter the key again), not silently bypassed.
    const status = result.activationGone ? 'activation-removed' : /no longer active/i.test(result.detail ?? '') ? 'revoked' : 'not-found';
    return { decision: { pro: false, reason: reasonForStatus(status) }, next: { ...state, status, lastCheckedAt: nowIso } };
  }
  const next: LicenseState = { ...state, lastCheckedAt: nowIso };
  // A persisted negative answer does not come back through the grace period: only a fresh positive answer does.
  if (state.status && state.status !== 'granted') return { decision: { pro: false, reason: reasonForStatus(state.status) }, next };
  // Soft failure (network, or an answer we do not understand / 4xx): honour the grace period.
  const validatedAge = ageMs(state.lastValidatedAt, now);
  if (validatedAge !== undefined && validatedAge < GRACE_DAYS * D) {
    // negative age (clock skew) counts as "recent"
    return { decision: { pro: true, source: 'grace' }, next };
  }
  if (state.lastValidatedAt) return { decision: { pro: false, reason: result.kind === 'invalid' ? 'invalid' : 'grace-expired' }, next };
  return { decision: { pro: false, reason: result.kind === 'invalid' ? 'invalid' : 'network' }, next };
}

export function looksLikeLicenseKey(s: string): boolean {
  const k = s.trim();
  return k.length >= 16 && k.length <= 200 && /^[A-Za-z0-9._-]+$/.test(k);
}

// ---- API calls (thin; all decisions above) --------------------------------

export const REQUEST_TIMEOUT_MS = 15_000;

function detailText(data: any, fallback: string): string {
  const d = data?.detail ?? data?.error ?? data?.message;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((x) => (typeof x === 'string' ? x : x?.msg ?? JSON.stringify(x))).join('; ');
  return fallback;
}

/** Polar's customer-portal licence endpoints are rate limited (observed: HTTP 429 + `Retry-After: 30` after a handful of calls). */
export const BUSY_MAX_WAIT_MS = 60_000;
export const BUSY_DEFAULT_WAIT_MS = 30_000;
export type SleepLike = (ms: number) => Promise<void>;
const defaultSleep: SleepLike = (ms) => new Promise((r) => setTimeout(r, ms));

export interface CallOptions {
  /** Retry once after a 429, waiting Retry-After (capped). Only for user-initiated calls shown behind a progress UI. */
  retryBusy?: boolean;
  sleep?: SleepLike;
  /** Checked after the wait: a cancelled operation returns the 429 as is instead of retrying. */
  isCancelled?: () => boolean;
}

async function post(fetchImpl: FetchLike, path: string, body: Record<string, unknown>, opts: CallOptions = {}): Promise<{ ok: boolean; status: number; data: any }> {
  const once = async () => {
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? (AbortSignal as any).timeout(REQUEST_TIMEOUT_MS) : undefined;
    const res = await fetchImpl(`${POLAR_BASE}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal });
    let data: any = undefined;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { ok: res.ok, status: res.status, data, res };
  };
  let r = await once();
  if (r.status === 429 && opts.retryBusy) {
    const ra = Number(r.res.headers?.get?.('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000 + 500, BUSY_MAX_WAIT_MS) : BUSY_DEFAULT_WAIT_MS;
    await (opts.sleep ?? defaultSleep)(wait);
    if (!opts.isCancelled?.()) r = await once();
  }
  return { ok: r.ok, status: r.status, data: r.data };
}

const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function polarActivate(fetchImpl: FetchLike, cfg: PolarConfig, key: string, label: string, meta: Record<string, string>, opts: CallOptions = {}): Promise<{ ok: true; activationId: string; status: string; expiresAt?: string | null } | { ok: false; kind: 'network' | 'busy' | 'invalid' | 'limit' | 'unexpected'; message: string }> {
  try {
    const r = await post(fetchImpl, 'activate', { key, organization_id: cfg.organizationId, label, meta }, { retryBusy: true, ...opts });
    if (r.ok && r.data && typeof r.data.id === 'string') {
      const lk = r.data.license_key ?? {};
      return { ok: true, activationId: r.data.id, status: String(lk.status ?? 'granted'), expiresAt: lk.expires_at ?? null };
    }
    if (r.ok) return { ok: false, kind: 'unexpected', message: 'Unexpected answer from the licence server' };
    if (r.status === 404) return { ok: false, kind: 'invalid', message: 'License key not found' };
    if (r.status === 429) return { ok: false, kind: 'busy', message: 'HTTP 429' };
    if (TRANSIENT.has(r.status)) return { ok: false, kind: 'network', message: `HTTP ${r.status}` };
    if (r.status === 403 || r.status === 422 || r.status === 400) {
      // Observed on api.polar.sh (2026-08-16) when activating a revoked key: 403 "License key is no
      // longer active. This license key can not be activated." — that is not an activation limit.
      const detail = detailText(r.data, `HTTP ${r.status}`);
      if (/no longer active|revoked|disabled/i.test(detail)) return { ok: false, kind: 'invalid', message: detail };
      return { ok: false, kind: 'limit', message: detail };
    }
    return { ok: false, kind: 'invalid', message: detailText(r.data, `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, kind: 'network', message: e instanceof Error ? e.message : String(e) };
  }
}

export async function polarValidate(fetchImpl: FetchLike, cfg: PolarConfig, key: string, activationId?: string, opts: CallOptions = {}): Promise<ValidationResult> {
  try {
    const body: Record<string, unknown> = { key, organization_id: cfg.organizationId };
    if (activationId) body.activation_id = activationId;
    const r = await post(fetchImpl, 'validate', body, opts);
    if (r.ok && r.data && typeof r.data.status === 'string') return { ok: true, status: r.data.status, expiresAt: r.data.expires_at ?? null };
    // Observed on api.polar.sh (2026-08-15): revoked/disabled key → 404 {"error":"ResourceNotFound","detail":"License key is no longer active."};
    // unknown key, or a valid key with an unknown/deactivated activation_id → 404 {"error":"ResourceNotFound","detail":"Not found"}.
    // Only that exact shape counts as definitive (a proxy's 404 page never does).
    if (r.status === 404 && r.data && typeof r.data === 'object' && r.data.error === 'ResourceNotFound' && typeof r.data.detail === 'string') {
      const detail = detailText(r.data, '');
      if (activationId && !/no longer active/i.test(detail)) {
        // "Not found" with an activation id: the key may be fine and only this computer's activation gone. Ask about the key alone.
        const r2 = await post(fetchImpl, 'validate', { key, organization_id: cfg.organizationId }, opts);
        if (r2.ok && r2.data && typeof r2.data.status === 'string') return { ok: false, kind: 'invalid', definitive: true, detail, activationGone: true };
        if (!(r2.status === 404 && r2.data && typeof r2.data === 'object' && r2.data.error === 'ResourceNotFound')) return { ok: false, kind: r2.status >= 500 || r2.status === 429 ? 'network' : 'invalid' }; // could not tell → soft
      }
      return { ok: false, kind: 'invalid', definitive: true, detail };
    }
    if (r.status === 404 || r.status === 403 || r.status === 422 || r.status === 400) return { ok: false, kind: 'invalid' };
    return { ok: false, kind: 'network' };
  } catch {
    return { ok: false, kind: 'network' };
  }
}

export async function polarDeactivate(fetchImpl: FetchLike, cfg: PolarConfig, key: string, activationId: string, opts: CallOptions = {}): Promise<boolean> {
  try {
    const r = await post(fetchImpl, 'deactivate', { key, organization_id: cfg.organizationId, activation_id: activationId }, { retryBusy: true, ...opts });
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
}
