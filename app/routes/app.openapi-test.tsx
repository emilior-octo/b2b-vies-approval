import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.admin(request);
  const data = await request.formData();
  const vat = String(data.get("vat") || "").replace(/^IT/i, "").trim();
  const sandbox = data.get("environment") !== "production";
  if (!/^\d{11}$/.test(vat)) return { error: "Inserisci 11 cifre di partita IVA." };
  const token = process.env.OPENAPI_COMPANY_TOKEN;
  if (!token) return { error: "OPENAPI_COMPANY_TOKEN non configurato su Render." };
  const host = sandbox ? "test.company.openapi.com" : "company.openapi.com";
  const results = [];
  for (const endpoint of ["IT-start"]) {
    try {
      const response = await fetch("https://" + host + "/" + endpoint + "/" + encodeURIComponent(vat), {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      const body = await response.json();
      const record = Array.isArray(body?.data) ? body.data[0] : body?.data;
      results.push({
        endpoint, status: response.status, success: body?.success === true,
        dataKind: Array.isArray(body?.data) ? "array" : typeof body?.data,
        fields: record && typeof record === "object" ? Object.keys(record) : [],
        hasName: Boolean(record?.companyName || record?.name || record?.companyDetails?.companyName),
        closed: record?.taxCodeCeased ?? record?.cessata ?? "unknown",
        activityStatus: record?.activityStatus ?? record?.companyStatus?.activityStatus?.code ?? "unknown",
        message: response.ok ? "" : String(body?.message || "Provider error").slice(0,150),
      });
    } catch (err: any) {
      results.push({ endpoint, error: err?.message || "Errore sconosciuto" });
    }
  }
  return { sandbox, results };
}

export default function OpenapiDiagnostics() {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [environment, setEnvironment] = useState("sandbox");
  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <h1>Openapi Company – diagnostica sicura</h1>
      <p>Test mirato IT-start: solo lettura, nessuna modifica a clienti Shopify. Una chiamata in produzione può consumare credito.</p>
      <Form method="post">
        <p><label>Partita IVA italiana <input name="vat" required pattern="[0-9]{11}" placeholder="11 cifre" /></label></p>
        <p><label>Ambiente <select name="environment" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="sandbox">Sandbox gratuita</option><option value="production">Produzione (a consumo)</option></select></label></p>
        <button type="submit" disabled={navigation.state !== "idle"}>{navigation.state !== "idle" ? "Verifica..." : "Test API"}</button>
      </Form>
      {result && <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-word",padding:16,background:"#f5f5f5",color:"#111",borderRadius:8}}>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
