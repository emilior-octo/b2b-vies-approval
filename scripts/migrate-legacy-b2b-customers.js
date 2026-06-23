#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ENDPOINT = "https://b2b-vies-approval-d6ib.onrender.com/api/b2b-verify";
const DEFAULT_SHOP = "zig-italia-frutta-secca-e-semi.myshopify.com";
const TAGS = ["b2b_customer", "vat_verified", "legacy_b2b_import"];

const EU_COUNTRIES = new Set([
  "AT","BE","BG","CY","CZ","DE","DK","EE","EL","ES","FI","FR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"
]);

const VAT_KEYS = ["identificativo_iva","identificativo iva","vat","vat number","vat_number","partita iva","partita_iva","piva","p.iva","tax id","tax_id"];
const COMPANY_KEYS = ["default address company","company","azienda","ragione sociale","ragione_sociale"];
const EMAIL_KEYS = ["email","customer email","e-mail"];
const CUSTOMER_ID_KEYS = ["customer id","id cliente","id"];
const FIRST_NAME_KEYS = ["first name","nome","customer first name"];
const LAST_NAME_KEYS = ["last name","cognome","customer last name"];
const COUNTRY_KEYS = ["default address country code","country code","billing country","paese"];
const PEC_KEYS = ["pec","certified email","certified_email"];
const SDI_KEYS = ["sdi","codice destinatario","codice_destinatario","recipient code"];
const ADDRESS1_KEYS = ["default address address1","address1","indirizzo"];
const CITY_KEYS = ["default address city","city","citta","città"];
const ZIP_KEYS = ["default address zip","zip","cap","postal code"];
const PROVINCE_KEYS = ["default address province code","province code","provincia"];

function clean(value) {
  return String(value ?? "").trim();
}

function parseArgs(argv) {
  const args = {
    csv: "",
    endpoint: DEFAULT_ENDPOINT,
    shop: DEFAULT_SHOP,
    live: false,
    limit: 0,
    start: 0,
    delay: 350,
    verbose: false,
    reportDir: "migration-reports",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") args.live = true;
    else if (arg === "--dry-run") args.live = false;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--csv") args.csv = argv[++i] || "";
    else if (arg === "--endpoint") args.endpoint = argv[++i] || DEFAULT_ENDPOINT;
    else if (arg === "--shop") args.shop = argv[++i] || DEFAULT_SHOP;
    else if (arg === "--limit") args.limit = Number(argv[++i] || 0);
    else if (arg === "--start") args.start = Number(argv[++i] || 0);
    else if (arg === "--delay") args.delay = Number(argv[++i] || 350);
    else if (arg === "--report-dir") args.reportDir = argv[++i] || "migration-reports";
  }

  if (!args.csv) throw new Error('Missing --csv "path/to/file.csv"');
  return args;
}

function normalizeHeader(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((v) => clean(v))) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((v) => clean(v))) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map(clean);
  return rows.slice(1).map((values, index) => {
    const item = { __rowNumber: index + 2, __raw: values };
    headers.forEach((header, i) => {
      item[header] = clean(values[i]);
    });
    return item;
  });
}

function getByHeader(row, keys) {
  const entries = Object.entries(row).filter(([k]) => !k.startsWith("__"));

  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    for (const [header, value] of entries) {
      const normalizedHeader = normalizeHeader(header);
      if (normalizedHeader === normalizedKey || normalizedHeader.includes(normalizedKey) || normalizedKey.includes(normalizedHeader)) {
        const v = clean(value);
        if (v) return v;
      }
    }
  }

  return "";
}

function getColumn(row, index) {
  return clean(row.__raw?.[index]);
}

function normalizeCountry(value, fallback = "IT") {
  const raw = clean(value).toUpperCase();
  if (!raw) return fallback;
  if (raw === "GR" || raw === "GREECE") return "EL";
  if (raw === "ITALIA" || raw === "ITALY") return "IT";
  if (raw.length === 2) return raw;
  return fallback;
}

function inferCountryFromVat(vat) {
  const normalized = clean(vat).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z]{2}/.test(normalized)) {
    const country = normalized.slice(0, 2);
    if (EU_COUNTRIES.has(country)) return country === "GR" ? "EL" : country;
  }
  return "";
}

