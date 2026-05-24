import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import soap from "soap";
import { unauthenticated } from "../shopify.server";

const VIES_WSDL =
  "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";

const AUTO_APPROVE_MATCH_THRESHOLD = 70;
const DEFAULT_SHOP = "buzz-hive-store.myshopify.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: any, init: ResponseInit = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

function normalizeVat(vatNumber: string) {
  return String(vatNumber || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.\-_/]/g, "")
    .toUpperCase();
}

function normalizeCountry(country: string) {
  const value = String(country || "").trim().toUpperCase();
  if (["IT", "ITA", "ITALIA", "ITALY"].includes(value)) return "IT";
  return value;
}

function normalizeCodiceDestinatario(value: string) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizePec(value: string) {
  return String(value || "").trim().toLowerCase();
}

function isValidCodiceDestinatario(value: string) {
  return /^[A-Z0-9]{7}$/.test(normalizeCodiceDestinatario(value));
}

function isValidPec(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizePec(value));
}

function normalizeCompanyName(name: string) {
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

function calculateMatchScore(a: string, b: string) {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);

  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 95;

  const aWords = new Set(na.split(" ").filter(Boolean));
  const bWords = new Set(nb.split(" ").filter(Boolean));
  const commonWords = [...aWords].filter((word) => bWords.has(word)).length;

  return Math.round((commonWords / Math.max(aWords.size, bWords.size)) * 100);
}

async function checkVatVies(vatNumber: string) {
  const normalized = normalizeVat(vatNumber);
  const countryCode = normalized.slice(0, 2);
  const number = normalized.slice(2);

  const client = await soap.createClientAsync(VIES_WSDL);
  const [result] = await client.checkVatAsync({ countryCode, vatNumber: number });

  return {
    valid: Boolean(result.valid),
    companyName: result.name || "",
    address: result.address || "",
    countryCode,
    vatNumber: normalized,
  };
}

function validateBillingData(payload: any) {
  const billingCountry = normalizeCountry(payload.billingCountry ?? "");
  const pec = normalizePec(payload.pec ?? "");
  const codiceDestinatario = normalizeCodiceDestinatario(
    payload.codiceDestinatario ?? payload.codiceUnivoco ?? "",
  );

  if (billingCountry !== "IT") {
    return { ok: true, billingCountry, pec, codiceDestinatario };
  }

  if (!pec && !codiceDestinatario) {
    return {
      ok: false,
      billingCountry,
      pec,
      codiceDestinatario,
      error:
        "Per le aziende italiane è obbligatorio inserire almeno PEC o Codice Destinatario.",
    };
  }

  if (pec && !isValidPec(pec)) {
    return { ok: false, billingCountry, pec, codiceDestinatario, error: "Formato PEC non valido." };
  }

  if (codiceDestinatario && !isValidCodiceDestinatario(codiceDestinatario)) {
    return {
      ok: false,
      billingCountry,
      pec,
      codiceDestinatario,
      error: "Il Codice Destinatario deve essere di 7 caratteri alfanumerici.",
    };
  }

  return { ok: true, billingCountry, pec, codiceDestinatario };
}

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function findCustomerByEmail(admin: any, email: string) {
  const data = await graphQL(
    admin,
    `#graphql
      query FindCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            email
            tags
          }
        }
      }
    `,
    { query: `email:${email}` },
  );

  return data?.data?.customers?.nodes?.[0] ?? null;
}

async function createCustomer(admin: any, payload: any, tagsToApply: string[]) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            email
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        email: String(payload.email || "").trim(),
        firstName: payload.firstName || "B2B",
        lastName: payload.lastName || "Customer",
        note: `B2B application - ${payload.companyName || ""}`,
        tags: tagsToApply,
      },
    },
  );

  const errors = data?.data?.customerCreate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));

  return data?.data?.customerCreate?.customer;
}

async function addTags(admin: any, customerId: string, tags: string[]) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    { id: customerId, tags },
  );

  const errors = data?.data?.tagsAdd?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));
}

