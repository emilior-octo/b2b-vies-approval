import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import soap from "soap";

const DEFAULT_SHOP = "zig-italia-frutta-secca-e-semi.myshopify.com";
const SHOP_COUNTRY = "IT";
const VIES_WSDL = "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";
const VIES_NAME_UNAVAILABLE_COUNTRIES = ["DE", "ES"];

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

function normalizeCountry(country: string) {
  const value = String(country || "").trim().toUpperCase();
  if (["IT", "ITA", "ITALIA", "ITALY"].includes(value)) return "IT";
  return value;
}

function normalizeVat(vatNumber: string) {
  return String(vatNumber || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.\-_/]/g, "")
    .toUpperCase();
}

function cleanViesValue(value: string) {
  const text = String(value || "").trim();
  if (!text || text === "---" || text === "--" || text === "-") return "";
  return text;
}

function normalizeVatForCountry(vatNumber: string, billingCountry?: string) {
  let raw = normalizeVat(vatNumber);
  const country = normalizeCountry(billingCountry || "");

  if (!raw) return raw;

  const hasCountryPrefix = /^[A-Z]{2}/.test(raw);

  if (!hasCountryPrefix && country) {
    raw = `${country}${raw}`;
  }

  if (country === "AT") {
    if (/^ATU/.test(raw)) return raw;
    if (/^AT/.test(raw)) return `ATU${raw.slice(2).replace(/^U/, "")}`;
    if (/^U/.test(raw)) return `AT${raw}`;
    return `ATU${raw}`;
  }

  return raw;
}

function shouldApplyReverseCharge({
  shopCountry,
  billingCountry,
  viesValid,
}: {
  shopCountry: string;
  billingCountry: string;
  viesValid: boolean | null;
}) {
  return viesValid === true && normalizeCountry(shopCountry) !== normalizeCountry(billingCountry);
}

async function checkVatVies(vatNumber: string) {
  const normalized = normalizeVat(vatNumber);
  const countryCode = normalized.slice(0, 2);
  const number = normalized.slice(2);

  if (!countryCode || !number || countryCode.length !== 2) {
    throw new Error("VAT number is missing country prefix or number.");
  }

  console.log("[Invoice Request] VIES SOAP request", {
    fullVatNumber: normalized,
    countryCode,
    vatNumber: number,
  });

  const client = await soap.createClientAsync(VIES_WSDL);
  const [result] = await client.checkVatAsync({
    countryCode,
    vatNumber: number,
  });

  const response = {
    valid: Boolean(result?.valid === true || String(result?.valid).toLowerCase() === "true"),
    companyName: cleanViesValue(result?.name || ""),
    address: cleanViesValue(result?.address || ""),
    countryCode,
    vatNumber: normalized,
    raw: result || null,
  };

  console.log("[Invoice Request] VIES SOAP response", response);

  return response;
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
          metafields { id namespace key value }
          userErrors { field message }
        }
      }
    `,
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));

  return data?.data?.metafieldsSet?.metafields || [];
}

async function createOrPrepareInvoiceCustomer({
  shop,
  email,
  companyName,
  taxExempt,
}: {
  shop: string;
  email: string;
  companyName?: string;
  taxExempt: boolean;
}) {
  if (!email) return null;

  const { admin } = await unauthenticated.admin(shop);

  let customer = await findCustomerByEmail(admin, email);

  if (!customer) {
    const createData = await graphQL(
      admin,
      `#graphql
        mutation CustomerCreate($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id email taxExempt }
            userErrors { field message }
          }
        }
      `,
      {
        input: {
          email,
          firstName: "Invoice",
          lastName: "Customer",
          note: `Invoice request company invoice - ${companyName || ""}`,
          tags: taxExempt
            ? ["invoice_request", "reverse_charge_customer"]
            : ["invoice_request", "company_invoice_customer"],
        },
      },
    );

    const errors = createData?.data?.customerCreate?.userErrors || [];
    if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));

    customer = createData?.data?.customerCreate?.customer;
  }

  if (!customer?.id) return null;

  const updateData = await graphQL(
    admin,
    `#graphql
      mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id email taxExempt }
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        id: customer.id,
        taxExempt,
        tags: taxExempt
          ? ["invoice_request", "reverse_charge_customer"]
          : ["invoice_request", "company_invoice_customer"],
      },
    },
  );

  const errors = updateData?.data?.customerUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));

  return updateData?.data?.customerUpdate?.customer || customer;
}


