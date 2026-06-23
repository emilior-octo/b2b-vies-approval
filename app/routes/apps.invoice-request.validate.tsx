import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  normalizeCountry,
  normalizeVat,
  shouldApplyReverseCharge,
  verifyCompanyVat,
} from "../lib/vies.server";

const DEFAULT_SHOP = "zig-italia-frutta-secca-e-semi.myshopify.com";
const SHOP_COUNTRY = "IT";
const VIES_NAME_UNAVAILABLE_COUNTRIES = ["DE"];

function stripVatCountryPrefix(vatNumber: string, countryCode: string) {
  let raw = normalizeVat(vatNumber || "");
  const country = normalizeCountry(countryCode || "");

  if (country && raw.startsWith(country)) {
    raw = raw.slice(country.length);
  }

  return raw;
}

function normalizeVatForCountry(vatNumber: string, countryCode: string) {
  const country = normalizeCountry(countryCode || "");
  let raw = normalizeVat(vatNumber || "");

  if (!raw) return raw;

  if (country && raw.startsWith(country)) {
    raw = raw.slice(country.length);
  }

  if (country === "AT") {
    raw = raw.replace(/^U?/, "U");
  }

  return country ? `${country}${raw}` : raw;
}

function normalizeVatForVies(vatNumber: string, countryCode: string) {
  let raw = stripVatCountryPrefix(vatNumber, countryCode);

  if (
    normalizeCountry(countryCode || "") === "AT" &&
    raw &&
    !raw.startsWith("U")
  ) {
    raw = `U${raw}`;
  }

  return raw;
}

