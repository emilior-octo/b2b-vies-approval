import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const baseWhere = {
    orderId: { not: null },
  };

  const invoiceRequests = await db.invoiceRequest.findMany({
    where: baseWhere,
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const [total, registrate, pending, completed, rejected, reverseCharge] =
    await Promise.all([
      db.invoiceRequest.count({ where: baseWhere }),
      db.invoiceRequest.count({ where: { ...baseWhere, status: "registered" } }),
      db.invoiceRequest.count({ where: { ...baseWhere, status: "pending_review" } }),
      db.invoiceRequest.count({ where: { ...baseWhere, status: "completed" } }),
      db.invoiceRequest.count({ where: { ...baseWhere, status: "rejected" } }),
      db.invoiceRequest.count({ where: { ...baseWhere, reverseCharge: true } }),
    ]);

  return {
    invoiceRequests,
    stats: {
      total,
      registrate,
      pending,
      completed,
      rejected,
      reverseCharge,
    },
  };
}

export async function action({ request }: any) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const id = String(formData.get("id") || "");
  const intent = String(formData.get("intent") || "");

  if (!id) {
    throw new Response("ID richiesta mancante", { status: 400 });
  }

  if (intent === "delete") {
    await db.invoiceRequest.delete({ where: { id } });
    return null;
  }

  const baseData = {
    invoiceType: String(formData.get("invoiceType") || "private"),
    email: emptyToNull(formData.get("email")),
    firstName: emptyToNull(formData.get("firstName")),
    lastName: emptyToNull(formData.get("lastName")),
    companyName: emptyToNull(formData.get("companyName")),
    fiscalCode: emptyToNull(formData.get("fiscalCode")),
    vatNumber: emptyToNull(formData.get("vatNumber")),
    billingCountry: emptyToNull(formData.get("billingCountry")),
    pec: emptyToNull(formData.get("pec")),
    codiceDestinatario: emptyToNull(formData.get("codiceDestinatario")),
    customerId: emptyToNull(formData.get("customerId")),
    orderId: emptyToNull(formData.get("orderId")),
    orderName: emptyToNull(formData.get("orderName")),
    checkoutToken: emptyToNull(formData.get("checkoutToken")),
  };

  if (intent === "save") {
    await db.invoiceRequest.update({
      where: { id },
      data: baseData,
    });
    return null;
  }

  if (["registered", "pending_review", "completed", "rejected"].includes(intent)) {
    await db.invoiceRequest.update({
      where: { id },
      data: {
        ...baseData,
        status: intent,
      },
    });
    return null;
  }

  return null;
}

function emptyToNull(value: FormDataEntryValue | null) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function statusLabel(status: string) {
  if (status === "completed") return "Completata";
  if (status === "rejected") return "Rifiutata";
  if (status === "pending_review") return "Da controllare";
  return "Registrata";
}

function statusColor(status: string) {
  if (status === "completed") return "#dff3df";
  if (status === "rejected") return "#ffe1dc";
  if (status === "pending_review") return "#fff3cd";
  return "#e5f0ff";
}

function invoiceTypeLabel(type: string, country?: string | null) {
  const normalizedCountry = String(country || "").toUpperCase();
  if (type === "company" && normalizedCountry && normalizedCountry !== "IT") {
    return "Azienda estera";
  }
  if (type === "company") return "Azienda Italia";
  return "Privato";
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("it-IT");
}

function isMissing(value: unknown) {
  return String(value || "").trim() === "";
}

