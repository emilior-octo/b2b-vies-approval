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
  const submittedName = String(data.get("companyName") || "").trim();
  if (!/^\d{11}$/.test(vat)) return { error: "Inserisci 11 cifre di partita IVA." };
  const token = process.env.OPENAPI_COMPANY_TOKEN;
  if (!token) return { error: "OPENAPI_COMPANY_TOKEN non configurato su Render." };
  const host = sandbox ? "test.company.openapi.com" : "company.openapi.com";
  const results = [];
  const normalize = (name: string) => {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(s\.r\.l\.|srl|spa|s\.p\.a\.|snc|s\.n\.c\.|sas|s\.a\.s\.|sapa|s\.a\.p\.a\.|societa|soc|benefit|unipersonale|unip|italia|italy)\b/g,
      "",
    )
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  };
  const similarity = (a: string, b: string) => {
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b) || b.includes(a)) return 95;
    const compact = (x: string) => x.replace(/\s+/g, "");
    const lev = (x: string, y: string) => {
      const previous = Array.from({ length: y.length + 1 }, (_, i) => i);
      for (let i = 1; i <= x.length; i++) {
        let last = previous[0]; previous[0] = i;
        for (let j = 1; j <= y.length; j++) {
          const current = previous[j];
          previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, last + (x[i - 1] === y[j - 1] ? 0 : 1));
          last = current;
        }
      }
      return previous[y.length];
    };
    const x = compact(a), y = compact(b);
    const characterScore = Math.round((1 - lev(x, y) / Math.max(x.length, y.length)) * 100);
    const aa = new Set(a.split(" ").filter(Boolean)), bb = new Set(b.split(" ").filter(Boolean));
    const wordScore = Math.round(([...aa].filter(word => bb.has(word)).length / Math.max(aa.size, bb.size)) * 100);
    return Math.max(characterScore, wordScore);
  };
  for (const endpoint of ["IT-start"]) {
    try {
      const response = await fetch("https://" + host + "/" + endpoint + "/" + encodeURIComponent(vat), {
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      const body = await response.json();
      const record = Array.isArray(body?.data) ? body.data[0] : body?.data;
      const officialName = String(record?.companyName || record?.name || record?.companyDetails?.companyName || "").trim();
      const score = submittedName && officialName ? similarity(normalize(submittedName), normalize(officialName)) : null;
      const vatMatches = String(record?.vatCode || "").replace(/^IT/i, "") === vat;
      const active = String(record?.activityStatus || "").toUpperCase() === "ATTIVA";
      results.push({
        decisionPreview: response.ok && body?.success === true && vatMatches && active && score !== null && score >= 70 ? "approved" : "pending_review",
        matchScore: score,
        endpoint, status: response.status, success: body?.success === true,
        dataKind: Array.isArray(body?.data) ? "array" : typeof body?.data,
        fields: record && typeof record === "object" ? Object.keys(record) : [],
        hasName: Boolean(record?.companyName || record?.name || record?.companyDetails?.companyName),
        companyName: String(record?.companyName || record?.name || record?.companyDetails?.companyName || ""),
        vatMatches,
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
      <p>Simulazione nazionale IT-start e confronto del nome: nessuna modifica a clienti Shopify. La decisione è una previsione del ramo nazionale, non un test della sincronizzazione Shopify. Una chiamata in produzione può consumare credito.</p>
      <Form method="post">
        <p><label>Partita IVA italiana <input name="vat" required pattern="[0-9]{11}" placeholder="11 cifre" /></label></p>
        <p><label>Denominazione inserita dal cliente <input name="companyName" required placeholder="Ragione sociale del form B2B" style={{ minWidth: 340 }} /></label></p>
        <p><label>Ambiente <select name="environment" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="sandbox">Sandbox gratuita</option><option value="production">Produzione (a consumo)</option></select></label></p>
        <button type="submit" disabled={navigation.state !== "idle"}>{navigation.state !== "idle" ? "Verifica..." : "Test API"}</button>
      </Form>
      {result && <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-word",padding:16,background:"#f5f5f5",color:"#111",borderRadius:8}}>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