function safeDisplayCompanyName(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const cleaned = cleanViesText(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function isPlaceholderCustomerName(
  firstName?: string | null,
  lastName?: string | null,
) {
  const first = String(firstName || "")
    .trim()
    .toLowerCase();
  const last = String(lastName || "")
    .trim()
    .toLowerCase();

  if (!first && !last) return true;
  if (first === "invoice" && last === "customer") return true;
  if (first === "b2b" && last === "customer") return true;
  if (first === "fatturazione") return true;

  return false;
}

function buildCustomerIdentity({
  email,
  companyName,
  viesCompanyName,
}: {
  email: string;
  companyName?: string;
  viesCompanyName?: string;
}) {
  const effectiveCompanyName =
    safeDisplayCompanyName(companyName, viesCompanyName) ||
    String(email || "").split("@")[0] ||
    "Cliente";

  return {
    firstName: "Fatturazione",
    lastName: effectiveCompanyName.slice(0, 255),
  };
}

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

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function findCustomerByEmail(admin: any, email: string) {
  if (!email) return null;

  const data = await graphQL(
    admin,
    `#graphql
      query FindCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            email
            firstName
            lastName
            taxExempt
            companyContactProfiles(first: 5) {
              nodes {
                company { id name }
              }
            }
          }
        }
      }
    `,
    { query: `email:${email}` },
  );

  return data?.data?.customers?.nodes?.[0] || null;
}

async function setOwnerMetafields(
  admin: any,
  ownerId: string,
  metafieldsToWrite: Record<string, string>,
) {
  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId,
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
          metafields { id namespace key value }
          userErrors { field message }
        }
      }
    `,
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length)
    throw new Error(errors.map((e: any) => e.message).join(" | "));

  return data?.data?.metafieldsSet?.metafields || [];
}

async function createOrPrepareInvoiceCustomer({
  shop,
  email,
  companyName,
  viesCompanyName,
  taxExempt,
}: {
  shop: string;
  email: string;
  companyName?: string;
  viesCompanyName?: string;
  taxExempt: boolean;
}) {
  if (!email) return null;

  const { admin } = await unauthenticated.admin(shop);
  const identity = buildCustomerIdentity({
    email,
    companyName,
    viesCompanyName,
  });

  let customer = await findCustomerByEmail(admin, email);

  if (!customer) {
    const createData = await graphQL(
      admin,
      `#graphql
        mutation CustomerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer {
              id
              email
              firstName
              lastName
              taxExempt
              companyContactProfiles(first: 5) {
                nodes { company { id name } }
              }
            }
            userErrors { field message }
          }
        }
      `,
      {
        input: {
          email,
          firstName: identity.firstName,
          lastName: identity.lastName,
          note: `Invoice request company invoice - ${safeDisplayCompanyName(companyName, viesCompanyName) || email}`,
          tags: taxExempt
            ? ["invoice_request", "reverse_charge_customer"]
            : ["invoice_request", "company_invoice_customer"],
        },
      },
    );

    const errors = createData?.data?.customerCreate?.userErrors || [];
    if (errors.length)
      throw new Error(errors.map((e: any) => e.message).join(" | "));

    customer = createData?.data?.customerCreate?.customer;
  }

  if (!customer?.id) return null;

  const shouldUpdateIdentity = isPlaceholderCustomerName(
    customer.firstName,
    customer.lastName,
  );
  const input: any = {
    id: customer.id,
    taxExempt,
    tags: taxExempt
      ? ["invoice_request", "reverse_charge_customer"]
      : ["invoice_request", "company_invoice_customer"],
  };

  if (shouldUpdateIdentity) {
    input.firstName = identity.firstName;
    input.lastName = identity.lastName;
  }

  const updateData = await graphQL(
    admin,
    `#graphql
      mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            email
            firstName
            lastName
            taxExempt
            companyContactProfiles(first: 5) {
              nodes { company { id name } }
            }
          }
          userErrors { field message }
        }
      }
    `,
    { input },
  );

  const errors = updateData?.data?.customerUpdate?.userErrors || [];
  if (errors.length)
    throw new Error(errors.map((e: any) => e.message).join(" | "));

  return updateData?.data?.customerUpdate?.customer || customer;
}

function cleanViesText(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "";

  const normalized = text.replace(/[-–—_\s]+/g, "").toLowerCase();
  if (
    ["na", "n/a", "null", "none", "unknown", "unavailable"].includes(normalized)
  ) {
    return "";
  }

  return text;
}

async function createCompanyForInvoiceRequest({
  admin,
  customer,
  companyName,
  vatNumber,
  countryCode,
  viesCompanyName,
  viesAddress,
  fiscalMetafields,
}: {
  admin: any;
  customer: any;
  companyName: string;
  vatNumber: string;
  countryCode: string;
  viesCompanyName?: string;
  viesAddress?: string;
  fiscalMetafields: Record<string, string>;
}) {
  const effectiveCompanyName =
    safeDisplayCompanyName(companyName, viesCompanyName) ||
    String(customer?.email || "").trim() ||
    "Azienda B2B";

  if (!customer?.id) return null;

  const existingCompany =
    customer?.companyContactProfiles?.nodes?.[0]?.company || null;
  if (existingCompany?.id) {
    await setOwnerMetafields(admin, existingCompany.id, fiscalMetafields);
    await setOwnerMetafields(admin, customer.id, {
      ...fiscalMetafields,
      "b2b.company_id": existingCompany.id,
    });

    return {
      companyId: existingCompany.id,
      companyLocationId: null,
      companyName: existingCompany.name || effectiveCompanyName,
      alreadyAssigned: true,
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
            contactRoles(first: 10) { nodes { id name } }
            locations(first: 10) { nodes { id name } }
          }
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        company: { name: effectiveCompanyName },
        companyLocation: {
          name: effectiveCompanyName,
          taxRegistrationId: normalizeVatForCountry(vatNumber, countryCode),
          taxExempt: countryCode !== "IT",
          billingAddress: {
            recipient: effectiveCompanyName,
            address1:
              cleanViesText(viesAddress).split("\n")[0]?.trim() ||
              effectiveCompanyName,
            city: "N/A",
            countryCode: countryCode || "IT",
          },
        },
      },
    },
  );

  const companyErrors =
    companyCreateData?.data?.companyCreate?.userErrors || [];
  if (companyErrors.length)
    throw new Error(companyErrors.map((e: any) => e.message).join(" | "));

  const company = companyCreateData?.data?.companyCreate?.company;
  const location = company?.locations?.nodes?.[0];
  const role = company?.contactRoles?.nodes?.[0];

  if (!company?.id || !location?.id || !role?.id) {
    return {
      companyId: company?.id || null,
      companyLocationId: location?.id || null,
    };
  }

  const assignData = await graphQL(
    admin,
    `#graphql
      mutation AssignCustomer($companyId: ID!, $customerId: ID!) {
        companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
          companyContact { id }
          userErrors { field message }
        }
      }
    `,
    { companyId: company.id, customerId: customer.id },
  );

  const assignErrors =
    assignData?.data?.companyAssignCustomerAsContact?.userErrors || [];
  if (assignErrors.length)
    throw new Error(assignErrors.map((e: any) => e.message).join(" | "));

  const contact =
    assignData?.data?.companyAssignCustomerAsContact?.companyContact;

  if (contact?.id) {
    const roleData = await graphQL(
      admin,
      `#graphql
        mutation AssignRole($companyContactId: ID!, $companyLocationId: ID!, $companyContactRoleId: ID!) {
          companyContactAssignRole(
            companyContactId: $companyContactId
            companyLocationId: $companyLocationId
            companyContactRoleId: $companyContactRoleId
          ) { userErrors { field message } }
        }
      `,
      {
        companyContactId: contact.id,
        companyLocationId: location.id,
        companyContactRoleId: role.id,
      },
    );

    const roleErrors =
      roleData?.data?.companyContactAssignRole?.userErrors || [];
    if (roleErrors.length)
      throw new Error(roleErrors.map((e: any) => e.message).join(" | "));
  }

  await setOwnerMetafields(admin, company.id, {
    ...fiscalMetafields,
    "b2b.company_id": company.id,
    "b2b.company_location_id": location.id,
  });

  await setOwnerMetafields(admin, customer.id, {
    ...fiscalMetafields,
    "b2b.company_id": company.id,
    "b2b.company_location_id": location.id,
  });

  return {
    companyId: company.id,
    companyLocationId: location.id,
    companyName: company.name,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return json({
    ok: true,
    status: "invoice_proxy_alive",
    method: request.method,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const payload = await request.json();

    const shop = DEFAULT_SHOP;
    const locale = String(payload.locale || "it").toLowerCase();
    const invoiceType = String(payload.invoiceType || "private");
    const cartToken = String(payload.cartToken || "");
    const countryCode = normalizeCountry(payload.countryCode || "IT");
    const submittedVatNumber = normalizeVat(payload.vatNumber || "");
    let vatNumber = normalizeVatForCountry(submittedVatNumber, countryCode);
    const vatNumberForVies = normalizeVatForVies(
      submittedVatNumber,
      countryCode,
    );
    const companyName = cleanViesText(payload.companyName || "");
    const customerEmail = String(payload.customerEmail || payload.email || "")
      .trim()
      .toLowerCase();
    const pec = String(payload.pec || "").trim();
    const sdi = String(payload.sdi || "").trim();

    if (invoiceType === "private") {
      const invoiceRequest = await db.invoiceRequest.create({
        data: {
          shop,
          cartToken: cartToken || null,
          invoiceType: "private",
          status: "registered",
        },
      });

      return json({
        ok: true,
        invoiceRequestId: invoiceRequest.id,
        invoiceType: "private",
        viesChecked: false,
        viesValid: null,
        reverseCharge: false,
        taxExemptApplied: false,
        taxExemptCustomerPrepared: false,
      });
    }

    if (invoiceType !== "company") {
      return json(
        { ok: false, error: "Invalid invoice type." },
        { status: 400 },
      );
    }

    const isItaly = countryCode === "IT";

    if (!customerEmail) {
      return json(
        {
          ok: false,
          error:
            locale === "it"
              ? "Inserisci l’email che userai al checkout. Serve per associare il cliente all’azienda prima dell’ordine."
              : "Enter the email you will use at checkout. It is required to link the customer to the company before the order.",
        },
        { status: 400 },
      );
    }

    let viesChecked = false;
    let viesValid: boolean | null = null;
    let viesCompanyName = "";
    let viesAddress = "";
    let reverseCharge = false;
    let taxExemptCustomerPrepared = false;
    let preparedCustomer: any = null;
    let status = "registered";
    let pendingManualReview = false;

    try {
      const verification = await verifyCompanyVat({
        vatNumber: vatNumberForVies,
        companyName,
        countryCode,
      });

      viesChecked = true;
      viesValid = verification.vies.valid;
      viesCompanyName = verification.vies.companyName || "";
      viesAddress = verification.vies.address || "";
      vatNumber = normalizeVatForCountry(
        verification.vies.vatNumber || vatNumberForVies || vatNumber,
        verification.vies.countryCode || countryCode,
      );

      const acceptsMissingViesName =
        VIES_NAME_UNAVAILABLE_COUNTRIES.includes(
          verification.vies.countryCode,
        ) && !String(viesCompanyName || "").trim();

      reverseCharge = shouldApplyReverseCharge({
        shopCountry: SHOP_COUNTRY,
        billingCountry: countryCode,
        viesValid,
      });

      if (viesValid && customerEmail) {
        preparedCustomer = await createOrPrepareInvoiceCustomer({
          shop,
          email: customerEmail,
          companyName,
          viesCompanyName,
          taxExempt: Boolean(reverseCharge),
        });

        taxExemptCustomerPrepared = Boolean(
          reverseCharge && preparedCustomer?.taxExempt,
        );
      }

      if (!viesValid) {
        status = "pending_review";
        pendingManualReview = true;
      }
    } catch (error) {
      console.error("Invoice VIES check failed:", error);

      status = "pending_review";
      pendingManualReview = true;
      viesChecked = false;
      viesValid = null;
      reverseCharge = false;
      taxExemptCustomerPrepared = false;
    }

    const invoiceRequest = await db.invoiceRequest.create({
      data: {
        shop,
        cartToken: cartToken || null,
        invoiceType: "company",
        email: customerEmail || null,
        customerId: preparedCustomer?.id || null,
        companyName: companyName || null,
        vatNumber,
        billingCountry: countryCode,
        pec: isItaly ? pec || null : null,
        codiceDestinatario: isItaly ? sdi || null : null,
        viesChecked,
        viesValid,
        viesCompanyName: viesCompanyName || null,
        viesAddress: viesAddress || null,
        reverseCharge,
        taxExemptApplied: taxExemptCustomerPrepared,
        status,
      },
    });

    let invoiceCompany: any = null;

    if (invoiceType === "company" && preparedCustomer?.id && viesValid) {
      const { admin } = await unauthenticated.admin(shop);
      const viesStatus =
        viesValid &&
        !String(viesCompanyName || "").trim() &&
        VIES_NAME_UNAVAILABLE_COUNTRIES.includes(countryCode)
          ? "valid_name_unavailable"
          : viesValid
            ? "valid"
            : "invalid";

      const fiscalMetafields = {
        "b2b.vat_number": vatNumber,
        "b2b.billing_country": countryCode,
        "b2b.company_name_submitted": companyName,
        "b2b.vies_company_name": viesCompanyName || "",
        "b2b.vies_address": viesAddress || "",
        "b2b.vies_status": viesStatus,
        "b2b.reverse_charge": reverseCharge ? "true" : "false",
        "b2b.pec": isItaly ? pec : "",
        "b2b.codice_destinatario": isItaly ? sdi : "",
        "b2b.invoice_request_id": invoiceRequest.id,
      };

      invoiceCompany = await createCompanyForInvoiceRequest({
        admin,
        customer: preparedCustomer,
        companyName,
        vatNumber,
        countryCode,
        viesCompanyName,
        viesAddress,
        fiscalMetafields,
      });

      // Company IDs are stored on Shopify customer/company metafields.
      // The current InvoiceRequest Prisma model does not contain company ID columns,
      // so do not write unknown fields here.
    }

    return json({
      ok: true,
      invoiceRequestId: invoiceRequest.id,
      invoiceType: "company",
      customerEmail,
      vatNumber,
      countryCode,
      viesChecked,
      viesValid,
      viesCompanyName,
      viesAddress,
      reverseCharge,
      taxExemptApplied: taxExemptCustomerPrepared,
      taxExemptCustomerPrepared,
      mustUseSameEmailAtCheckout: Boolean(reverseCharge && customerEmail),
      pendingManualReview,
      company: invoiceCompany,
      message: pendingManualReview
        ? locale === "it"
          ? "Richiesta salvata per verifica manuale. Controlleremo il VAT prima della fatturazione."
          : "Invoice request saved for manual review. We will check the VAT before invoicing."
        : undefined,
    });
  } catch (error: any) {
    console.error("Invoice request validate error:", error);

    return json(
      {
        ok: false,
        error: error?.message || "Unexpected invoice request error",
        code: error?.code || null,
        meta: error?.meta || null,
      },
      { status: 500 },
    );
  }
}