function getWarnings(item: any) {
  const warnings: string[] = [];
  const type = String(item.invoiceType || "private");
  const country = String(item.billingCountry || "").toUpperCase();
  const isCompany = type === "company";
  const isForeignCompany = isCompany && country && country !== "IT";
  const isItalianCompany = isCompany && (!country || country === "IT");


  if (!item.email) {
    warnings.push("Email mancante");
  }

  if (type === "private") {
    if (isMissing(item.fiscalCode)) warnings.push("Codice Fiscale mancante");
    if (isMissing(item.pec)) warnings.push("PEC mancante");
  }

  if (isCompany && isMissing(item.companyName)) {
    warnings.push("Ragione sociale mancante");
  }

  if (isCompany && isMissing(item.vatNumber)) {
    warnings.push("Partita IVA/VAT mancante");
  }

  if (isCompany && isMissing(item.billingCountry)) {
    warnings.push("Paese mancante");
  }

  if (isItalianCompany && isMissing(item.pec) && isMissing(item.codiceDestinatario)) {
    warnings.push("Per azienda italiana manca PEC o Codice Destinatario");
  }

  if (isForeignCompany) {
    if (!item.viesChecked) warnings.push("VIES non controllato");
    if (item.viesChecked && item.viesValid !== true) warnings.push("VAT estero non validato");
    if (!item.reverseCharge) warnings.push("Reverse charge non applicato");
  }

  return warnings;
}

function hasWarnings(item: any) {
  return getWarnings(item).length > 0;
}