function normalizeVat(rawVat, countryHint = "IT") {
  let vat = clean(rawVat).toUpperCase().replace(/\s+/g, "").replace(/[.\-_/]/g, "").replace(/^EU/, "");
  let country = inferCountryFromVat(vat) || normalizeCountry(countryHint, "IT");

  if (country === "GR") country = "EL";

  if (vat.startsWith(country)) vat = vat.slice(2);
  if (country === "AT") {
    if (vat.startsWith("AT")) vat = vat.slice(2);
    if (/^\d{8}$/.test(vat)) vat = `U${vat}`;
  }

  return {
    country,
    vatNumber: vat,
    fullVat: `${country}${vat}`,
    reverseChargeEligible: EU_COUNTRIES.has(country) && country !== "IT",
  };
}

function pickRowData(row) {
  const rawVat = getByHeader(row, VAT_KEYS) || getColumn(row, 11);
  const inferredCountry = inferCountryFromVat(rawVat);
  const country = normalizeCountry(getByHeader(row, COUNTRY_KEYS) || inferredCountry || "IT", inferredCountry || "IT");
  const vat = normalizeVat(rawVat, country);

  const customerIdRaw = getByHeader(row, CUSTOMER_ID_KEYS);
  const customerId = customerIdRaw
    ? customerIdRaw.startsWith("gid://")
      ? customerIdRaw
      : /^\d+$/.test(customerIdRaw)
        ? `gid://shopify/Customer/${customerIdRaw}`
        : customerIdRaw
    : "";

  const firstName = getByHeader(row, FIRST_NAME_KEYS);
  const lastName = getByHeader(row, LAST_NAME_KEYS);
  const companyName = getByHeader(row, COMPANY_KEYS) || [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    rowNumber: row.__rowNumber,
    customerId,
    email: getByHeader(row, EMAIL_KEYS).toLowerCase(),
    firstName,
    lastName,
    companyName,
    vatInput: rawVat,
    vatNumber: vat.fullVat,
    billingCountry: vat.country,
    reverseChargeEligible: vat.reverseChargeEligible,
    pec: getByHeader(row, PEC_KEYS),
    codiceDestinatario: getByHeader(row, SDI_KEYS),
    address1: getByHeader(row, ADDRESS1_KEYS),
    city: getByHeader(row, CITY_KEYS),
    zip: getByHeader(row, ZIP_KEYS),
    provinceCode: getByHeader(row, PROVINCE_KEYS),
  };
}

