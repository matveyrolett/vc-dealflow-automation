/**
 * =====================================================================
 * COMPANY NAME NORMALIZER
 * =====================================================================
 * One implementation of the name-matching rule every workflow relies on.
 * The same company shows up as "Acme", "acme inc.", "07_Acme" (a data-room
 * folder) or "ACME GmbH", and all of these must match one CRM card.
 *
 * Rule: ignore case, accents, a leading "<number>_" folder prefix,
 * punctuation, extra spaces, and trailing corporate suffixes.
 *
 * Deliberately conservative: a suffix is only stripped when something is
 * left over, and a trailing number is never stripped, so "Bluebird VC
 * Fund 1" and "Bluebird Ventures" stay two different deals.
 * =====================================================================
 */

const COMPANY_NAME_SUFFIXES = ['ai', 'inc', 'ltd', 'llc', 'gmbh', 'fund'];

/**
 * "07_Acme Inc." -> "acme", "Café Labs GmbH" -> "cafe labs".
 * Returns "" for empty input.
 */
function normalizeCompanyName_(name) {
  let s = String(name === null || name === undefined ? '' : name);

  // Accents: "Café" -> "Cafe".
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Data-room folder prefix: "10_Globex" -> "Globex".
  s = s.replace(/^\s*\d+_/, '');

  // Lowercase, drop punctuation entirely ("Coin-Ex" == "CoinEx"),
  // collapse whitespace.
  s = s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing suffixes ("acme ai inc" -> "acme"), never to nothing.
  const parts = s ? s.split(' ') : [];
  while (parts.length > 1 && COMPANY_NAME_SUFFIXES.indexOf(parts[parts.length - 1]) !== -1) {
    parts.pop();
  }
  return parts.join(' ');
}

/** True when two names refer to the same company under the rule above. */
function namesMatch_(a, b) {
  const na = normalizeCompanyName_(a);
  return na !== '' && na === normalizeCompanyName_(b);
}

/**
 * Looks a name up in a list of canonical names (e.g. every CRM card title).
 * Returns:
 *   { status: 'match',     match: 'Acme Inc.' }      exactly one hit
 *   { status: 'ambiguous', candidates: [...] }       2+ hits: never guess
 *   { status: 'none' }                               no hit
 */
function findCanonicalName_(name, canonicalNames) {
  const target = normalizeCompanyName_(name);
  if (!target) return { status: 'none' };

  const hits = (canonicalNames || []).filter(function (candidate) {
    return normalizeCompanyName_(candidate) === target;
  });

  if (hits.length === 1) return { status: 'match', match: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', candidates: hits };
  return { status: 'none' };
}
