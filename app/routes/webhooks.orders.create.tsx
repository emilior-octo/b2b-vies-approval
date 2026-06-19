import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

const INVOICE_START = "=== INVOICE REQUEST ===";
const INVOICE_END = "=======================";
const B2B_START = "=== B2B FISCAL DATA ===";
const B2B_END = "=======================";

const INVOICE_REQUEST_KEYS = ["invoice_requested"];
const INVOICE_TYPE_KEYS = ["invoice_type"];
const INVOICE_REQUEST_ID_KEYS = ["invoice_request_id"];
const CUSTOMER_EMAIL_KEYS = ["customer_email", "email"];

const FISCAL_CODE_KEYS = [
  "TAX_CREDENTIAL_IT",
  "IT.TAX_CREDENTIAL_IT",
  "tax credential",
  "fiscal_code",
  "fiscalCode",
  "codice_fiscale",
  "codice fiscale",
  "codiceFiscale",
  "Codice fiscale",
  "Codice Fiscale",
  "tax_code",
  "taxCode",
  "cf",
];

const PEC_KEYS = [
  "TAX_EMAIL_IT",
  "IT.TAX_EMAIL_IT",
  "tax email",
  "pec",
  "PEC",
  "certified_email",
  "certifiedEmail",
  "certified email",
  "posta certificata",
  "posta_certificata",
  "posta_elettronica_certificata",
];

const SDI_KEYS = [
  "sdi",
  "SDI",
  "codice_sdi",
  "recipient_code",
  "codice_destinatario",
  "codice destinatario",
  "Codice destinatario",
  "Codice Destinatario",
];

const VAT_KEYS = [
  "vat_number",
  "VAT",
  "vatNumber",
  "partita_iva",
  "Partita IVA",
  "partita iva",
];

const COMPANY_KEYS = [
  "company_name",
  "companyName",
  "ragione_sociale",
  "Ragione sociale",
  "Ragione Sociale",
];

const COUNTRY_KEYS = [
  "invoice_country_code",
  "invoiceCountryCode",
  "billing_country",
  "country",
];

function normalize(value: any) {
  return String(value ?? "").trim();
}

