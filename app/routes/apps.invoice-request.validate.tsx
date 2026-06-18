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

  return data?.data?.customers?.nodes?.[0] || null;
}

async function createOrUpdateInvoiceCustomer({
  shop,
  email,
  companyName,
  taxExempt,
}: {
  shop: string;
  email: string;
  companyName?: string;
  taxExempt?: boolean;
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
            customer {
              id
              email
              taxExempt
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
          email,
          firstName: "Invoice",
          lastName: "Customer",
          note: `Invoice request - ${companyName || ""}`,
          tags: ["invoice_request"],
          taxExempt: Boolean(taxExempt),
        },
      },
    );

    const errors = createData?.data?.customerCreate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((e: any) => e.message).join(" | "));
    }

    customer = createData?.data?.customerCreate?.customer;
  }

  if (!customer?.id) return null;

  const tags = taxExempt
    ? ["invoice_request", "reverse_charge_customer"]
    : ["invoice_request"];

  const updateData = await graphQL(
    admin,
    `#graphql
      mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            email
            taxExempt
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
        id: customer.id,
        taxExempt: Boolean(taxExempt),
        tags,
      },
    },
  );

  const errors = updateData?.data?.customerUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return updateData?.data?.customerUpdate?.customer || customer;
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
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return data?.data?.metafieldsSet?.metafields || [];
}

async function setCompanyMetafields(
  admin: any,
  companyId: string,
  metafieldsToWrite: Record<string, string>,
) {
  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId: companyId,
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
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return data?.data?.metafieldsSet?.metafields || [];
}

function firstAddressLine(address: string) {
  return String(address || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0] || "Address from VIES";
}

async function createCompanyAndAssignCustomer({
  admin,
  customer,
  companyName,
  countryCode,
  vatNumber,
  viesAddress,
  pec,
  sdi,
}: {
  admin: any;
  customer: any;
  companyName: string;
  countryCode: string;
  vatNumber: string;
  viesAddress?: string;
  pec?: string;
  sdi?: string;
}) {
  const existingCompany = customer?.companyContactProfiles?.[0]?.company || null;

  if (existingCompany?.id) {
    await setCompanyMetafields(admin, existingCompany.id, {
      "invoice.vat_number": normalizeVat(vatNumber || ""),
      "invoice.billing_country": normalizeCountry(countryCode || ""),
      "invoice.pec": pec || "",
      "invoice.codice_destinatario": sdi || "",
      "invoice.vies_address": viesAddress || "",
    });

    return {
      skipped: true,
      reason: "Customer already assigned to company.",
      companyId: existingCompany.id,
      companyName: existingCompany.name,
      companyLocationId: null,
    };
  }

  const normalizedCountry = normalizeCountry(countryCode || "IT");
  const normalizedVat = normalizeVat(vatNumber || "");

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
          taxRegistrationId: normalizedVat,
          taxExempt: normalizedCountry !== SHOP_COUNTRY,
          billingAddress: {
            recipient: companyName,
            address1: firstAddressLine(viesAddress || ""),
            city: "N/A",
            countryCode: normalizedCountry,
          },
        },
      },
    },
  );

  const companyErrors = companyCreateData?.data?.companyCreate?.userErrors || [];
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
      companyId: company?.id || null,
      companyLocationId: location?.id || null,
    };
  }

  await setCompanyMetafields(admin, company.id, {
    "invoice.vat_number": normalizedVat,
    "invoice.billing_country": normalizedCountry,
    "invoice.pec": pec || "",
    "invoice.codice_destinatario": sdi || "",
    "invoice.vies_address": viesAddress || "",
  });

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
    assignCustomerData?.data?.companyAssignCustomerAsContact?.userErrors || [];
  if (assignErrors.length) {
    throw new Error(assignErrors.map((e: any) => e.message).join(" | "));
  }

  const companyContact =
    assignCustomerData?.data?.companyAssignCustomerAsContact?.companyContact;

  if (companyContact?.id) {
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
      assignRoleData?.data?.companyContactAssignRole?.userErrors || [];
    if (roleErrors.length) {
      throw new Error(roleErrors.map((e: any) => e.message).join(" | "));
    }
  }

  return {
    created: true,
    companyId: company.id,
    companyName: company.name,
    companyLocationId: location.id,
    companyLocationName: location.name,
    companyContactId: companyContact?.id || null,
    companyContactRoleId: role.id,
    companyContactRoleName: role.name,
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
    const vatNumber = normalizeVat(payload.vatNumber || "");
    const companyName = String(payload.companyName || "").trim();
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
      return json({ ok: false, error: "Invalid invoice type." }, { status: 400 });
    }

    const isItaly = countryCode === "IT";

    if (!isItaly && !customerEmail) {
      return json(
        {
          ok: false,
          error:
            locale === "it"
              ? "Per aziende EU/estere inserisci l’email che userai al checkout."
              : "For EU/foreign companies, enter the email you will use at checkout.",
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
    let companyWrite: any = null;
    let status = "registered";
    let pendingManualReview = false;

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

      reverseCharge = shouldApplyReverseCharge({
        shopCountry: SHOP_COUNTRY,
        billingCountry: countryCode,
        viesValid,
      });

      if (customerEmail) {
        const { admin } = await unauthenticated.admin(shop);

        preparedCustomer = await createOrUpdateInvoiceCustomer({
          shop,
          email: customerEmail,
          companyName: viesCompanyName || companyName,
          taxExempt: reverseCharge,
        });

        if (preparedCustomer?.id) {
          await setCustomerMetafields(admin, preparedCustomer.id, {
            "invoice.vat_number": verification.vies.vatNumber || vatNumber,
            "invoice.billing_country": countryCode,
            "invoice.company_name": companyName,
            "invoice.vies_company_name": viesCompanyName,
            "invoice.vies_address": viesAddress,
            "invoice.reverse_charge": reverseCharge ? "true" : "false",
            "invoice.pec": isItaly ? pec : "",
            "invoice.codice_destinatario": isItaly ? sdi : "",
          });

          if (viesValid) {
            companyWrite = await createCompanyAndAssignCustomer({
              admin,
              customer: preparedCustomer,
              companyName: viesCompanyName || companyName,
              countryCode,
              vatNumber: verification.vies.vatNumber || vatNumber,
              viesAddress,
              pec: isItaly ? pec : "",
              sdi: isItaly ? sdi : "",
            });
          }
        }

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
        shopifyCompanyId: companyWrite?.companyId || null,
        shopifyCompanyLocationId: companyWrite?.companyLocationId || null,
        status,
      },
    });

    if (preparedCustomer?.id) {
      const { admin } = await unauthenticated.admin(shop);
      await setCustomerMetafields(admin, preparedCustomer.id, {
        "invoice.invoice_request_id": invoiceRequest.id,
      });
    }

    return json({
      ok: true,
      invoiceRequestId: invoiceRequest.id,
      invoiceType: "company",
      customerEmail,
      customerId: preparedCustomer?.id || null,
      shopifyCompanyId: companyWrite?.companyId || null,
      shopifyCompanyLocationId: companyWrite?.companyLocationId || null,
      vatNumber: viesValid ? viesCompanyName ? vatNumber : vatNumber : vatNumber,
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
      companyCreated: Boolean(companyWrite?.created),
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