function validateRecord(record) {
  const issues = [];
  if (!record.email && !record.customerId) issues.push("missing_customer_identifier");
  if (!record.vatInput) issues.push("missing_vat");
  if (!record.companyName) issues.push("missing_company_name_app_will_fallback");
  return issues;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeReport(reportPath, rows) {
  const headers = [
    "row","mode","status","decision","email","customerId","companyName","vatInput","vatNormalized",
    "billingCountry","reverseChargeEligible","issues","shopifyCustomerId","shopifyCompanyId",
    "shopifyCompanyLocationId","error"
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];

  fs.writeFileSync(reportPath, lines.join("\n"), "utf8");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToBusinessEngine(args, record) {
  const payload = {
    shop: args.shop,
    customerId: record.customerId || undefined,
    email: record.email,
    firstName: record.firstName || undefined,
    lastName: record.lastName || undefined,
    companyName: record.companyName || undefined,
    vatNumber: record.vatNumber,
    billingCountry: record.billingCountry,
    pec: record.pec || undefined,
    codiceDestinatario: record.codiceDestinatario || undefined,
    source: "legacy_b2b_import",
    tags: TAGS,
    address: {
      address1: record.address1 || undefined,
      city: record.city || undefined,
      zip: record.zip || undefined,
      provinceCode: record.provinceCode || undefined,
      countryCode: record.billingCountry,
    },
  };

  const response = await fetch(args.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Legacy-B2B-Import": "true",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || data.message || text || `HTTP ${response.status}`);
    error.response = data;
    throw error;
  }

  return data;
}

async function run() {
  const args = parseArgs(process.argv);
  const csvPath = path.resolve(args.csv);

  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const reportDir = path.resolve(args.reportDir);
  fs.mkdirSync(reportDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `legacy-b2b-import-report-${stamp}.csv`);

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  let records = rows.map(pickRowData);

  if (args.start > 0) records = records.slice(args.start);
  if (args.limit > 0) records = records.slice(0, args.limit);

  console.log("");
  console.log("Zig Legacy B2B Import Tool");
  console.log("--------------------------");
  console.log(`Mode:     ${args.live ? "LIVE" : "DRY RUN"}`);
  console.log(`CSV:      ${args.csv}`);
  console.log(`Endpoint: ${args.endpoint}`);
  console.log(`Rows:     ${records.length}`);
  console.log("");

  const report = [];
  let success = 0;
  let failed = 0;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const issues = validateRecord(record);
    const fatal = issues.includes("missing_customer_identifier") || issues.includes("missing_vat");
    const label = `${record.companyName || "-"} | ${record.email || record.customerId || "-"} | ${record.vatNumber || "-"}`;

    if (!args.live) {
      const status = fatal ? "would_fail" : "would_submit";
      console.log(`[${index + 1}/${records.length}] ${status.toUpperCase()} ${label}`);

      report.push({
        row: record.rowNumber,
        mode: "dry-run",
        status,
        decision: "",
        email: record.email,
        customerId: record.customerId,
        companyName: record.companyName,
        vatInput: record.vatInput,
        vatNormalized: record.vatNumber,
        billingCountry: record.billingCountry,
        reverseChargeEligible: record.reverseChargeEligible,
        issues: issues.join("|"),
        shopifyCustomerId: "",
        shopifyCompanyId: "",
        shopifyCompanyLocationId: "",
        error: "",
      });

      if (fatal) failed++;
      else success++;
      continue;
    }

    if (fatal) {
      failed++;
      console.log(`[${index + 1}/${records.length}] FAIL ${label} :: ${issues.join(", ")}`);
      report.push({
        row: record.rowNumber,
        mode: "live",
        status: "failed_validation",
        decision: "",
        email: record.email,
        customerId: record.customerId,
        companyName: record.companyName,
        vatInput: record.vatInput,
        vatNormalized: record.vatNumber,
        billingCountry: record.billingCountry,
        reverseChargeEligible: record.reverseChargeEligible,
        issues: issues.join("|"),
        shopifyCustomerId: "",
        shopifyCompanyId: "",
        shopifyCompanyLocationId: "",
        error: issues.join("|"),
      });
      continue;
    }

    try {
      console.log(`[${index + 1}/${records.length}] LIVE ${label}`);
      const data = await postToBusinessEngine(args, record);
      success++;

      report.push({
        row: record.rowNumber,
        mode: "live",
        status: "ok",
        decision: data.decision || data.status || "",
        email: record.email,
        customerId: record.customerId,
        companyName: record.companyName,
        vatInput: record.vatInput,
        vatNormalized: record.vatNumber,
        billingCountry: record.billingCountry,
        reverseChargeEligible: record.reverseChargeEligible,
        issues: issues.join("|"),
        shopifyCustomerId: data.shopify?.customerId || data.customerId || "",
        shopifyCompanyId: data.shopify?.companyId || data.companyId || "",
        shopifyCompanyLocationId: data.shopify?.companyLocationId || data.companyLocationId || "",
        error: "",
      });
    } catch (error) {
      failed++;
      console.log(`[${index + 1}/${records.length}] ERROR ${label} :: ${error.message}`);

      if (args.verbose && error.response) console.log(JSON.stringify(error.response, null, 2));

      report.push({
        row: record.rowNumber,
        mode: "live",
        status: "error",
        decision: "",
        email: record.email,
        customerId: record.customerId,
        companyName: record.companyName,
        vatInput: record.vatInput,
        vatNormalized: record.vatNumber,
        billingCountry: record.billingCountry,
        reverseChargeEligible: record.reverseChargeEligible,
        issues: issues.join("|"),
        shopifyCustomerId: "",
        shopifyCompanyId: "",
        shopifyCompanyLocationId: "",
        error: error.message,
      });
    }

    if (args.delay > 0) await sleep(args.delay);
  }

  writeReport(reportPath, report);

  console.log("");
  console.log("Done.");
  console.log(`Success: ${success}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Report:  ${reportPath}`);
  console.log("");
}

run().catch((error) => {
  console.error("");
  console.error("Fatal error:");
  console.error(error.message || error);
  process.exit(1);
});
