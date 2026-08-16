import * as os from 'os';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { decideAfterValidation, decideOffline, FetchLike, LicenseState, looksLikeLicenseKey, polarActivate, polarDeactivate, polarValidate, ProDecision } from '../core/license';
import { log } from '../vscode/env';
import { DEV_UNLOCK_ENV, POLAR_CHECKOUT_URL, POLAR_ORGANIZATION_ID, polarConfigured, PRO_INFO_URL, PRO_PRICE_LABEL } from './polarConfig';

const SECRET_KEY = 'changekeeper.license';
/** Cheap flag so free commands never touch secret storage on machines that never had a licence. */
const STATE_HAS_LICENSE = 'changekeeper.hasLicense';

const fetchImpl: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;
const cfg = () => ({ organizationId: POLAR_ORGANIZATION_ID, checkoutUrl: POLAR_CHECKOUT_URL });

export async function loadState(context: vscode.ExtensionContext): Promise<LicenseState> {
  if (!context.globalState.get<boolean>(STATE_HAS_LICENSE)) return {};
  try {
    const raw = await context.secrets.get(SECRET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed && typeof parsed.key === 'string' ? (parsed as LicenseState) : {};
  } catch {
    return {};
  }
}

async function saveState(context: vscode.ExtensionContext, state: LicenseState): Promise<void> {
  if (!state.key) {
    await context.secrets.delete(SECRET_KEY);
    await context.globalState.update(STATE_HAS_LICENSE, undefined);
  } else {
    await context.secrets.store(SECRET_KEY, JSON.stringify({ ...state, version: 1 }));
    await context.globalState.update(STATE_HAS_LICENSE, true);
  }
}

function devUnlocked(): boolean {
  return process.env[DEV_UNLOCK_ENV] === '1';
}

/** Session cache + in-flight de-duplication: a burst of commands causes at most one validation. */
let cached: { at: number; decision: ProDecision } | undefined;
let inflight: Promise<ProDecision> | undefined;
/** Fires when the Pro yes/no answer flips (activation, revocation, grace expiry…) so features can react live. */
export const onDidChangeProStatus = new vscode.EventEmitter<ProDecision>();
let lastPro: boolean | undefined;
function remember(decision: ProDecision): void {
  cached = { at: Date.now(), decision };
  if (lastPro !== undefined && lastPro !== decision.pro) onDidChangeProStatus.fire(decision);
  lastPro = decision.pro;
}

export function invalidateProCache(): void {
  cached = undefined;
}

/** Decides Pro status: offline first, network (throttled) only when needed. Never throws. */
export async function proStatus(context: vscode.ExtensionContext, force = false): Promise<ProDecision> {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.decision;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const now = new Date();
      const state = await loadState(context);
      let decision = decideOffline(state, now, devUnlocked(), force);
      if (!decision) {
        if (!polarConfigured()) decision = { pro: false, reason: 'not-configured' };
        else {
          const result = await polarValidate(fetchImpl, cfg(), state.key!, state.activationId, { retryBusy: force });
          const r = decideAfterValidation(state, now, result);
          decision = r.decision;
          await saveState(context, r.next);
          log(`Licence validation: ${result.ok ? result.status : result.kind} → ${decision.pro ? 'pro (' + decision.source + ')' : decision.reason}`);
        }
      }
      remember(decision);
      return decision;
    } catch (e) {
      log(`Licence check failed: ${String(e)}`);
      const decision: ProDecision = { pro: false, reason: 'network' };
      remember(decision);
      return decision;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

export async function isPro(context: vscode.ExtensionContext): Promise<boolean> {
  return (await proStatus(context)).pro;
}

/**
 * Gate for commands that ADD Pro behaviour. Returns true when allowed; otherwise shows a short,
 * honest upsell and returns false. Removing anything ChangeKeeper Pro added is always free (see features.ts).
 */
export async function ensurePro(context: vscode.ExtensionContext, feature: string): Promise<boolean> {
  const d = await proStatus(context);
  if (d.pro) return true;
  const buy = l10n.t('Get Pro ({0}, one-time)', PRO_PRICE_LABEL);
  const enter = l10n.t('Enter licence key');
  const what = l10n.t("What's in Pro");
  let msg: string;
  switch (d.reason) {
    case 'expired':
      msg = l10n.t('Your ChangeKeeper Pro licence has expired.');
      break;
    case 'revoked':
    case 'invalid':
      msg = l10n.t('Your ChangeKeeper Pro licence key is not valid any more.');
      break;
    case 'activation-removed':
      msg = l10n.t("This computer's activation of your ChangeKeeper Pro key was removed (from the Polar customer portal or by activating elsewhere). Enter the key again to re-activate.");
      break;
    case 'grace-expired':
      msg = l10n.t('ChangeKeeper Pro could not be re-validated for more than 14 days (no network). Connect once and try again.');
      break;
    case 'network':
      msg = l10n.t('ChangeKeeper Pro licence could not be validated (no network). Try again when you are online.');
      break;
    default:
      msg = l10n.t('"{0}" is part of ChangeKeeper Pro. The free version keeps sessions, hunk review, restore and reports forever; Pro adds validations after review, secret scanning, the commit message straight into the SCM box and agent attribution through hooks.', feature);
  }
  const pick = await vscode.window.showInformationMessage(msg, buy, enter, what);
  if (pick === buy) await openCheckout();
  else if (pick === enter) await activateLicenseCommand(context);
  else if (pick === what) await vscode.env.openExternal(vscode.Uri.parse(PRO_INFO_URL));
  return false;
}

export async function openCheckout(): Promise<void> {
  if (!POLAR_CHECKOUT_URL) {
    void vscode.window.showInformationMessage(l10n.t('ChangeKeeper Pro is not on sale yet. Watch the repository for the announcement.'));
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(POLAR_CHECKOUT_URL));
}

export async function activateLicenseCommand(context: vscode.ExtensionContext): Promise<void> {
  if (!polarConfigured()) {
    void vscode.window.showInformationMessage(l10n.t('Licence activation is not configured in this build.'));
    return;
  }
  const key = await vscode.window.showInputBox({
    title: l10n.t('ChangeKeeper Pro — enter your licence key'),
    prompt: l10n.t("The key from your Polar purchase e-mail. It is stored in VS Code's secret storage. Sent to Polar: the key, this computer's name, your OS and the extension version — nothing from your settings."),
    ignoreFocusOut: true,
    password: true,
    validateInput: (v) => (looksLikeLicenseKey(v) ? undefined : l10n.t('That does not look like a licence key')),
  });
  if (!key) return;
  const trimmed = key.trim();
  const label = os.hostname();
  const meta = { platform: process.platform, extension: String((context.extension.packageJSON as any)?.version ?? '?') };
  const previous = await loadState(context);
  let oldSlotFreed = false;
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('Activating ChangeKeeper Pro…'), cancellable: true }, async (_p, token) => {
    // A 429 from Polar means waiting up to 60 s (Retry-After); the user can cancel that wait.
    const opts = {
      isCancelled: () => token.isCancellationRequested,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          token.onCancellationRequested(() => {
            clearTimeout(t);
            resolve();
          });
        }),
    };
    // Activate first, then free the slot of a previous activation on this computer (best effort). Doing it in this
    // order means a failed activation never leaves the user without their old, working activation.
    let res = await polarActivate(fetchImpl, cfg(), trimmed, label, meta, opts);
    const hadSlot = !!(previous.key && previous.activationId);
    if (!res.ok && res.kind === 'limit' && /limit/i.test(res.message) && hadSlot && previous.key === trimmed) {
      // Same key at its activation limit: our own old slot on this computer may be the one in the way — free it, try once more.
      if (await polarDeactivate(fetchImpl, cfg(), previous.key!, previous.activationId!, opts)) {
        oldSlotFreed = true;
        res = await polarActivate(fetchImpl, cfg(), trimmed, label, meta, opts);
      }
    } else if (res.ok && hadSlot && previous.activationId !== res.activationId) {
      const freed = await polarDeactivate(fetchImpl, cfg(), previous.key!, previous.activationId!, opts);
      if (!freed) log(`Previous activation ${previous.activationId} could not be freed on Polar (rate limit or network); it may still count until deactivated from the customer portal.`);
    }
    return res;
  });
  if (!r.ok && oldSlotFreed) {
    // We released this computer's old activation and could not create the new one: record that honestly (Pro off
    // until the key is entered again) instead of keeping a dead activation id around.
    await saveState(context, { ...previous, status: 'activation-removed', lastCheckedAt: new Date().toISOString() });
    invalidateProCache();
    log(`Old activation ${previous.activationId} freed but re-activation failed (${r.kind}); state marked activation-removed`);
  }
  if (!r.ok) {
    const why =
      r.kind === 'invalid'
        ? l10n.t('The key was not recognised.')
        : r.kind === 'limit'
          ? l10n.t('This key has reached its activation limit or is not active: {0}. Deactivate it on another computer or contact support.', r.message)
          : r.kind === 'busy'
            ? l10n.t('The licence server is busy right now (rate limit). Wait a minute and try again.')
            : r.kind === 'unexpected'
              ? l10n.t('The licence server answered something unexpected. Please try again later or contact support.')
              : l10n.t('Network problem: {0}', r.message);
    const note = oldSlotFreed ? ' ' + l10n.t("This computer's previous activation was released in the process; enter the key again in a minute.") : '';
    void vscode.window.showErrorMessage(l10n.t('Could not activate ChangeKeeper Pro. {0}', why) + note);
    return;
  }
  const nowIso = new Date().toISOString();
  const state: LicenseState = { version: 1, key: trimmed, activationId: r.activationId, status: r.status, expiresAt: r.expiresAt ?? null, lastValidatedAt: r.status === 'granted' ? nowIso : undefined, lastCheckedAt: nowIso, label };
  await saveState(context, state);
  invalidateProCache();
  log(`Licence activated for ${label} (activation ${r.activationId}, status ${r.status})`);
  if (r.status !== 'granted') void vscode.window.showWarningMessage(l10n.t('The key was activated but its status is "{0}". Pro features stay off until Polar reports it as granted.', r.status));
  else void vscode.window.showInformationMessage(l10n.t('ChangeKeeper Pro activated on this computer. Thank you!'));
}