async function setCustomerMetafields(
  admin: any,
  customerId: string,
  metafieldsToWrite: Record<string, string>,
) {
  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId: customerId,
        namespace,
        key,
        type: key === "vies_address" ? "multi_line_text_field" : "single_line_text_field",
        value: String(value ?? "").trim(),
      };
    });

  if (!metafields.length) return [];

  const data = await graphQL(
    admin,
    `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));

  return data?.data?.metafieldsSet?.metafields ?? [];
}

async function upsertCustomerAndWriteData({
  shop,
  payload,
  tagsToApply,
  metafieldsToWrite,
}: {
  shop: string;
  payload: any;
  tagsToApply: string[];
  metafieldsToWrite: Record<string, string>;
}) {
  const { admin } = await unauthenticated.admin(shop);

  let customer = await findCustomerByEmail(admin, payload.email);

  if (!customer) {
    customer = await createCustomer(admin, payload, tagsToApply);
  } else {
    await addTags(admin, customer.id, tagsToApply);
  }

  const metafields = await setCustomerMetafields(admin, customer.id, metafieldsToWrite);

  return { customer, metafields };
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return json({
    ok: true,
    status: "route_alive",
    method: request.method,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let payload: any = {};

  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Payload JSON non valido." }, { status: 400 });
  }

  const billingValidation = validateBillingData(payload);

  if (!billingValidation.ok) {
    return json(
      {
        ok: false,
        decision: "billing_data_required",
        error: billingValidation.error,
      },
      { status: 400 },
    );
  }

  const shop = String(payload.shop || DEFAULT_SHOP).trim();
  const submittedCompanyName = payload.companyName ?? "";
  const vatNumber = payload.vatNumber ?? "";
  const email = String(payload.email || "").trim();

  if (!email) {
    return json({ ok: false, error: "Email obbligatoria." }, { status: 400 });
  }

  try {
    const vies = await checkVatVies(vatNumber);
    const matchScore = calculateMatchScore(submittedCompanyName, vies.companyName);

    let decision = "pending_review";
    let tagsToApply = ["b2b_pending_review"];

    if (!vies.valid) {
      decision = "rejected";
      tagsToApply = ["b2b_rejected"];
    } else if (matchScore >= AUTO_APPROVE_MATCH_THRESHOLD) {
      decision = "approved";
      tagsToApply = ["b2b_customer", "vat_verified", "b2b_auto_approved"];
    }

    const metafieldsToWrite = {
      "b2b.pec": billingValidation.pec,
      "b2b.codice_destinatario": billingValidation.codiceDestinatario,
      "b2b.vat_number": normalizeVat(vatNumber),
      "b2b.vies_company_name": vies.companyName,
      "b2b.vies_address": vies.address,
      "b2b.vies_match_score": String(matchScore),
      "b2b.vies_status": vies.valid ? "valid" : "invalid",
      "b2b.verified_at": new Date().toISOString(),
      "b2b.company_name_submitted": submittedCompanyName,
      "b2b.billing_country": billingValidation.billingCountry,
    };

    const shopifyWrite = await upsertCustomerAndWriteData({
      shop,
      payload,
      tagsToApply,
      metafieldsToWrite,
    });

return json({
  ok: true,
  decision,
  matchScore,
  tagsToApply,
  submitted: {
    companyName: submittedCompanyName,
    vatNumber: normalizeVat(vatNumber),
    email,
  },
  vies,
  normalized: {
    submittedCompanyName: normalizeCompanyName(submittedCompanyName),
    viesCompanyName: normalizeCompanyName(vies.companyName),
  },
  shopify: {
        customerId: shopifyWrite.customer?.id,
        customerEmail: shopifyWrite.customer?.email,
        metafieldsWritten: shopifyWrite.metafields?.length ?? 0,
      },
    });
  } catch (error: any) {
    return json(
      {
        ok: false,
        decision: "pending_review",
        error: error?.message || "Errore imprevisto.",
      },
      { status: 500 },
    );
  }
}