export default function InvoiceRequestsPage() {
  const { invoiceRequests, stats } = useLoaderData<typeof loader>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return invoiceRequests.filter((item) => {
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;

      const itemType = String(item.invoiceType || "private");
      const country = String(item.billingCountry || "").toUpperCase();
      const isForeign = itemType === "company" && country && country !== "IT";
      const isItalianCompany = itemType === "company" && (!country || country === "IT");

      const matchesType =
        typeFilter === "all" ||
        (typeFilter === "private" && itemType === "private") ||
        (typeFilter === "company_it" && isItalianCompany) ||
        (typeFilter === "company_foreign" && isForeign) ||
        (typeFilter === "incomplete" && hasWarnings(item));

      const haystack = [
        item.email,
        item.companyName,
        item.fiscalCode,
        item.vatNumber,
        item.billingCountry,
        item.orderName,
        item.viesCompanyName,
        item.pec,
        item.codiceDestinatario,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesQuery = !q || haystack.includes(q);

      return matchesStatus && matchesType && matchesQuery;
    });
  }, [invoiceRequests, query, statusFilter, typeFilter]);

  return (
    <div style={page}>
      <section style={hero}>
        <div>
          <div style={eyebrow}>Zig Business Engine</div>
          <h1 style={title}>Richieste fattura</h1>
          <p style={subtitle}>
            Controlla le richieste, correggi i dati fiscali e aggiorna lo stato. Tutto è pensato per uso amministrativo semplice.
          </p>
        </div>
        <div style={heroIcon}>🧾</div>
      </section>

      <section style={statsGrid}>
        <Stat label="Totale" value={stats.total} />
        <Stat label="Registrate" value={stats.registrate} tone="info" />
        <Stat label="Da controllare" value={stats.pending} tone="warning" />
        <Stat label="Completate" value={stats.completed} tone="success" />
        <Stat label="Rifiutate" value={stats.rejected} tone="danger" />
        <Stat label="Reverse charge" value={stats.reverseCharge} tone="success" />
      </section>

      <section style={toolbar}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca email, azienda, VAT, ordine..."
          style={searchInput}
        />

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          style={select}
        >
          <option value="all">Tutti gli stati</option>
          <option value="registered">Registrate</option>
          <option value="pending_review">Da controllare</option>
          <option value="completed">Completate</option>
          <option value="rejected">Rifiutate</option>
        </select>

        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          style={select}
        >
          <option value="all">Tutti i tipi</option>
          <option value="private">Privati</option>
          <option value="company_it">Aziende Italia</option>
          <option value="company_foreign">Aziende estere</option>
          <option value="incomplete">Incomplete</option>
        </select>
      </section>

      <section style={list}>
        {filtered.map((item) => {
          const warnings = getWarnings(item);
          const typeLabel = invoiceTypeLabel(item.invoiceType, item.billingCountry);

          return (
            <article key={item.id} style={requestCard}>
              <div style={summaryGrid}>
                <div>
                  <span style={badge(item.status)}>{statusLabel(item.status)}</span>
                  <span style={typeBadge}>{typeLabel}</span>
                  {warnings.length > 0 && <span style={warningBadge}>Incompleta</span>}
                </div>

                <div>
                  <strong>{item.companyName || item.email || "Richiesta fattura"}</strong>
                  <div style={muted}>{item.invoiceType === "private" ? `CF: ${item.fiscalCode || "mancante"}` : item.vatNumber || "Nessuna VAT"}</div>
                </div>

                <div>
                  <strong>{item.email || "Email mancante"}</strong>
                  <div style={muted}>{item.billingCountry || "Paese non indicato"}</div>
                </div>

                <div>
                  <strong>{item.orderName || "Ordine non collegato"}</strong>
                  <div style={muted}>{formatDate(item.createdAt)}</div>
                </div>

                <div>
                  <strong>{item.reverseCharge ? "Reverse charge ✅" : "Reverse charge —"}</strong>
                  <div style={muted}>Tax exempt {item.taxExemptApplied ? "✅" : "—"}</div>
                </div>

                <button
                  type="button"
                  style={buttonDark}
                  onClick={() => setOpenId(openId === item.id ? null : item.id)}
                >
                  {openId === item.id ? "Chiudi" : "Apri"}
                </button>
              </div>

              {warnings.length > 0 && (
                <div style={warningBox}>
                  <strong>Da controllare:</strong> {warnings.join(" · ")}
                </div>
              )}

              {openId === item.id && (
                <div style={detailBox}>
                  <Form method="post">
                    <input type="hidden" name="id" value={item.id} />

                    <div style={detailGrid}>
                      <section style={card}>
                        <h2>Cliente</h2>

                        <Field label="Email">
                          <input name="email" defaultValue={item.email || ""} style={input} />
                        </Field>

                        <Field label="Nome">
                          <input name="firstName" defaultValue={item.firstName || ""} style={input} />
                        </Field>

                        <Field label="Cognome">
                          <input name="lastName" defaultValue={item.lastName || ""} style={input} />
                        </Field>

                        <Field label="Customer ID">
                          <input name="customerId" defaultValue={item.customerId || ""} style={input} />
                        </Field>
                      </section>

                      <section style={card}>
                        <h2>Dati fattura</h2>

                        <Field label="Tipo richiesta">
                          <select name="invoiceType" defaultValue={item.invoiceType || "private"} style={input}>
                            <option value="private">Privato</option>
                            <option value="company">Azienda</option>
                          </select>
                        </Field>

                        <Field label="Ragione sociale">
                          <input name="companyName" defaultValue={item.companyName || ""} style={input} />
                        </Field>

                        <Field label="Codice Fiscale">
                          <input name="fiscalCode" defaultValue={item.fiscalCode || ""} style={input} />
                        </Field>

                        <Field label="Partita IVA / VAT">
                          <input name="vatNumber" defaultValue={item.vatNumber || ""} style={input} />
                        </Field>

                        <Field label="Paese">
                          <input name="billingCountry" defaultValue={item.billingCountry || ""} style={input} />
                        </Field>

                        <Field label="PEC">
                          <input name="pec" defaultValue={item.pec || ""} style={input} />
                        </Field>

                        <Field label="Codice destinatario / SDI">
                          <input
                            name="codiceDestinatario"
                            defaultValue={item.codiceDestinatario || ""}
                            style={input}
                          />
                        </Field>
                      </section>

                      <section style={card}>
                        <h2>Controlli fiscali</h2>

                        <Read label="VIES controllato" value={item.viesChecked ? "Sì" : "No"} />
                        <Read label="VIES valido" value={item.viesValid ? "✅ Valido" : "—"} />
                        <Read label="Azienda VIES" value={item.viesCompanyName || "-"} />

                        <div style={{ marginTop: 12 }}>
                          <strong>Indirizzo VIES</strong>
                          <pre style={pre}>{item.viesAddress || "-"}</pre>
                        </div>

                        <Read label="Reverse charge" value={item.reverseCharge ? "✅ Sì" : "—"} />
                        <Read label="Tax exempt" value={item.taxExemptApplied ? "✅ Sì" : "—"} />
                      </section>

                      <section style={card}>
                        <h2>Ordine</h2>

                        <Field label="Order ID">
                          <input name="orderId" defaultValue={item.orderId || ""} style={input} />
                        </Field>

                        <Field label="Nome ordine">
                          <input name="orderName" defaultValue={item.orderName || ""} style={input} />
                        </Field>

                        <Field label="Checkout token">
                          <input name="checkoutToken" defaultValue={item.checkoutToken || ""} style={input} />
                        </Field>

                        <Read label="Cart token" value={item.cartToken || "-"} />
                        <Read label="Creata il" value={formatDate(item.createdAt)} />
                        <Read label="Aggiornata il" value={formatDate(item.updatedAt)} />
                      </section>
                    </div>

                    <section style={{ ...card, marginTop: 16 }}>
                      <h2>Azioni</h2>

                      <div style={statusActions}>
                        <button name="intent" value="save" style={buttonGrey}>
                          Salva modifiche
                        </button>

                        <button name="intent" value="registered" style={buttonBlue}>
                          Registrata
                        </button>

                        <button name="intent" value="pending_review" style={buttonYellow}>
                          Da controllare
                        </button>

                        <button name="intent" value="completed" style={buttonGreen}>
                          Completata
                        </button>

                        <button name="intent" value="rejected" style={buttonRed}>
                          Rifiutata
                        </button>

                        <button
                          name="intent"
                          value="delete"
                          style={buttonDangerOutline}
                          onClick={(event) => {
                            if (!window.confirm("Vuoi eliminare definitivamente questa richiesta?")) {
                              event.preventDefault();
                            }
                          }}
                        >
                          Cancella riga
                        </button>
                      </div>
                    </section>
                  </Form>
                </div>
              )}
            </article>
          );
        })}

        {!filtered.length && <div style={emptyState}>Nessuna richiesta fattura trovata.</div>}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "danger" | "info";
}) {
  const color =
    tone === "success"
      ? "#7f9954"
      : tone === "warning"
        ? "#d99a2b"
        : tone === "danger"
          ? "#a13a24"
          : tone === "info"
            ? "#2f6fed"
            : "#394122";

  return (
    <div style={statCard}>
      <div style={{ ...statValue, color }}>{value}</div>
      <div style={statLabel}>{label}</div>
    </div>
  );
}