export async function deactivateLicenseCommand(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  if (!state.key) {
    void vscode.window.showInformationMessage(l10n.t('No ChangeKeeper Pro licence is stored on this computer.'));
    return;
  }
  const yes = l10n.t('Deactivate');
  const pick = await vscode.window.showWarningMessage(l10n.t('Deactivate ChangeKeeper Pro on this computer? The activation slot is freed so you can use the key elsewhere.'), { modal: true }, yes);
  if (pick !== yes) return;
  if (state.activationId && polarConfigured()) {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('Deactivating ChangeKeeper Pro…') }, () => polarDeactivate(fetchImpl, cfg(), state.key!, state.activationId!));
    if (!ok) void vscode.window.showWarningMessage(l10n.t('Polar could not be reached; the key was removed from this computer but the activation slot may still count until you deactivate it from your Polar customer portal.'));
  }
  await saveState(context, {});
  invalidateProCache();
  void vscode.window.showInformationMessage(l10n.t('ChangeKeeper Pro deactivated on this computer.'));
}

function reasonText(d: ProDecision): string {
  if (d.pro) {
    switch (d.source) {
      case 'dev':
        return l10n.t('developer override');
      case 'grace':
        return l10n.t('offline grace period');
      default:
        return l10n.t('validated');
    }
  }
  switch (d.reason) {
    case 'no-key':
      return l10n.t('no licence key on this computer');
    case 'not-configured':
      return l10n.t('licensing not configured in this build');
    case 'invalid':
      return l10n.t('key not recognised');
    case 'expired':
      return l10n.t('expired');
    case 'grace-expired':
      return l10n.t('offline for more than 14 days');
    case 'revoked':
      return l10n.t('revoked');
    case 'activation-removed':
      return l10n.t("this computer's activation was removed — enter the key again");
    default:
      return l10n.t('could not reach the licence server');
  }
}

export async function licenseStatusCommand(context: vscode.ExtensionContext): Promise<void> {
  const d = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: l10n.t('Checking ChangeKeeper Pro licence…') }, () => proStatus(context, true));
  const state = await loadState(context);
  const lines = [
    d.pro ? l10n.t('ChangeKeeper Pro: active ({0})', reasonText(d)) : l10n.t('ChangeKeeper Pro: not active ({0})', reasonText(d)),
    state.label ? l10n.t('Activated as: {0}', state.label) : '',
    state.lastValidatedAt ? l10n.t('Last validated: {0}', new Date(state.lastValidatedAt).toLocaleString()) : '',
    state.expiresAt ? l10n.t('Expires: {0}', new Date(state.expiresAt).toLocaleString()) : '',
  ].filter(Boolean);
  void vscode.window.showInformationMessage(lines.join(' · '));
}
