/**
 * Polar (merchant of record) configuration for ChangeKeeper Pro.
 * Fill POLAR_ORGANIZATION_ID and POLAR_CHECKOUT_URL once the Polar product exists (docs/TUS-TAREAS.md,
 * block B). While empty, licence activation reports "not configured" and every Pro command shows the
 * upsell without a working purchase link; release.yml refuses to publish a build with them empty.
 */
export const POLAR_ORGANIZATION_ID = '';
export const POLAR_CHECKOUT_URL = '';
export const PRO_PRICE_LABEL = '7 €';
export const PRO_INFO_URL = 'https://github.com/TecniartGalicia/changekeeper#pro';

/** Environment override for local development and CI: any Pro feature unlocked, no network. */
export const DEV_UNLOCK_ENV = 'CK_PRO_DEV';

export function polarConfigured(): boolean {
  return POLAR_ORGANIZATION_ID.trim().length > 0 && POLAR_CHECKOUT_URL.trim().length > 0;
}
