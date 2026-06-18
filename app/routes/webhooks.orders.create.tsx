import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

function getAttr(order: any, key: string) {
  const attrs = order?.note_attributes || order?.noteAttributes || [];
  const found = attrs.find((item: any) => item.name === key || item.key === key);
  return String(found?.value || "").trim();
}

function yes(value: string) {
  return value === "true" || value === "1" || value === "yes";
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
    .filter(([, value]) => String(value || "").trim() !== "")
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
        value: String(value || "").trim(),
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

function buildInvoiceNote(order: any) {
  const invoiceRequested = getAttr(order, "invoice_requested");
  if (!yes(invoiceRequested)) return null;

  const invoiceType = getAttr(order, "invoice_type");
  const invoiceRequestId = getAttr(order, "invoice_request_id");
  const companyName = getAttr(order, "company_name");
  const vatNumber = getAttr(order, "vat_number");
  const country = getAttr(order, "invoice_country_code");
  const pec = getAttr(order, "pec");
  const sdi = getAttr(order, "sdi");
  const customerEmail = getAttr(order, "customer_email");
  const viesChecked = getAttr(order, "vies_checked");
  const viesValid = getAttr(order, "vies_valid");
  const reverseCharge = getAttr(order, "reverse_charge");
  const taxExemptApplied = getAttr(order, "tax_exempt_applied");
  const taxExemptPrepared = getAttr(order, "tax_exempt_customer_prepared");

  return [
    "=== INVOICE REQUEST ===",
    "",
    `Type: ${invoiceType || "-"}`,
    `Company: ${companyName || "-"}`,
    `VAT: ${vatNumber || "-"}`,
    `Country: ${country || "-"}`,
    `PEC: ${pec || "-"}`,
    `SDI: ${sdi || "-"}`,
    `Customer email: ${customerEmail || order.email || "-"}`,
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
  const current = String(existingNote || "").trim();

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

    let nextNote = String(order.note || "").trim();
    const tags = [];

    if (invoiceRequested) {
      const fiscalNote = buildInvoiceNote(order);

      if (invoiceRequestId) {
        await db.invoiceRequest.updateMany({
          where: { id: invoiceRequestId },
          data: {
            orderId: orderGid,
            orderName: order.name || null,
            email: order.email || getAttr(order, "customer_email") || null,
            status: "completed",
          },
        });
      }

      if (fiscalNote) {
        nextNote = appendNote(nextNote, fiscalNote, "=== INVOICE REQUEST ===");
      }

      tags.push("invoice_request");

      if (yes(getAttr(order, "reverse_charge"))) tags.push("reverse_charge");
      if (yes(getAttr(order, "vies_valid"))) tags.push("vies_valid");
      if (getAttr(order, "invoice_request_status") === "pending_review") {
        tags.push("invoice_pending_review");
      }

      await setOrderMetafields(admin, orderGid, {
        "invoice.request_id": invoiceRequestId,
        "invoice.invoice_type": getAttr(order, "invoice_type"),
        "invoice.company_name": getAttr(order, "company_name"),
        "invoice.vat_number": getAttr(order, "vat_number"),
        "invoice.billing_country": getAttr(order, "invoice_country_code"),
        "invoice.pec": getAttr(order, "pec"),
        "invoice.codice_destinatario": getAttr(order, "sdi"),
        "invoice.vies_valid": getAttr(order, "vies_valid"),
        "invoice.reverse_charge": getAttr(order, "reverse_charge"),
        "invoice.tax_exempt_applied": getAttr(order, "tax_exempt_applied"),
        "invoice.fiscal_note": fiscalNote || "",
      });
    }

    const customerGid =
      order.customer?.admin_graphql_api_id ||
      (order.customer?.id ? `gid://shopify/Customer/${order.customer.id}` : "");

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

    if (nextNote && nextNote !== String(order.note || "").trim()) {
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