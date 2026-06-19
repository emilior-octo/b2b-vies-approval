import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const FISCAL_CODE_KEYS = [
  "fiscal_code",
  "fiscalCode",
  "codice_fiscale",
  "codice fiscale",
  "codiceFiscale",
  "Codice fiscale",
  "Codice Fiscale",
];

const PEC_KEYS = ["pec", "PEC", "certified_email", "certifiedEmail"];

const SDI_KEYS = [
  "sdi",
  "SDI",
  "codice_sdi",
  "recipient_code",
  "codice_destinatario",
  "codice destinatario",
];

const VAT_KEYS = ["vat_number", "VAT", "vatNumber", "partita_iva", "Partita IVA"];
const COMPANY_KEYS = ["company_name", "companyName", "ragione_sociale", "Ragione sociale"];

function normalize(value: any) {
  return String(value || "").trim();
}

function getAllAttributes(order: any) {
  return [
    ...(order?.note_attributes || []),
    ...(order?.noteAttributes || []),
    ...(order?.custom_attributes || []),
    ...(order?.customAttributes || []),
  ];
}

function getAttr(order: any, key: string) {
  const attrs = getAllAttributes(order);
  const found = attrs.find((item: any) => item.name === key || item.key === key);
  return normalize(found?.value);
}

function getAttrAny(order: any, keys: string[]) {
  for (const key of keys) {
    const value = getAttr(order, key);
    if (value) return value;
  }

  return "";
}

function yes(value: string) {
  const normalized = normalize(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function updateOrderNote(admin: any, orderGid: string, note: string) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation OrderUpdate($input: OrderInput!) {
        orderUpdate(input: $input) {
          order { id note }
          userErrors { field message }
        }
      }
    `,
    { input: { id: orderGid, note } },
  );

  const errors = data?.data?.orderUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));
}

async function addOrderTags(admin: any, orderGid: string, tags: string[]) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `,
    { id: orderGid, tags },
  );

  const errors = data?.data?.tagsAdd?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));
}

