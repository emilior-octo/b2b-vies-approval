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
const COUNTRY_KEYS = ["invoice_country_code", "billing_country", "countryCode", "country"];

function normalize(value: any) {
  return String(value || "").trim();
}

function normalizeKey(value: string) {
  return normalize(value).toLowerCase().replace(/[\s\-_]+/g, "");
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
  const target = normalizeKey(key);
  const found = attrs.find((item: any) => {
    const itemKey = normalizeKey(item.name || item.key);
    return itemKey === target;
  });

  return normalize(found?.value);
}

function getAttrAny(order: any, keys: string[]) {
  for (const key of keys) {
    const value = getAttr(order, key);
    if (value) return value;
  }

  return "";
}

function getGraphQlAttrAny(graphOrder: any, keys: string[]) {
  const attrs = graphOrder?.customAttributes || [];

  for (const key of keys) {
    const target = normalizeKey(key);
    const found = attrs.find((item: any) => normalizeKey(item.key) === target);
    const value = normalize(found?.value);
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

async function getOrderContext(admin: any, orderGid: string) {
  const data = await graphQL(
    admin,
    `#graphql
      query OrderFiscalContext($id: ID!) {
        order(id: $id) {
          id
          name
          email
          note
          customAttributes { key value }
          customer {
            id
            email
            customMetafields: metafields(first: 50, namespace: "custom") {
              nodes { key value }
            }
            b2bMetafields: metafields(first: 50, namespace: "b2b") {
              nodes { key value }
            }
          }
        }
      }
    `,
    { id: orderGid },
  );

  return data?.data?.order || null;
}

function metafieldMap(nodes: any[] = []) {
  const map: Record<string, string> = {};

  for (const item of nodes || []) {
    const key = normalize(item.key);
    const value = normalize(item.value);
    if (key && value) map[key] = value;
  }

  return map;
}

function getMetaAny(meta: Record<string, string>, keys: string[]) {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(meta || {})) {
    normalized[normalizeKey(key)] = value;
  }

  for (const key of keys) {
    const value = normalized[normalizeKey(key)];
    if (value) return value;
  }

  return "";
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
          metafields(first: 50, namespace: "b2b") {
            nodes { namespace key value }
          }
        }
      }
    `,
    { id: customerGid },
  );

  const customer = data?.data?.customer;
  if (!customer) return null;

  const meta = metafieldMap(customer.metafields?.nodes || []);

  const hasFiscalData =
    meta.vat_number ||
    meta.company_name_submitted ||
    meta.vies_company_name ||
    meta.pec ||
    meta.codice_destinatario;

  if (!hasFiscalData) return null;

  return { customer, meta };
}

function getCustomerCustomFiscalDataFromOrderContext(graphOrder: any) {
  const customer = graphOrder?.customer;
  if (!customer) return null;

  const meta = metafieldMap(customer.customMetafields?.nodes || []);

  return {
    customer,
    fiscalCode: getMetaAny(meta, FISCAL_CODE_KEYS),
    pec: getMetaAny(meta, PEC_KEYS),
    sdi: getMetaAny(meta, SDI_KEYS),
    vatNumber: getMetaAny(meta, VAT_KEYS),
    invoiceCountryCode: getMetaAny(meta, COUNTRY_KEYS),
    companyName: getMetaAny(meta, COMPANY_KEYS),
    invoiceType: getMetaAny(meta, ["invoice_type", "invoiceType"]),
    viesChecked: getMetaAny(meta, ["vies_checked", "viesChecked"]),
    viesValid: getMetaAny(meta, ["vies_valid", "viesValid"]),
    reverseCharge: getMetaAny(meta, ["reverse_charge", "reverseCharge"]),
  };
}

async function getInvoiceRequestFromDb(invoiceRequestId: string) {
  if (!invoiceRequestId) return null;

  try {
    return await db.invoiceRequest.findUnique({ where: { id: invoiceRequestId } });
  } catch (_error) {
    return null;
  }
}

function buildInvoiceNote({
  order,
  graphOrder,
  dbRequest,
  customerFiscalData,
}: {
  order: any;
  graphOrder?: any;
  dbRequest?: any;
  customerFiscalData?: any;
}) {
  const invoiceRequested = getAttr(order, "invoice_requested");
  if (!yes(invoiceRequested)) return null;

  const invoiceType =
    getAttr(order, "invoice_type") ||
    getGraphQlAttrAny(graphOrder, ["invoice_type", "invoiceType"]) ||
    customerFiscalData?.invoiceType ||
    dbRequest?.invoiceType ||
    "private";

  const invoiceRequestId = getAttr(order, "invoice_request_id") || dbRequest?.id || "";

  const fiscalCode =
    getAttrAny(order, FISCAL_CODE_KEYS) ||
    getGraphQlAttrAny(graphOrder, FISCAL_CODE_KEYS) ||
    customerFiscalData?.fiscalCode ||
    dbRequest?.fiscalCode ||
    "";

  const pec =
    getAttrAny(order, PEC_KEYS) ||
    getGraphQlAttrAny(graphOrder, PEC_KEYS) ||
    customerFiscalData?.pec ||
    dbRequest?.pec ||
    "";

  const sdi =
    getAttrAny(order, SDI_KEYS) ||
    getGraphQlAttrAny(graphOrder, SDI_KEYS) ||
    customerFiscalData?.sdi ||
    dbRequest?.codiceDestinatario ||
    "";

  const companyName =
    getAttrAny(order, COMPANY_KEYS) ||
    getGraphQlAttrAny(graphOrder, COMPANY_KEYS) ||
    customerFiscalData?.companyName ||
    dbRequest?.companyName ||
    "";

  const vatNumber =
    getAttrAny(order, VAT_KEYS) ||
    getGraphQlAttrAny(graphOrder, VAT_KEYS) ||
    customerFiscalData?.vatNumber ||
    dbRequest?.vatNumber ||
    "";

  const country =
    getAttrAny(order, COUNTRY_KEYS) ||
    getGraphQlAttrAny(graphOrder, COUNTRY_KEYS) ||
    customerFiscalData?.invoiceCountryCode ||
    dbRequest?.billingCountry ||
    "";

  const customerEmail =
    getAttr(order, "customer_email") ||
    graphOrder?.customer?.email ||
    customerFiscalData?.customer?.email ||
    dbRequest?.email ||
    order.email ||
    graphOrder?.email ||
    "";

  const viesChecked =
    getAttr(order, "vies_checked") ||
    getGraphQlAttrAny(graphOrder, ["vies_checked", "viesChecked"]) ||
    customerFiscalData?.viesChecked ||
    (dbRequest?.viesChecked === true ? "true" : dbRequest?.viesChecked === false ? "false" : "");

  const viesValid =
    getAttr(order, "vies_valid") ||
    getGraphQlAttrAny(graphOrder, ["vies_valid", "viesValid"]) ||
    customerFiscalData?.viesValid ||
    (dbRequest?.viesValid === true ? "true" : dbRequest?.viesValid === false ? "false" : "");

  const reverseCharge =
    getAttr(order, "reverse_charge") ||
    getGraphQlAttrAny(graphOrder, ["reverse_charge", "reverseCharge"]) ||
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

function upsertNoteBlock(existingNote: string, block: string, marker: string) {
  const current = normalize(existingNote);
  if (!block) return current;

  const start = current.indexOf(marker);
  if (start === -1) return [current, block].filter(Boolean).join("\n\n");

  const afterStart = current.slice(start);
  const endMarker = "=======================";
  const relativeEnd = afterStart.indexOf(endMarker);
  if (relativeEnd === -1) return current;

  const end = start + relativeEnd + endMarker.length;
  return `${current.slice(0, start).trim()}\n\n${block}\n\n${current.slice(end).trim()}`.trim();
}

function boolString(value: any) {
  if (value === true) return "true";
  if (value === false) return "false";
  return normalize(value);
}

export const action = async ({ request }: any) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log(`WEBHOOK ${topic} from ${shop}`);

    const order = payload;
    const orderGid = order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;

    const { admin } = await unauthenticated.admin(shop);

    const invoiceRequested = yes(getAttr(order, "invoice_requested"));
    const invoiceRequestId = getAttr(order, "invoice_request_id");

    let graphOrder: any = null;
    try {
      graphOrder = await getOrderContext(admin, orderGid);
    } catch (error) {
      console.error("Order context query failed:", error);
    }

    const customerGid =
      graphOrder?.customer?.id ||
      order.customer?.admin_graphql_api_id ||
      (order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : "");

    let nextNote = normalize(graphOrder?.note || order.note);
    const tags: string[] = [];

    if (invoiceRequested) {
      const [dbRequest] = await Promise.all([getInvoiceRequestFromDb(invoiceRequestId)]);
      const customerFiscalData = getCustomerCustomFiscalDataFromOrderContext(graphOrder);

      const fiscalNote = buildInvoiceNote({
        order,
        graphOrder,
        dbRequest,
        customerFiscalData,
      });

      const fiscalCode =
        getAttrAny(order, FISCAL_CODE_KEYS) ||
        getGraphQlAttrAny(graphOrder, FISCAL_CODE_KEYS) ||
        customerFiscalData?.fiscalCode ||
        dbRequest?.fiscalCode ||
        "";
      const pec =
        getAttrAny(order, PEC_KEYS) ||
        getGraphQlAttrAny(graphOrder, PEC_KEYS) ||
        customerFiscalData?.pec ||
        dbRequest?.pec ||
        "";
      const sdi =
        getAttrAny(order, SDI_KEYS) ||
        getGraphQlAttrAny(graphOrder, SDI_KEYS) ||
        customerFiscalData?.sdi ||
        dbRequest?.codiceDestinatario ||
        "";
      const vatNumber =
        getAttrAny(order, VAT_KEYS) ||
        getGraphQlAttrAny(graphOrder, VAT_KEYS) ||
        customerFiscalData?.vatNumber ||
        dbRequest?.vatNumber ||
        "";
      const companyName =
        getAttrAny(order, COMPANY_KEYS) ||
        getGraphQlAttrAny(graphOrder, COMPANY_KEYS) ||
        customerFiscalData?.companyName ||
        dbRequest?.companyName ||
        "";
      const country =
        getAttrAny(order, COUNTRY_KEYS) ||
        getGraphQlAttrAny(graphOrder, COUNTRY_KEYS) ||
        customerFiscalData?.invoiceCountryCode ||
        dbRequest?.billingCountry ||
        "";
      const invoiceType =
        getAttr(order, "invoice_type") ||
        getGraphQlAttrAny(graphOrder, ["invoice_type", "invoiceType"]) ||
        customerFiscalData?.invoiceType ||
        dbRequest?.invoiceType ||
        "";

      if (invoiceRequestId) {
        await db.invoiceRequest.updateMany({
          where: { id: invoiceRequestId },
          data: {
            orderId: orderGid,
            orderName: order.name || graphOrder?.name || null,
            customerId: customerGid || dbRequest?.customerId || null,
            email:
              order.email ||
              getAttr(order, "customer_email") ||
              graphOrder?.customer?.email ||
              customerFiscalData?.customer?.email ||
              dbRequest?.email ||
              null,
            invoiceType: invoiceType || dbRequest?.invoiceType || "private",
            companyName: companyName || dbRequest?.companyName || null,
            fiscalCode: fiscalCode || dbRequest?.fiscalCode || null,
            vatNumber: vatNumber || dbRequest?.vatNumber || null,
            billingCountry: country || dbRequest?.billingCountry || null,
            pec: pec || dbRequest?.pec || null,
            codiceDestinatario: sdi || dbRequest?.codiceDestinatario || null,
            status: "completed",
          },
        });
      }

      if (fiscalNote) {
        nextNote = upsertNoteBlock(nextNote, fiscalNote, "=== INVOICE REQUEST ===");
      }

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
        "invoice.vies_valid":
          getAttr(order, "vies_valid") ||
          getGraphQlAttrAny(graphOrder, ["vies_valid", "viesValid"]) ||
          customerFiscalData?.viesValid ||
          boolString(dbRequest?.viesValid),
        "invoice.reverse_charge":
          getAttr(order, "reverse_charge") ||
          getGraphQlAttrAny(graphOrder, ["reverse_charge", "reverseCharge"]) ||
          customerFiscalData?.reverseCharge ||
          boolString(dbRequest?.reverseCharge),
        "invoice.tax_exempt_applied":
          getAttr(order, "tax_exempt_applied") || boolString(dbRequest?.taxExemptApplied),
        "invoice.fiscal_note": fiscalNote || "",
      });
    }

    if (!invoiceRequested && customerGid) {
      const b2bData = await getCustomerB2BData(admin, customerGid);

      if (b2bData) {
        const b2bNote = buildB2BFiscalNote(order, b2bData);
        const meta = b2bData.meta || {};

        nextNote = upsertNoteBlock(nextNote, b2bNote, "=== B2B FISCAL DATA ===");

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

    if (nextNote && nextNote !== normalize(graphOrder?.note || order.note)) {
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
