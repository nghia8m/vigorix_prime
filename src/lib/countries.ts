/**
 * Country list and address-label rules for checkout.
 *
 * The list is not hand-typed: every two-letter combination is offered to ICU's
 * Intl.DisplayNames at build time and the ones it recognises as regions are
 * kept. That yields the ISO 3166-1 alpha-2 set the runtime actually knows,
 * with official English names, and it cannot drift out of date by hand.
 */

/** Codes ICU knows that are not countries (aggregates, reserved, test codes). */
const NOT_COUNTRIES = new Set([
  "EU", "EZ", "UN", "QO", "ZZ", "XA", "XB",
  "AC", "CP", "DG", "EA", "IC", "TA", // exceptionally reserved / dependencies of FR-ES
  // Withdrawn from ISO 3166-1; ICU still resolves them, which would show
  // dissolved states and duplicates ("UK" alongside "GB") in the picker.
  "AN", "BU", "CS", "CT", "DD", "DY", "FQ", "FX", "HV", "JT", "MI", "NH", "NQ",
  "NT", "PC", "PU", "PZ", "RH", "SU", "TP", "UK", "VD", "WK", "YD", "YU", "ZR",
]);

export interface Country {
  code: string;
  name: string;
}

function buildCountries(): Country[] {
  const display = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const out: Country[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let name: string | undefined;
      try {
        name = display.of(code);
      } catch {
        continue;
      }
      // fallback:"none" returns undefined for codes ICU does not recognise, and
      // echoes the code back for a few it half-knows — both are rejected.
      if (!name || name === code) continue;
      out.push({ code, name });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, "en"));
}

export const COUNTRIES: Country[] = buildCountries();

/**
 * What the second address line is called locally. Anything not listed falls
 * back to the neutral "Region", and is optional — inventing a mandatory
 * "State" field for countries that have no such thing is a classic way to
 * lose an order.
 */
export const REGION_LABELS: Record<string, string> = {
  US: "State",
  CA: "Province",
  AU: "State / Territory",
  BR: "State",
  MX: "State",
  IN: "State",
  MY: "State",
  NG: "State",
  ZA: "Province",
  AR: "Province",
  CN: "Province",
  ID: "Province",
  PH: "Province",
  TH: "Province",
  VN: "Province",
  NL: "Province",
  BE: "Province",
  IT: "Province",
  ES: "Province",
  JP: "Prefecture",
  GB: "County",
  IE: "County",
  NZ: "Region",
  CH: "Canton",
  DE: "State",
  AT: "State",
  FR: "Region",
  PT: "District",
  PL: "Voivodeship",
  SE: "County",
  NO: "County",
  FI: "Region",
  DK: "Region",
};

/** Countries where a subdivision is genuinely part of a postal address. */
export const REGION_REQUIRED = new Set([
  "US", "CA", "AU", "BR", "MX", "IN", "MY", "NG", "ZA", "AR", "CN", "ID", "PH", "JP", "IT",
]);

/**
 * Countries with no postal code system at all. Demanding one from these
 * addresses blocks perfectly valid orders.
 * Source: UPU — countries that do not operate a postcode scheme.
 */
export const NO_POSTAL_CODE = new Set([
  "AE", "AG", "AN", "AO", "AW", "BF", "BI", "BJ", "BO", "BS", "BW", "BZ", "CD", "CF", "CG",
  "CI", "CK", "CM", "DJ", "DM", "ER", "FJ", "GD", "GH", "GM", "GQ", "GY", "HK", "IE", "JM",
  "KE", "KI", "KM", "KN", "KP", "LC", "ML", "MO", "MR", "MW", "NA", "NR", "NU", "PA", "QA",
  "RW", "SB", "SC", "SL", "SR", "ST", "SY", "TF", "TK", "TL", "TO", "TT", "TV", "TZ", "UG",
  "VU", "YE", "ZW",
]);

/** Everything the browser needs to label an address form, in one payload. */
export const ADDRESS_RULES = {
  regionLabels: REGION_LABELS,
  regionRequired: Array.from(REGION_REQUIRED),
  noPostalCode: Array.from(NO_POSTAL_CODE),
  defaultRegionLabel: "Region",
};
