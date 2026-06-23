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
            taxExempt
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

async function createOrPrepareTaxExemptCustomer({
  shop,
  email,
  companyName,
}: {
  shop: string;
  email: string;
  companyName?: string;
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
          note: `Invoice request reverse charge - ${companyName || ""}`,
          tags: ["invoice_request", "reverse_charge_customer"],
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
        taxExempt: true,
        tags: ["invoice_request", "reverse_charge_customer"],
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

function missingCompanyInvoiceFields({
  invoiceType,
  countryCode,
  vatNumber,
  companyName,
  customerEmail,
  pec,
  sdi,
}: {
  invoiceType: string;
  countryCode: string;
  vatNumber: string;
  companyName: string;
  customerEmail: string;
  pec: string;
  sdi: string;
}) {
  const missing: string[] = [];
  const isItaly = countryCode === "IT";

  if (invoiceType !== "company") return missing;
  if (!String(companyName || "").trim()) missing.push("company_name");
  if (!String(vatNumber || "").trim()) missing.push("vat_number");
  if (!String(countryCode || "").trim()) missing.push("country_code");

  if (isItaly) {
    if (!String(pec || "").trim() && !String(sdi || "").trim()) {
      missing.push("pec_or_sdi");
    }
  } else if (!String(customerEmail || "").trim()) {
    missing.push("customer_email");
  }

  return missing;
}

function incompleteInvoiceMessage(locale: string, missingFields: string[]) {
  if (locale === "it") {
    const labelMap: Record<string, string> = {
      company_name: "ragione sociale",
      vat_number: "Partita IVA",
      country_code: "Paese",
      pec_or_sdi: "PEC o Codice SDI",
      customer_email: "email da usare al checkout",
    };

    const readable = missingFields.map((field) => labelMap[field] || field).join(", ");
    return `Richiesta fattura incompleta. Controlla i dati mancanti: ${readable}.`;
  }

  const labelMap: Record<string, string> = {
    company_name: "company name",
    vat_number: "VAT number",
    country_code: "country",
    pec_or_sdi: "PEC or SDI code",
    customer_email: "checkout email",
  };

  const readable = missingFields.map((field) => labelMap[field] || field).join(", ");
  return `Incomplete invoice request. Please check the missing details: ${readable}.`;
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
  const effectiveCompanyName = cleanViesText(viesCompanyName) || String(companyName || "").trim();
  if (!effectiveCompanyName || !customer?.id) return null;

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
    let vatNumber = normalizeVat(payload.vatNumber || "");
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
    const missingFields = missingCompanyInvoiceFields({
      invoiceType,
      countryCode,
      vatNumber,
      companyName,
      customerEmail,
      pec,
      sdi,
    });

    if (missingFields.length) {
      const invoiceRequest = await db.invoiceRequest.create({
        data: {
          shop,
          cartToken: cartToken || null,
          invoiceType: "company",
          email: customerEmail || null,
          companyName: companyName || null,
          vatNumber: vatNumber || "",
          billingCountry: countryCode,
          pec: isItaly ? pec || null : null,
          codiceDestinatario: isItaly ? sdi || null : null,
          viesChecked: false,
          viesValid: null,
          reverseCharge: false,
          taxExemptApplied: false,
          status: "registered",
        },
      });

      return json({
        ok: true,
        invoiceRequestId: invoiceRequest.id,
        invoiceType: "company",
        customerEmail,
        vatNumber,
        countryCode,
        viesChecked: false,
        viesValid: null,
        reverseCharge: false,
        taxExemptApplied: false,
        taxExemptCustomerPrepared: false,
        mustUseSameEmailAtCheckout: false,
        incompleteRequest: true,
        missingFields,
        validationMessage: "INCOMPLETE_INVOICE_DATA",
        message: incompleteInvoiceMessage(locale, missingFields),
      });
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
    let validationMessage: "VAT_NOT_VERIFIED" | null = null;

    try {
      const verification = await verifyCompanyVat({
        vatNumber,
        companyName,
        countryCode,
      });

      viesChecked = true;
      viesValid = verification.vies.valid;
      viesCompanyName = verification.vies.companyName || "";
      viesAddress = verification.vies.address || "";
      vatNumber = verification.vies.vatNumber || vatNumber;

      const acceptsMissingViesName =
        VIES_NAME_UNAVAILABLE_COUNTRIES.includes(verification.vies.countryCode) &&
        !String(viesCompanyName || "").trim();

      reverseCharge = shouldApplyReverseCharge({
        shopCountry: SHOP_COUNTRY,
        billingCountry: countryCode,
        viesValid,
      });

      if (reverseCharge && customerEmail) {
        preparedCustomer = await createOrPrepareTaxExemptCustomer({
          shop,
          email: customerEmail,
          companyName: viesCompanyName || companyName,
        });

        taxExemptCustomerPrepared = Boolean(preparedCustomer?.taxExempt);
      }

      if (!viesValid) {
        status = "pending_review";
        pendingManualReview = true;
        validationMessage = "VAT_NOT_VERIFIED";
      }
    } catch (error) {
      console.error("Invoice VIES check failed:", error);

      status = "pending_review";
      pendingManualReview = true;
      viesChecked = false;
      viesValid = null;
      reverseCharge = false;
      taxExemptCustomerPrepared = false;
      validationMessage = "VAT_NOT_VERIFIED";
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

    if (invoiceType === "company" && preparedCustomer?.id && (reverseCharge || countryCode === "IT" || viesValid)) {
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
      pendingReview: pendingManualReview,
      pendingManualReview,
      validationMessage,
      company: invoiceCompany,
      message: undefined,
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