function Field({ label, children }: any) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <strong style={{ display: "block", marginBottom: 5 }}>{label}</strong>
      {children}
    </label>
  );
}

function Read({ label, value }: any) {
  return (
    <div style={{ marginBottom: 12 }}>
      <strong style={{ display: "block", marginBottom: 5 }}>{label}</strong>
      <div>{value}</div>
    </div>
  );
}

const page: CSSProperties = {
  padding: 24,
  background: "#f5f1df",
  minHeight: "100vh",
  color: "#394122",
};

const hero: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 24,
  alignItems: "center",
  background: "linear-gradient(135deg, #aec58b 0%, #f5f1df 66%, #ffd44d 100%)",
  borderRadius: 34,
  padding: 34,
  boxShadow: "0 18px 45px rgba(57,65,34,.12)",
};

const eyebrow: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: ".08em",
  fontSize: 13,
  fontWeight: 900,
  color: "#6f873d",
  marginBottom: 10,
};

const title: CSSProperties = {
  margin: 0,
  fontSize: "clamp(38px, 5vw, 64px)",
  lineHeight: ".95",
  fontWeight: 950,
};

const subtitle: CSSProperties = {
  maxWidth: 760,
  fontSize: 17,
  lineHeight: 1.45,
  marginTop: 16,
};

const heroIcon: CSSProperties = {
  fontSize: 72,
  background: "rgba(248,243,223,.78)",
  width: 140,
  height: 140,
  borderRadius: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const statsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 1fr)",
  gap: 12,
  marginTop: 20,
};

const statCard: CSSProperties = {
  background: "white",
  borderRadius: 22,
  padding: 18,
  boxShadow: "0 12px 30px rgba(57,65,34,.08)",
};

const statValue: CSSProperties = {
  fontSize: 32,
  fontWeight: 950,
  lineHeight: 1,
};

