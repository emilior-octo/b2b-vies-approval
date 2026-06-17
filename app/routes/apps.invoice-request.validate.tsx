import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";

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

  const payload = await request.json();

  const invoiceRequest = await db.invoiceRequest.create({
    data: {
      shop: "zig-italia-frutta-secca-e-semi.myshopify.com",
      cartToken: payload.cartToken || null,
      invoiceType: payload.invoiceType || "private",
      email: payload.email || null,
      companyName: payload.companyName || null,
      vatNumber: payload.vatNumber || null,
      billingCountry: payload.countryCode || null,
      pec: payload.pec || null,
      codiceDestinatario: payload.sdi || null,
      status: "registered",
    },
  });

  return json({
    ok: true,
    invoiceRequestId: invoiceRequest.id,
    invoiceType: invoiceRequest.invoiceType,
    viesChecked: false,
    viesValid: null,
    reverseCharge: false,
    taxExemptApplied: false,
  });
}