function normalizeKey(value: any) {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function yes(value: any) {
  const normalized = normalize(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function booleanToString(value: boolean | null | undefined) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

function labelBool(value: any) {
  const text = normalize(value);
  if (!text) return "-";
  return yes(text) ? "YES" : "NO";
}

function readPairKey(item: any) {
  return normalize(
    item?.key ??
      item?.name ??
      item?.localizedKey ??
      item?.type ??
      item?.label ??
      item?.title ??
      "",
  );
}

function readPairValue(item: any) {
  return normalize(item?.value ?? item?.val ?? item?.text ?? item?.content ?? "");
}

function getWebhookAttributes(order: any) {
  return [
    ...(order?.note_attributes || []),
    ...(order?.noteAttributes || []),
    ...(order?.custom_attributes || []),
    ...(order?.customAttributes || []),
  ];
}

function getAttrFromPairs(pairs: any[], keys: string[]) {
  const wanted = keys.map(normalizeKey);

  for (const pair of pairs || []) {
    const key = normalizeKey(readPairKey(pair));
    if (wanted.includes(key)) {
      const value = readPairValue(pair);
      if (value) return value;
    }
  }

  return "";
}

function getLocalizationValue(orderApi: any, keys: string[]) {
  const wanted = keys.map(normalizeKey).filter(Boolean);
  const nodes = orderApi?.localizationExtensions?.nodes || [];

  for (const node of nodes) {
    // IMPORTANT: do not use purpose here. Shopify often uses a generic purpose
    // such as TAX for both Codice Fiscale and PEC, and that can make PEC pick
    // the fiscal code by mistake. Match only strict key/title/country.key.
    const rawCandidates = [
      node?.key,
      node?.title,
      node?.countryCode && node?.key ? `${node.countryCode}.${node.key}` : "",
    ];

    const candidates = rawCandidates.map(normalizeKey).filter(Boolean);

    if (candidates.some((candidate) => wanted.includes(candidate))) {
      const value = normalize(node?.value);
      if (value) return value;
    }
  }

  return "";
}

function getAddressCountry(orderApi: any) {
  return (
    normalize(orderApi?.billingAddress?.countryCodeV2) ||
    normalize(orderApi?.shippingAddress?.countryCodeV2) ||
    ""
  );
}

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  const data = await response.json();

  if (data?.errors?.length) {
    console.error("GraphQL errors:", JSON.stringify(data.errors));
  }

  return data;
}

async function getOrderApiData(admin: any, orderGid: string) {
  const data = await graphQL(
    admin,
    `#graphql
      query OrderFiscalData($id: ID!) {
        order(id: $id) {
          id
          name
          note
          email
          customAttributes { key value }
          localizationExtensions(first: 20) {
            nodes {
              key
              value
              title
              countryCode
              purpose
            }
          }
          billingAddress { firstName lastName company countryCodeV2 }
          shippingAddress { firstName lastName company countryCodeV2 }
          customer {
            id
            email
            firstName
            lastName
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
            b2bMetafields: metafields(first: 40, namespace: "b2b") {
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
  const uniqueTags = [...new Set(tags.filter(Boolean))];
  if (!uniqueTags.length) return;

  const data = await graphQL(
    admin,
    `#graphql
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `,
    { id: orderGid, tags: uniqueTags },
  );

  const errors = data?.data?.tagsAdd?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join(" | "));
}

async function setMetafields(
  admin: any,
  ownerId: string,
  metafieldsToWrite: Record<string, string>,
) {
  if (!ownerId) return [];

  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => normalize(value) !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId,
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

async function getInvoiceRequestFromDb(invoiceRequestId: string) {
  if (!invoiceRequestId) return null;

  try {
    return await db.invoiceRequest.findUnique({ where: { id: invoiceRequestId } });
  } catch (error) {
    console.error("InvoiceRequest DB read failed:", error);
    return null;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withoutBlock(note: string, startMarker: string, endMarker: string) {
  const current = normalize(note);
  if (!current.includes(startMarker)) return current;

  const pattern = new RegExp(
    `\\n*${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n*`,
    "g",
  );

  return current.replace(pattern, "\n").trim();
}

function replaceBlock(note: string, block: string, startMarker: string, endMarker: string) {
  const clean = withoutBlock(note, startMarker, endMarker);
  return [clean, block].filter(Boolean).join("\n\n");
}

function buildInvoiceNote(data: any) {
  const invoiceType = normalize(data.invoiceType || "private");
  const isCompany = invoiceType === "company";

  const lines = [INVOICE_START, "", `Type: ${isCompany ? "Company" : "Private invoice"}`];

  if (isCompany) {
    lines.push(
      `Company: ${data.companyName || "-"}`,
      `VAT: ${data.vatNumber || "-"}`,
      `Country: ${data.billingCountry || "-"}`,
      `PEC: ${data.pec || "-"}`,
      `SDI: ${data.codiceDestinatario || "-"}`,
      "",
      `VIES checked: ${labelBool(data.viesChecked)}`,
      `VIES valid: ${labelBool(data.viesValid)}`,
      `Reverse charge: ${labelBool(data.reverseCharge)}`,
      `Tax exempt applied: ${labelBool(data.taxExemptApplied)}`,
    );
  } else {
    lines.push(
      `Fiscal code: ${data.fiscalCode || "-"}`,
      `PEC: ${data.pec || "-"}`,
    );
  }

  lines.push(
    "",
    `Customer: ${[data.firstName, data.lastName].filter(Boolean).join(" ") || "-"}`,
    `Customer email: ${data.email || "-"}`,
    "",
    `Invoice Request ID: ${data.invoiceRequestId || "-"}`,
    INVOICE_END,
  );

  return lines.join("\n");
}

function buildB2BFiscalNote(orderApi: any, b2bMeta: Record<string, string>) {
  return [
    B2B_START,
    "",
    `Company submitted: ${b2bMeta.company_name_submitted || "-"}`,
    `VIES company: ${b2bMeta.vies_company_name || "-"}`,
    `VAT: ${b2bMeta.vat_number || "-"}`,
    `Country: ${b2bMeta.billing_country || "-"}`,
    `PEC: ${b2bMeta.pec || "-"}`,
    `SDI: ${b2bMeta.codice_destinatario || "-"}`,
    "",
    `VIES status: ${b2bMeta.vies_status || "-"}`,
    `VIES match score: ${b2bMeta.vies_match_score || "-"}`,
    `Verified at: ${b2bMeta.verified_at || "-"}`,
    "",
    `Customer email: ${orderApi?.customer?.email || orderApi?.email || "-"}`,
    B2B_END,
  ].join("\n");
}

function getB2BMeta(orderApi: any) {
  const meta: Record<string, string> = {};
  for (const item of orderApi?.customer?.b2bMetafields?.nodes || []) {
    meta[item.key] = normalize(item.value);
  }
  return meta;
}

function hasB2BMeta(meta: Record<string, string>) {
  return Boolean(
    meta.vat_number ||
      meta.company_name_submitted ||
      meta.vies_company_name ||
      meta.pec ||
      meta.codice_destinatario,
  );
}

function getOrderGid(orderPayload: any) {
  return orderPayload.admin_graphql_api_id || `gid://shopify/Order/${orderPayload.id}`;
}

function getCustomerGid(orderPayload: any, orderApi: any) {
  return (
    orderApi?.customer?.id ||
    orderPayload.customer?.admin_graphql_api_id ||
    (orderPayload.customer?.id ? `gid://shopify/Customer/${orderPayload.customer.id}` : "")
  );
}

function buildInvoiceData({ orderPayload, orderApi, invoiceRequest }: any) {
  const webhookPairs = getWebhookAttributes(orderPayload);
  const apiPairs = orderApi?.customAttributes || [];
  const allPairs = [...webhookPairs, ...apiPairs];
  const customer = orderApi?.customer || {};

  const invoiceType =
    getAttrFromPairs(allPairs, INVOICE_TYPE_KEYS) ||
    normalize(invoiceRequest?.invoiceType) ||
    normalize(customer?.invoiceType?.value) ||
    "private";

  const invoiceRequestId =
    getAttrFromPairs(allPairs, INVOICE_REQUEST_ID_KEYS) || normalize(invoiceRequest?.id);

  const firstName =
    normalize(customer?.firstName) ||
    normalize(orderPayload?.customer?.first_name) ||
    normalize(orderApi?.billingAddress?.firstName) ||
    normalize(orderApi?.shippingAddress?.firstName) ||
    normalize(invoiceRequest?.firstName);

  const lastName =
    normalize(customer?.lastName) ||
    normalize(orderPayload?.customer?.last_name) ||
    normalize(orderApi?.billingAddress?.lastName) ||
    normalize(orderApi?.shippingAddress?.lastName) ||
    normalize(invoiceRequest?.lastName);

  const email =
    getAttrFromPairs(allPairs, CUSTOMER_EMAIL_KEYS) ||
    normalize(orderApi?.email) ||
    normalize(customer?.email) ||
    normalize(orderPayload?.email) ||
    normalize(invoiceRequest?.email);

  const fiscalCode =
    getAttrFromPairs(allPairs, FISCAL_CODE_KEYS) ||
    getLocalizationValue(orderApi, FISCAL_CODE_KEYS) ||
    normalize(customer?.fiscalCode?.value) ||
    normalize(invoiceRequest?.fiscalCode);

  const pec =
    getAttrFromPairs(allPairs, PEC_KEYS) ||
    getLocalizationValue(orderApi, PEC_KEYS) ||
    normalize(customer?.pec?.value) ||
    normalize(invoiceRequest?.pec);

  const codiceDestinatario =
    getAttrFromPairs(allPairs, SDI_KEYS) ||
    getLocalizationValue(orderApi, SDI_KEYS) ||
    normalize(customer?.sdi?.value) ||
    normalize(invoiceRequest?.codiceDestinatario);

  const companyName =
    getAttrFromPairs(allPairs, COMPANY_KEYS) ||
    normalize(customer?.companyName?.value) ||
    normalize(orderApi?.billingAddress?.company) ||
    normalize(orderApi?.shippingAddress?.company) ||
    normalize(invoiceRequest?.companyName);

  const vatNumber =
    getAttrFromPairs(allPairs, VAT_KEYS) ||
    normalize(customer?.vatNumber?.value) ||
    normalize(invoiceRequest?.vatNumber);

  const billingCountry =
    getAttrFromPairs(allPairs, COUNTRY_KEYS) ||
    normalize(customer?.invoiceCountryCode?.value) ||
    getAddressCountry(orderApi) ||
    normalize(invoiceRequest?.billingCountry);

  const viesChecked =
    getAttrFromPairs(allPairs, ["vies_checked"]) ||
    normalize(customer?.viesChecked?.value) ||
    booleanToString(invoiceRequest?.viesChecked);

  const viesValid =
    getAttrFromPairs(allPairs, ["vies_valid"]) ||
    normalize(customer?.viesValid?.value) ||
    booleanToString(invoiceRequest?.viesValid);

  const reverseCharge =
    getAttrFromPairs(allPairs, ["reverse_charge"]) ||
    normalize(customer?.reverseCharge?.value) ||
    booleanToString(invoiceRequest?.reverseCharge);

  const taxExemptApplied =
    getAttrFromPairs(allPairs, ["tax_exempt_applied"]) ||
    booleanToString(invoiceRequest?.taxExemptApplied);

  return {
    invoiceType,
    invoiceRequestId,
    firstName,
    lastName,
    email,
    fiscalCode,
    pec,
    codiceDestinatario,
    companyName,
    vatNumber,
    billingCountry,
    viesChecked,
    viesValid,
    reverseCharge,
    taxExemptApplied,
  };
}

export const action = async ({ request }: any) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    console.log(`WEBHOOK ${topic} from ${shop}`);

    const orderPayload = payload;
    const orderGid = getOrderGid(orderPayload);
    const { admin } = await unauthenticated.admin(shop);
    const orderApi = await getOrderApiData(admin, orderGid);

    if (!orderApi) {
      console.error("Order GraphQL read returned null", { orderGid });
      return new Response("OK");
    }

    const webhookPairs = getWebhookAttributes(orderPayload);
    const apiPairs = orderApi?.customAttributes || [];
    const allPairs = [...webhookPairs, ...apiPairs];

    const invoiceRequested = yes(getAttrFromPairs(allPairs, INVOICE_REQUEST_KEYS));
    const invoiceRequestId = getAttrFromPairs(allPairs, INVOICE_REQUEST_ID_KEYS);
    const invoiceRequest = await getInvoiceRequestFromDb(invoiceRequestId);
    const customerGid = getCustomerGid(orderPayload, orderApi);

    let nextNote = normalize(orderApi?.note || orderPayload?.note || "");
    const tags: string[] = [];

    if (invoiceRequested) {
      const invoiceData = buildInvoiceData({ orderPayload, orderApi, invoiceRequest });
      const fiscalNote = buildInvoiceNote(invoiceData);

      nextNote = replaceBlock(nextNote, fiscalNote, INVOICE_START, INVOICE_END);

      if (invoiceData.invoiceRequestId) {
        await db.invoiceRequest.updateMany({
          where: { id: invoiceData.invoiceRequestId },
          data: {
            customerId: customerGid || null,
            orderId: orderGid,
            orderName: orderApi?.name || orderPayload?.name || null,
            email: invoiceData.email || null,
            firstName: invoiceData.firstName || null,
            lastName: invoiceData.lastName || null,
            fiscalCode: invoiceData.fiscalCode || null,
            pec: invoiceData.pec || null,
            codiceDestinatario: invoiceData.codiceDestinatario || null,
            companyName: invoiceData.companyName || null,
            vatNumber: invoiceData.vatNumber || null,
            billingCountry: invoiceData.billingCountry || null,
            status: "completed",
          },
        });
      }

      await setMetafields(admin, orderGid, {
        "invoice.request_id": invoiceData.invoiceRequestId,
        "invoice.invoice_type": invoiceData.invoiceType,
        "invoice.company_name": invoiceData.companyName,
        "invoice.vat_number": invoiceData.vatNumber,
        "invoice.billing_country": invoiceData.billingCountry,
        "invoice.fiscal_code": invoiceData.fiscalCode,
        "invoice.pec": invoiceData.pec,
        "invoice.codice_destinatario": invoiceData.codiceDestinatario,
        "invoice.vies_valid": invoiceData.viesValid,
        "invoice.reverse_charge": invoiceData.reverseCharge,
        "invoice.tax_exempt_applied": invoiceData.taxExemptApplied,
        "invoice.fiscal_note": fiscalNote,
      });

      if (customerGid) {
        await setMetafields(admin, customerGid, {
          "custom.fiscal_code": invoiceData.fiscalCode,
          "custom.pec": invoiceData.pec,
          "custom.sdi": invoiceData.codiceDestinatario,
          "custom.vat_number": invoiceData.vatNumber,
          "custom.invoice_country_code": invoiceData.billingCountry,
          "custom.company_name": invoiceData.companyName,
          "custom.invoice_type": invoiceData.invoiceType,
          "custom.vies_checked": invoiceData.viesChecked,
          "custom.vies_valid": invoiceData.viesValid,
          "custom.reverse_charge": invoiceData.reverseCharge,
        });
      }

      tags.push("invoice_request");
      if (yes(invoiceData.reverseCharge)) tags.push("reverse_charge");
      if (yes(invoiceData.viesValid)) tags.push("vies_valid");
    } else {
      const b2bMeta = getB2BMeta(orderApi);

      if (hasB2BMeta(b2bMeta)) {
        const b2bNote = buildB2BFiscalNote(orderApi, b2bMeta);
        nextNote = replaceBlock(nextNote, b2bNote, B2B_START, B2B_END);

        await setMetafields(admin, orderGid, {
          "b2b.vat_number": b2bMeta.vat_number || "",
          "b2b.billing_country": b2bMeta.billing_country || "",
          "b2b.company_name_submitted": b2bMeta.company_name_submitted || "",
          "b2b.vies_company_name": b2bMeta.vies_company_name || "",
          "b2b.pec": b2bMeta.pec || "",
          "b2b.codice_destinatario": b2bMeta.codice_destinatario || "",
          "b2b.vies_status": b2bMeta.vies_status || "",
          "b2b.vies_match_score": b2bMeta.vies_match_score || "",
          "b2b.fiscal_note": b2bNote,
        });

        tags.push("b2b_customer_order", "b2b_fiscal_data");
      }
    }

    if (nextNote && nextNote !== normalize(orderApi?.note || orderPayload?.note || "")) {
      await updateOrderNote(admin, orderGid, nextNote);
    }

    await addOrderTags(admin, orderGid, tags);

    return new Response("OK");
  } catch (error) {
    console.error("orders/create webhook error:", error);
    return new Response("ERROR", { status: 500 });
  }
};