function cleanViesText(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text) return "";

  const normalized = text.replace(/[-–—_\s]+/g, "").toLowerCase();
  if (["na", "n/a", "null", "none", "unknown", "unavailable"].includes(normalized)) {
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
    String(companyName || "").trim() ||
    cleanViesText(viesCompanyName) ||
    String(customer?.email || "").trim() ||
    "Azienda B2B";

  if (!customer?.id) return null;

  const existingCompany = customer?.companyContactProfiles?.nodes?.[0]?.company || null;
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
          taxRegistrationId: vatNumber,
          taxExempt: false,
          billingAddress: {
            recipient: effectiveCompanyName,
            address1: cleanViesText(viesAddress).split("\n")[0]?.trim() || "Address unavailable from VIES",
            city: "N/A",
            countryCode: countryCode || "IT",
          },
        },
      },
    },
  );

  const companyErrors = companyCreateData?.data?.companyCreate?.userErrors || [];
  if (companyErrors.length) throw new Error(companyErrors.map((e: any) => e.message).join(" | "));

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

  const assignErrors = assignData?.data?.companyAssignCustomerAsContact?.userErrors || [];
  if (assignErrors.length) throw new Error(assignErrors.map((e: any) => e.message).join(" | "));

  const contact = assignData?.data?.companyAssignCustomerAsContact?.companyContact;

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

    const roleErrors = roleData?.data?.companyContactAssignRole?.userErrors || [];
    if (roleErrors.length) throw new Error(roleErrors.map((e: any) => e.message).join(" | "));
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
    let vatNumber = normalizeVatForCountry(payload.vatNumber || "", countryCode);
    const companyName = String(payload.companyName || "").trim();
    const customerEmail = String(payload.customerEmail || payload.email || "").trim().toLowerCase();
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
      return json({ ok: false, error: "Invalid invoice type." }, { status: 400 });
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
      const vies = await checkVatVies(vatNumber);

      viesChecked = true;
      viesValid = vies.valid === true;
      viesCompanyName = vies.companyName || "";
      viesAddress = vies.address || "";
      vatNumber = vies.vatNumber || vatNumber;

      reverseCharge = shouldApplyReverseCharge({
        shopCountry: SHOP_COUNTRY,
        billingCountry: countryCode,
        viesValid,
      });

      if (viesValid && customerEmail) {
        preparedCustomer = await createOrPrepareInvoiceCustomer({
          shop,
          email: customerEmail,
          companyName: companyName || viesCompanyName,
          taxExempt: Boolean(reverseCharge),
        });

        taxExemptCustomerPrepared = Boolean(reverseCharge && preparedCustomer?.taxExempt);
      }

      if (!viesValid) {
        status = "pending_review";
        pendingManualReview = true;
      }
    } catch (error) {
      console.error("Invoice VIES SOAP check failed:", {
        error,
        countryCode,
        vatNumber,
        companyName,
        customerEmail,
      });

      status = "pending_review";
      pendingManualReview = true;
      viesChecked = true;
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
        viesValid && !String(viesCompanyName || "").trim() && VIES_NAME_UNAVAILABLE_COUNTRIES.includes(countryCode)
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

      if (invoiceCompany?.companyId || invoiceCompany?.companyLocationId) {
        await db.invoiceRequest.update({
          where: { id: invoiceRequest.id },
          data: {
            shopifyCompanyId: invoiceCompany.companyId || null,
            shopifyCompanyLocationId: invoiceCompany.companyLocationId || null,
          },
        });
      }
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