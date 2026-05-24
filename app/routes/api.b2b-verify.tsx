import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import soap from "soap";
import { unauthenticated } from "../shopify.server";

const VIES_WSDL =
  "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";

const AUTO_APPROVE_MATCH_THRESHOLD = 70;
const DEFAULT_SHOP = "buzz-hive-store.myshopify.com";

const MANAGED_B2B_TAGS = [
  "b2b_pending_review",
  "b2b_rejected",
  "b2b_customer",
  "b2b_auto_approved",
  "vat_verified",
];

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

function calculateMatchScore(a: string, b: string) {
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

async function checkVatVies(vatNumber: string) {
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
    return {
      ok: false,
      billingCountry,
      pec,
      codiceDestinatario,
      error: "Formato PEC non valido.",
    };
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
            companyContactProfiles {
              id
              company {
                id
                name
              }
            }
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
            companyContactProfiles {
              id
              company {
                id
                name
              }
            }
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
  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return data?.data?.customerCreate?.customer;
}

async function syncB2BTags(
  admin: any,
  customerId: string,
  existingTags: string[],
  newTags: string[],
) {
  const tagsToRemove = existingTags.filter((tag) =>
    MANAGED_B2B_TAGS.includes(tag),
  );

  if (tagsToRemove.length) {
    const removeData = await graphQL(
      admin,
      `#graphql
        mutation TagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        id: customerId,
        tags: tagsToRemove,
      },
    );

    const removeErrors = removeData?.data?.tagsRemove?.userErrors ?? [];
    if (removeErrors.length) {
      throw new Error(removeErrors.map((e: any) => e.message).join(" | "));
    }
  }

  const addData = await graphQL(
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
    {
      id: customerId,
      tags: newTags,
    },
  );

  const addErrors = addData?.data?.tagsAdd?.userErrors ?? [];
  if (addErrors.length) {
    throw new Error(addErrors.map((e: any) => e.message).join(" | "));
  }
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
        type:
          key === "vies_address"
            ? "multi_line_text_field"
            : "single_line_text_field",
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
    {
      metafields,
    },
  );

  const errors = data?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return data?.data?.metafieldsSet?.metafields ?? [];
}

async function createCompanyForApprovedCustomer({
  admin,
  customer,
  payload,
  vies,
  billingValidation,
}: {
  admin: any;
  customer: any;
  payload: any;
  vies: any;
  billingValidation: any;
}) {
  const existingCompany =
    customer?.companyContactProfiles?.[0]?.company ?? null;

  if (existingCompany?.id) {
    return {
      skipped: true,
      reason: "Customer already assigned to a company.",
      companyId: existingCompany.id,
      companyName: existingCompany.name,
    };
  }

  const companyName =
    String(vies.companyName || "").trim() ||
    String(payload.companyName || "").trim();

  if (!companyName) {
    return {
      skipped: true,
      reason: "Missing company name.",
    };
  }

  const companyCreateData = await graphQL(
    admin,
    `#graphql
      mutation CompanyCreate($input: CompanyCreateInput!) {
        companyCreate(input: $input) {
          company {
            id
            name
            contactRoles(first: 10) {
              nodes {
                id
                name
              }
            }
            locations(first: 10) {
              nodes {
                id
                name
              }
            }
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
        company: {
          name: companyName,
        },
        companyLocation: {
          name: companyName,
          billingAddress: {
            recipient: companyName,
            countryCode: billingValidation.billingCountry || vies.countryCode || "IT",
          },
        },
      },
    },
  );

  const companyErrors =
    companyCreateData?.data?.companyCreate?.userErrors ?? [];

  if (companyErrors.length) {
    throw new Error(companyErrors.map((e: any) => e.message).join(" | "));
  }

  const company = companyCreateData?.data?.companyCreate?.company;
  const location = company?.locations?.nodes?.[0];
  const role = company?.contactRoles?.nodes?.[0];

  if (!company?.id || !location?.id || !role?.id) {
    return {
      skipped: true,
      reason: "Company created but location or role missing.",
      companyId: company?.id,
      companyName: company?.name,
    };
  }

  const assignCustomerData = await graphQL(
    admin,
    `#graphql
      mutation AssignCustomer($companyId: ID!, $customerId: ID!) {
        companyAssignCustomerAsContact(
          companyId: $companyId
          customerId: $customerId
        ) {
          companyContact {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      companyId: company.id,
      customerId: customer.id,
    },
  );

  const assignErrors =
    assignCustomerData?.data?.companyAssignCustomerAsContact?.userErrors ?? [];

  if (assignErrors.length) {
    throw new Error(assignErrors.map((e: any) => e.message).join(" | "));
  }

  const companyContact =
    assignCustomerData?.data?.companyAssignCustomerAsContact?.companyContact;

  if (!companyContact?.id) {
    return {
      skipped: true,
      reason: "Company contact was not returned.",
      companyId: company.id,
      companyName: company.name,
      companyLocationId: location.id,
    };
  }

  const assignRoleData = await graphQL(
    admin,
    `#graphql
      mutation AssignRole(
        $companyContactId: ID!
        $companyLocationId: ID!
        $companyContactRoleId: ID!
      ) {
        companyContactAssignRole(
          companyContactId: $companyContactId
          companyLocationId: $companyLocationId
          companyContactRoleId: $companyContactRoleId
        ) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      companyContactId: companyContact.id,
      companyLocationId: location.id,
      companyContactRoleId: role.id,
    },
  );

  const roleErrors =
    assignRoleData?.data?.companyContactAssignRole?.userErrors ?? [];

  if (roleErrors.length) {
    throw new Error(roleErrors.map((e: any) => e.message).join(" | "));
  }

  return {
    created: true,
    companyId: company.id,
    companyName: company.name,
    companyLocationId: location.id,
    companyLocationName: location.name,
    companyContactId: companyContact.id,
    companyContactRoleId: role.id,
    companyContactRoleName: role.name,
  };
}

async function upsertCustomerAndWriteData({
  shop,
  payload,
  decision,
  tagsToApply,
  metafieldsToWrite,
  vies,
  billingValidation,
}: {
  shop: string;
  payload: any;
  decision: string;
  tagsToApply: string[];
  metafieldsToWrite: Record<string, string>;
  vies: any;
  billingValidation: any;
}) {
  const { admin } = await unauthenticated.admin(shop);

  let customer = await findCustomerByEmail(admin, payload.email);

  if (!customer) {
    customer = await createCustomer(admin, payload, tagsToApply);
  } else {
    await syncB2BTags(
      admin,
      customer.id,
      customer.tags || [],
      tagsToApply,
    );
  }

  const metafields = await setCustomerMetafields(
    admin,
    customer.id,
    metafieldsToWrite,
  );

  let company = null;

  if (decision === "approved") {
    customer = await findCustomerByEmail(admin, payload.email);

    company = await createCompanyForApprovedCustomer({
      admin,
      customer,
      payload,
      vies,
      billingValidation,
    });
  }

  return {
    customer,
    metafields,
    company,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  return json({
    ok: true,
    status: "route_alive",
    method: request.method,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  let payload: any = {};

  try {
    payload = await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Payload JSON non valido.",
      },
      { status: 400 },
    );
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
    return json(
      {
        ok: false,
        error: "Email obbligatoria.",
      },
      { status: 400 },
    );
  }

  try {
    const vies = await checkVatVies(vatNumber);

    const matchScore = calculateMatchScore(
      submittedCompanyName,
      vies.companyName,
    );

    let decision = "pending_review";
    let tagsToApply = ["b2b_pending_review"];

    if (!vies.valid) {
      decision = "rejected";
      tagsToApply = ["b2b_rejected"];
    } else if (matchScore >= AUTO_APPROVE_MATCH_THRESHOLD) {
      decision = "approved";
      tagsToApply = [
        "b2b_customer",
        "vat_verified",
        "b2b_auto_approved",
      ];
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
      decision,
      tagsToApply,
      metafieldsToWrite,
      vies,
      billingValidation,
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
        company: shopifyWrite.company,
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