const statLabel: CSSProperties = {
  marginTop: 8,
  fontWeight: 800,
  color: "rgba(57,65,34,.72)",
};

const toolbar: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 210px 210px",
  gap: 12,
  marginTop: 20,
};

const searchInput: CSSProperties = {
  minHeight: 48,
  border: "1px solid rgba(57,65,34,.18)",
  borderRadius: 999,
  padding: "0 18px",
  fontSize: 15,
  background: "white",
};

const select: CSSProperties = {
  ...searchInput,
};

const list: CSSProperties = {
  display: "grid",
  gap: 12,
  marginTop: 18,
};

const requestCard: CSSProperties = {
  background: "white",
  borderRadius: 24,
  boxShadow: "0 12px 30px rgba(57,65,34,.08)",
  overflow: "hidden",
};

const summaryGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "210px 1.15fr 1.15fr 1fr 1fr auto",
  gap: 14,
  alignItems: "center",
  padding: 18,
};

function badge(status: string): CSSProperties {
  return {
    display: "inline-flex",
    background: statusColor(status),
    borderRadius: 999,
    padding: "7px 11px",
    fontWeight: 900,
    fontSize: 13,
    marginRight: 6,
    marginBottom: 6,
  };
}

const typeBadge: CSSProperties = {
  display: "inline-flex",
  background: "rgba(57,65,34,.08)",
  borderRadius: 999,
  padding: "7px 11px",
  fontWeight: 900,
  fontSize: 13,
  marginRight: 6,
  marginBottom: 6,
};

const warningBadge: CSSProperties = {
  display: "inline-flex",
  background: "#fff3cd",
  color: "#5f3b00",
  borderRadius: 999,
  padding: "7px 11px",
  fontWeight: 900,
  fontSize: 13,
  marginBottom: 6,
};

const warningBox: CSSProperties = {
  margin: "0 18px 16px",
  padding: "12px 14px",
  background: "#fff8df",
  border: "1px solid #f3d27a",
  borderRadius: 16,
  color: "#5f3b00",
  fontSize: 14,
};

const muted: CSSProperties = {
  color: "rgba(57,65,34,.64)",
  fontSize: 13,
  marginTop: 4,
};

const detailBox: CSSProperties = {
  padding: 18,
  background: "#f7f2df",
  borderTop: "1px solid #efe4bd",
};

const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 14,
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #efe4bd",
  borderRadius: 18,
  padding: 16,
};

const input: CSSProperties = {
  width: "100%",
  minHeight: 42,
  border: "1px solid #ddd",
  borderRadius: 999,
  padding: "0 14px",
  background: "white",
};

const pre: CSSProperties = {
  whiteSpace: "pre-wrap",
  background: "#f7f7f7",
  padding: 12,
  borderRadius: 12,
};

const statusActions: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 1fr)",
  gap: 10,
};

const buttonBase: CSSProperties = {
  minHeight: 42,
  border: 0,
  borderRadius: 999,
  fontWeight: 900,
  cursor: "pointer",
};

const buttonDark: CSSProperties = {
  ...buttonBase,
  background: "#303a21",
  color: "white",
  padding: "0 16px",
};

const buttonGrey: CSSProperties = {
  ...buttonBase,
  background: "#ddd",
  color: "#222",
};

const buttonBlue: CSSProperties = {
  ...buttonBase,
  background: "#2f6fed",
  color: "white",
};

const buttonGreen: CSSProperties = {
  ...buttonBase,
  background: "#1f7a35",
  color: "white",
};

const buttonYellow: CSSProperties = {
  ...buttonBase,
  background: "#c9902f",
  color: "white",
};

const buttonRed: CSSProperties = {
  ...buttonBase,
  background: "#9f2f1f",
  color: "white",
};

const buttonDangerOutline: CSSProperties = {
  ...buttonBase,
  background: "white",
  color: "#9f2f1f",
  border: "1px solid #9f2f1f",
};

const emptyState: CSSProperties = {
  background: "white",
  borderRadius: 24,
  padding: 28,
  textAlign: "center",
  color: "rgba(57,65,34,.7)",
};
