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

export const action = async ({ request }: any) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log(`WEBHOOK ${topic} from ${shop}`);

    const order = payload;
    const invoiceRequested = yes(getAttr(order, "invoice_requested"));

    if (!invoiceRequested) {
      return new Response("OK");
    }

    const orderGid =
      order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`;

    const invoiceRequestId = getAttr(order, "invoice_request_id");
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

    const { admin } = await unauthenticated.admin(shop);

    if (fiscalNote) {
      const existingNote = String(order.note || "").trim();
      const nextNote = existingNote.includes("=== INVOICE REQUEST ===")
        ? existingNote
        : [existingNote, fiscalNote].filter(Boolean).join("\n\n");

      await updateOrderNote(admin, orderGid, nextNote);
    }

    const tags = ["invoice_request"];

    if (yes(getAttr(order, "reverse_charge"))) tags.push("reverse_charge");
    if (yes(getAttr(order, "vies_valid"))) tags.push("vies_valid");
    if (getAttr(order, "invoice_request_status") === "pending_review") {
      tags.push("invoice_pending_review");
    }

    await addOrderTags(admin, orderGid, tags);

    return new Response("OK");
  } catch (error) {
    console.error("orders/create webhook error:", error);
    return new Response("ERROR", { status: 500 });
  }
};