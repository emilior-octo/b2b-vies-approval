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
          }
        }
      }
    `,
    { query: `email:${email}` },
  );

  return data?.data?.customers?.nodes?.[0] || null;
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
            customer {
              id
              email
              taxExempt
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
          note: `Invoice request reverse charge - ${companyName || ""}`,
          tags: ["invoice_request", "reverse_charge_customer"],
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

  const updateData = await graphQL(
    admin,
    `#graphql
      mutation CustomerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            email
            taxExempt
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
        taxExempt: true,
        tags: ["invoice_request", "reverse_charge_customer"],
      },
    },
  );

  const errors = updateData?.data?.customerUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return updateData?.data?.customerUpdate?.customer || customer;
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
    let status = "registered";
    let pendingManualReview = false;

    try {
      const verification = await verifyCompanyVat({
        vatNumber,
        companyName,
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