async function setOrderMetafields(
  admin: any,
  orderGid: string,
  metafieldsToWrite: Record<string, string>,
) {
  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => normalize(value) !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId: orderGid,
        namespace,
        key,
        type:
          key === "fiscal_note" || key === "vies_address"
            ? "multi_line_text_field"
            : "single_line_text_field",
        value: normalize(value),
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

async function getCustomerB2BData(admin: any, customerGid: string) {
  if (!customerGid) return null;

  const data = await graphQL(
    admin,
    `#graphql
      query CustomerB2BData($id: ID!) {
        customer(id: $id) {
          id
          email
          tags
          metafields(first: 30, namespace: "b2b") {
            nodes {
              namespace
              key
              value
            }
          }
        }
      }
    `,
    { id: customerGid },
  );

  const customer = data?.data?.customer;
  if (!customer) return null;

  const meta: Record<string, string> = {};

  for (const item of customer.metafields?.nodes || []) {
    meta[item.key] = item.value;
  }

  const hasFiscalData =
    meta.vat_number ||
    meta.company_name_submitted ||
    meta.vies_company_name ||
    meta.pec ||
    meta.codice_destinatario;

  if (!hasFiscalData) return null;

  return {
    customer,
    meta,
  };
}

async function getCustomerCustomFiscalData(admin: any, customerGid: string) {
  if (!customerGid) return null;

  const data = await graphQL(
    admin,
    `#graphql
      query CustomerCustomFiscalData($id: ID!) {
        customer(id: $id) {
          id
          email
          fiscalCode: metafield(namespace: "custom", key: "fiscal_code") { value }
          pec: metafield(namespace: "custom", key: "pec") { value }
          sdi: metafield(namespace: "custom", key: "sdi") { value }
          vatNumber: metafield(namespace: "custom", key: "vat_number") { value }
          invoiceCountryCode: metafield(namespace: "custom", key: "invoice_country_code") { value }
          companyName: metafield(namespace: "custom", key: "company_name") { value }
          invoiceType: metafield(namespace: "custom", key: "invoice_type") { value }
          viesChecked: metafield(namespace: "custom", key: "vies_checked") { value }
          viesValid: metafield(namespace: "custom", key: "vies_valid") { value }
          reverseCharge: metafield(namespace: "custom", key: "reverse_charge") { value }
        }
      }
    `,
    { id: customerGid },
  );

  const customer = data?.data?.customer;
  if (!customer) return null;

  return {
    customer,
    fiscalCode: normalize(customer.fiscalCode?.value),
    pec: normalize(customer.pec?.value),
    sdi: normalize(customer.sdi?.value),
    vatNumber: normalize(customer.vatNumber?.value),
    invoiceCountryCode: normalize(customer.invoiceCountryCode?.value),
    companyName: normalize(customer.companyName?.value),
    invoiceType: normalize(customer.invoiceType?.value),
    viesChecked: normalize(customer.viesChecked?.value),
    viesValid: normalize(customer.viesValid?.value),
    reverseCharge: normalize(customer.reverseCharge?.value),
  };
}

async function getInvoiceRequestFromDb(invoiceRequestId: string) {
  if (!invoiceRequestId) return null;

  try {
    return await db.invoiceRequest.findUnique({
      where: { id: invoiceRequestId },
    });
  } catch (_error) {
    return null;
  }
}

function buildInvoiceNote({
  order,
  dbRequest,
  customerFiscalData,
}: {
  order: any;
  dbRequest?: any;
  customerFiscalData?: any;
}) {
  const invoiceRequested = getAttr(order, "invoice_requested");
  if (!yes(invoiceRequested)) return null;

  const invoiceType =
    getAttr(order, "invoice_type") ||
    customerFiscalData?.invoiceType ||
    dbRequest?.invoiceType ||
    "private";

  const invoiceRequestId = getAttr(order, "invoice_request_id") || dbRequest?.id || "";

  const fiscalCode =
    getAttrAny(order, FISCAL_CODE_KEYS) ||
    customerFiscalData?.fiscalCode ||
    "";

  const pec =
    getAttrAny(order, PEC_KEYS) ||
    customerFiscalData?.pec ||
    dbRequest?.pec ||
    "";

  const sdi =
    getAttrAny(order, SDI_KEYS) ||
    customerFiscalData?.sdi ||
    dbRequest?.codiceDestinatario ||
    "";

  const companyName =
    getAttrAny(order, COMPANY_KEYS) ||
    customerFiscalData?.companyName ||
    dbRequest?.companyName ||
    "";

  const vatNumber =
    getAttrAny(order, VAT_KEYS) ||
    customerFiscalData?.vatNumber ||
    dbRequest?.vatNumber ||
    "";

  const country =
    getAttr(order, "invoice_country_code") ||
    customerFiscalData?.invoiceCountryCode ||
    dbRequest?.billingCountry ||
    "";

  const customerEmail =
    getAttr(order, "customer_email") ||
    customerFiscalData?.customer?.email ||
    dbRequest?.email ||
    order.email ||
    "";

  const viesChecked =
    getAttr(order, "vies_checked") ||
    customerFiscalData?.viesChecked ||
    (dbRequest?.viesChecked === true ? "true" : dbRequest?.viesChecked === false ? "false" : "");

  const viesValid =
    getAttr(order, "vies_valid") ||
    customerFiscalData?.viesValid ||
    (dbRequest?.viesValid === true ? "true" : dbRequest?.viesValid === false ? "false" : "");

  const reverseCharge =
    getAttr(order, "reverse_charge") ||
    customerFiscalData?.reverseCharge ||
    (dbRequest?.reverseCharge === true ? "true" : dbRequest?.reverseCharge === false ? "false" : "");

  const taxExemptApplied =
    getAttr(order, "tax_exempt_applied") ||
    (dbRequest?.taxExemptApplied === true ? "true" : dbRequest?.taxExemptApplied === false ? "false" : "");

  const taxExemptPrepared = getAttr(order, "tax_exempt_customer_prepared");

  if (invoiceType === "private") {
    return [
      "=== INVOICE REQUEST ===",
      "",
      "Type: Private invoice",
      fiscalCode ? `Fiscal code: ${fiscalCode}` : "Fiscal code: -",
      pec ? `PEC: ${pec}` : "PEC: -",
      "",
      `Customer email: ${customerEmail || "-"}`,
      "",
      `Invoice Request ID: ${invoiceRequestId || "-"}`,
      "=======================",
    ].join("\n");
  }

  return [
    "=== INVOICE REQUEST ===",
    "",
    "Type: Company invoice",
    `Company: ${companyName || "-"}`,
    `VAT: ${vatNumber || "-"}`,
    `Country: ${country || "-"}`,
    `PEC: ${pec || "-"}`,
    `SDI: ${sdi || "-"}`,
    `Customer email: ${customerEmail || "-"}`,
    "",
    `VIES checked: ${viesChecked || "-"}`,
    `VIES valid: ${viesValid || "-"}`,
    `Reverse charge: ${reverseCharge || "-"}`,
    `Tax exempt applied: ${taxExemptApplied || "-"}`,
    `Tax exempt customer prepared: ${taxExemptPrepared || "-"}`,
    "",
    `Invoice Request ID: ${invoiceRequestId || "-"}`,
    "=======================",
  ].join("\n");
}

function buildB2BFiscalNote(order: any, b2bData: any) {
  const meta = b2bData?.meta || {};

  return [
    "=== B2B FISCAL DATA ===",
    "",
    `Company submitted: ${meta.company_name_submitted || "-"}`,
    `VIES company: ${meta.vies_company_name || "-"}`,
    `VAT: ${meta.vat_number || "-"}`,
    `Country: ${meta.billing_country || "-"}`,
    `PEC: ${meta.pec || "-"}`,
    `SDI: ${meta.codice_destinatario || "-"}`,
    "",
    `VIES status: ${meta.vies_status || "-"}`,
    `VIES match score: ${meta.vies_match_score || "-"}`,
    `Verified at: ${meta.verified_at || "-"}`,
    "",
    `Customer email: ${b2bData?.customer?.email || order.email || "-"}`,
    "=======================",
  ].join("\n");
}

function appendNote(existingNote: string, block: string, marker: string) {
  const current = normalize(existingNote);

  if (current.includes(marker)) return current;

  return [current, block].filter(Boolean).join("\n\n");
}

export const action = async ({ request }: any) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log(`WEBHOOK ${topic} from ${shop}`);

    const order = payload;
    const orderGid =
      order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;

    const { admin } = await unauthenticated.admin(shop);

    const invoiceRequested = yes(getAttr(order, "invoice_requested"));
    const invoiceRequestId = getAttr(order, "invoice_request_id");

    const customerGid =
      order.customer?.admin_graphql_api_id ||
      (order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : "");

    let nextNote = normalize(order.note);
    const tags: string[] = [];

    if (invoiceRequested) {
      const [customerFiscalData, dbRequest] = await Promise.all([
        customerGid ? getCustomerCustomFiscalData(admin, customerGid) : Promise.resolve(null),
        getInvoiceRequestFromDb(invoiceRequestId),
      ]);

      const fiscalNote = buildInvoiceNote({
        order,
        dbRequest,
        customerFiscalData,
      });

      if (invoiceRequestId) {
        await db.invoiceRequest.updateMany({
          where: { id: invoiceRequestId },
          data: {
            orderId: orderGid,
            orderName: order.name || null,
            email:
              order.email ||
              getAttr(order, "customer_email") ||
              customerFiscalData?.customer?.email ||
              dbRequest?.email ||
              null,
            status: "completed",
          },
        });
      }

      if (fiscalNote) {
        nextNote = appendNote(nextNote, fiscalNote, "=== INVOICE REQUEST ===");
      }

      const fiscalCode =
        getAttrAny(order, FISCAL_CODE_KEYS) || customerFiscalData?.fiscalCode || "";
      const pec =
        getAttrAny(order, PEC_KEYS) || customerFiscalData?.pec || dbRequest?.pec || "";
      const sdi =
        getAttrAny(order, SDI_KEYS) || customerFiscalData?.sdi || dbRequest?.codiceDestinatario || "";
      const vatNumber =
        getAttrAny(order, VAT_KEYS) || customerFiscalData?.vatNumber || dbRequest?.vatNumber || "";
      const companyName =
        getAttrAny(order, COMPANY_KEYS) || customerFiscalData?.companyName || dbRequest?.companyName || "";
      const country =
        getAttr(order, "invoice_country_code") || customerFiscalData?.invoiceCountryCode || dbRequest?.billingCountry || "";
      const invoiceType =
        getAttr(order, "invoice_type") || customerFiscalData?.invoiceType || dbRequest?.invoiceType || "";

      tags.push("invoice_request");

      if (yes(getAttr(order, "reverse_charge")) || dbRequest?.reverseCharge) tags.push("reverse_charge");
      if (yes(getAttr(order, "vies_valid")) || dbRequest?.viesValid) tags.push("vies_valid");
      if (getAttr(order, "invoice_request_status") === "pending_review" || dbRequest?.status === "pending_review") {
        tags.push("invoice_pending_review");
      }

      await setOrderMetafields(admin, orderGid, {
        "invoice.request_id": invoiceRequestId,
        "invoice.invoice_type": invoiceType,
        "invoice.fiscal_code": fiscalCode,
        "invoice.company_name": companyName,
        "invoice.vat_number": vatNumber,
        "invoice.billing_country": country,
        "invoice.pec": pec,
        "invoice.codice_destinatario": sdi,
        "invoice.vies_valid": getAttr(order, "vies_valid") || customerFiscalData?.viesValid || (dbRequest?.viesValid === true ? "true" : dbRequest?.viesValid === false ? "false" : ""),
        "invoice.reverse_charge": getAttr(order, "reverse_charge") || customerFiscalData?.reverseCharge || (dbRequest?.reverseCharge === true ? "true" : dbRequest?.reverseCharge === false ? "false" : ""),
        "invoice.tax_exempt_applied": getAttr(order, "tax_exempt_applied") || (dbRequest?.taxExemptApplied === true ? "true" : dbRequest?.taxExemptApplied === false ? "false" : ""),
        "invoice.fiscal_note": fiscalNote || "",
      });
    }

    if (!invoiceRequested && customerGid) {
      const b2bData = await getCustomerB2BData(admin, customerGid);

      if (b2bData) {
        const b2bNote = buildB2BFiscalNote(order, b2bData);
        const meta = b2bData.meta || {};

        nextNote = appendNote(nextNote, b2bNote, "=== B2B FISCAL DATA ===");

        tags.push("b2b_customer_order", "b2b_fiscal_data");

        await setOrderMetafields(admin, orderGid, {
          "b2b.vat_number": meta.vat_number || "",
          "b2b.billing_country": meta.billing_country || "",
          "b2b.company_name_submitted": meta.company_name_submitted || "",
          "b2b.vies_company_name": meta.vies_company_name || "",
          "b2b.pec": meta.pec || "",
          "b2b.codice_destinatario": meta.codice_destinatario || "",
          "b2b.vies_status": meta.vies_status || "",
          "b2b.vies_match_score": meta.vies_match_score || "",
          "b2b.fiscal_note": b2bNote,
        });
      }
    }

    if (nextNote && nextNote !== normalize(order.note)) {
      await updateOrderNote(admin, orderGid, nextNote);
    }

    if (tags.length) {
      await addOrderTags(admin, orderGid, [...new Set(tags)]);
    }

    return new Response("OK");
  } catch (error) {
    console.error("orders/create webhook error:", error);
    return new Response("ERROR", { status: 500 });
  }
};
