import soap from "soap";

const VIES_WSDL =
  "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";

export function normalizeVat(vatNumber: string) {
  return String(vatNumber || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.\-_/]/g, "")
    .toUpperCase();
}

export function normalizeCountry(country: string) {
  const value = String(country || "").trim().toUpperCase();
  if (["IT", "ITA", "ITALIA", "ITALY"].includes(value)) return "IT";
  return value;
}

export function normalizeCompanyName(name: string) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(s\.r\.l\.|srl|spa|s\.p\.a\.|snc|s\.n\.c\.|sas|s\.a\.s\.|sapa|s\.a\.p\.a\.|societa|soc|benefit|unipersonale|unip|italia|italy)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function similarityScore(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 100;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);

  return Math.round((1 - distance / maxLength) * 100);
}

export function calculateMatchScore(a: string, b: string) {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);

  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 95;

  const compactA = na.replace(/\s+/g, "");
  const compactB = nb.replace(/\s+/g, "");

  const compactScore = similarityScore(compactA, compactB);

  const aWords = new Set(na.split(" ").filter(Boolean));
  const bWords = new Set(nb.split(" ").filter(Boolean));
  const commonWords = [...aWords].filter((word) => bWords.has(word)).length;

  const wordScore = Math.round(
    (commonWords / Math.max(aWords.size, bWords.size)) * 100,
  );

  return Math.max(compactScore, wordScore);
}

export async function checkVatVies(vatNumber: string) {
  const normalized = normalizeVat(vatNumber);
  const countryCode = normalized.slice(0, 2);
  const number = normalized.slice(2);

  const client = await soap.createClientAsync(VIES_WSDL);
  const [result] = await client.checkVatAsync({
    countryCode,
    vatNumber: number,
  });

  return {
    valid: Boolean(result.valid),
    companyName: result.name || "",
    address: result.address || "",
    countryCode,
    vatNumber: normalized,
  };
}

export async function verifyCompanyVat({
  vatNumber,
  companyName,
}: {
  vatNumber: string;
  companyName?: string;
}) {
  const vies = await checkVatVies(vatNumber);

  const matchScore = companyName
    ? calculateMatchScore(companyName, vies.companyName)
    : null;

  return {
    vies,
    matchScore,
    normalized: {
      submittedCompanyName: normalizeCompanyName(companyName || ""),
      viesCompanyName: normalizeCompanyName(vies.companyName),
    },
  };
}

export function shouldApplyReverseCharge({
  shopCountry,
  billingCountry,
  viesValid,
}: {
  shopCountry?: string;
  billingCountry?: string;
  viesValid?: boolean | null;
}) {
  const shop = normalizeCountry(shopCountry || "IT");
  const billing = normalizeCountry(billingCountry || "");

  return Boolean(viesValid && billing && billing !== shop);
}