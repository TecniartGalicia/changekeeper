/**
 * Polar (merchant of record) configuration for ChangeKeeper Pro.
 * Neither value is a secret: the organization id is public and the checkout link is meant to be
 * opened by customers. The licence key itself never lives here (it goes to VS Code's SecretStorage).
 * While empty, licence activation reports "not configured" and release.yml refuses to publish.
 * Product: "ChangeKeeper Pro", one-time 7 €, benefit "ChangeKeeper Pro licence key" (prefix CKP,
 * never expires, 3 activations, customer can deactivate). Created 2026-08-16.
 */
export const POLAR_ORGANIZATION_ID = 'fa5605f8-f935-44c5-9923-686f9479d390';
export const POLAR_CHECKOUT_URL = 'https://buy.polar.sh/polar_cl_9cECWJS1qy5xy5Fh3nwUfhWJwxYGW46m4Hh7v0Xo9dz';
export const PRO_PRICE_LABEL = '7 €';
export const PRO_INFO_URL = 'https://github.com/TecniartGalicia/changekeeper#pro';

/** Environment override for local development and CI: any Pro feature unlocked, no network. */
export const DEV_UNLOCK_ENV = 'CK_PRO_DEV';

export function polarConfigured(): boolean {
  return POLAR_ORGANIZATION_ID.trim().length > 0 && POLAR_CHECKOUT_URL.trim().length > 0;
}
