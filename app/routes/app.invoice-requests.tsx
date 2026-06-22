import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type InvoiceStatus = "registered" | "completed" | "rejected" | "pending_review";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const baseWhere = {
    orderId: { not: null },
  };

  const invoiceRequests = await db.invoiceRequest.findMany({
    where: baseWhere,
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  const [total, inviate, completate, rifiutate, reverseCharge] = await Promise.all([
    db.invoiceRequest.count({ where: baseWhere }),
    db.invoiceRequest.count({
      where: {
        ...baseWhere,
        OR: [{ status: "registered" }, { status: "pending_review" }],
      },
    }),
    db.invoiceRequest.count({ where: { ...baseWhere, status: "completed" } }),
    db.invoiceRequest.count({ where: { ...baseWhere, status: "rejected" } }),
    db.invoiceRequest.count({ where: { ...baseWhere, reverseCharge: true } }),
  ]);

  return {
    invoiceRequests,
    stats: {
      total,
      inviate,
      completate,
      rifiutate,
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

  if (["registered", "completed", "rejected"].includes(intent)) {
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

function formatDate(value: string | Date) {
  return new Date(value).toLocaleString("it-IT");
}

function normalizeStatus(status: string): "registered" | "completed" | "rejected" {
  if (status === "completed") return "completed";
  if (status === "rejected") return "rejected";
  return "registered";
}

function statusLabel(status: string) {
  const normalized = normalizeStatus(status);
  if (normalized === "completed") return "Completata";
  if (normalized === "rejected") return "Rifiutata";
  return "Inviata";
}

function statusTone(status: string): "success" | "danger" | "warning" {
  const normalized = normalizeStatus(status);
  if (normalized === "completed") return "success";
  if (normalized === "rejected") return "danger";
  return "warning";
}

function requestType(item: any) {
  if (item.invoiceType !== "company") {
    return {
      label: "Privato",
      icon: "👤",
      tone: "neutral" as const,
      description: "Fattura privata",
    };
  }

  const country = String(item.billingCountry || "").toUpperCase();

  if (country === "IT") {
    return {
      label: "Azienda IT",
      icon: "🏢",
      tone: "info" as const,
      description: "Azienda italiana",
    };
  }

  if (item.reverseCharge) {
    return {
      label: "Azienda UE",
      icon: "🌍",
      tone: "success" as const,
      description: "Reverse charge",
    };
  }

  return {
    label: "Azienda estera",
    icon: "🌍",
    tone: "warning" as const,
    description: "Da verificare",
  };
}

function missingFields(item: any) {
  const missing: string[] = [];

  if (item.invoiceType === "private") {
    if (!item.fiscalCode) missing.push("Codice Fiscale");
    if (!item.pec) missing.push("PEC");
    return missing;
  }

  if (!item.companyName) missing.push("Ragione sociale");
  if (!item.vatNumber) missing.push("Partita IVA / VAT");
  if (!item.billingCountry) missing.push("Paese");

  const country = String(item.billingCountry || "").toUpperCase();

  if (country === "IT") {
    if (!item.pec) missing.push("PEC");
    if (!item.codiceDestinatario) missing.push("SDI");
  }

  if (country && country !== "IT" && item.viesValid !== true) {
    missing.push("VIES non valido/da controllare");
  }

  return missing;
}

function mainTitle(item: any) {
  if (item.invoiceType === "company") {
    return item.companyName || item.viesCompanyName || item.email || "Richiesta azienda";
  }

  const fullName = [item.firstName, item.lastName].filter(Boolean).join(" ");
  return fullName || item.email || "Richiesta privato";
}

function subtitle(item: any) {
  if (item.invoiceType === "company") {
    return item.vatNumber || item.email || "Nessuna VAT";
  }

  return item.fiscalCode ? `CF: ${item.fiscalCode}` : "CF: mancante";
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "success" | "danger" | "warning" | "info" | "neutral";
}) {
  return <span className={`zi-badge zi-badge-${tone}`}>{children}</span>;
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
      const normalizedStatus = normalizeStatus(item.status);
      const matchesStatus =
        statusFilter === "all" || normalizedStatus === statusFilter;

      const type = requestType(item).label;
      const matchesType =
        typeFilter === "all" ||
        (typeFilter === "private" && item.invoiceType === "private") ||
        (typeFilter === "company_it" && type === "Azienda IT") ||
        (typeFilter === "company_foreign" && item.invoiceType === "company" && type !== "Azienda IT");

      const haystack = [
        item.email,
        item.firstName,
        item.lastName,
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
    <div className="zi-page">
      <Style />

      <section className="zi-hero">
        <div>
          <div className="zi-eyebrow">Zig Business Engine</div>
          <h1>Richieste fattura</h1>
          <p>
            Elenco delle richieste collegate a ordini completati. Lo stato indica
            solo la lavorazione della richiesta; eventuali dati mancanti sono
            segnalati separatamente.
          </p>
        </div>
        <div className="zi-hero-icon">🧾</div>
      </section>

      <section className="zi-stats">
        <Stat label="Totale" value={stats.total} />
        <Stat label="Inviate" value={stats.inviate} tone="warning" />
        <Stat label="Completate" value={stats.completate} tone="success" />
        <Stat label="Rifiutate" value={stats.rifiutate} tone="danger" />
        <Stat label="Reverse charge" value={stats.reverseCharge} tone="info" />
      </section>

      <section className="zi-toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca email, nome, azienda, VAT, CF, ordine..."
        />

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="all">Tutti gli stati</option>
          <option value="registered">Inviata</option>
          <option value="completed">Completata</option>
          <option value="rejected">Rifiutata</option>
        </select>

        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="all">Tutti i tipi</option>
          <option value="private">Privati</option>
          <option value="company_it">Aziende IT</option>
          <option value="company_foreign">Aziende estere</option>
        </select>
      </section>

      <section className="zi-list">
        {filtered.map((item) => {
          const type = requestType(item);
          const missing = missingFields(item);
          const isOpen = openId === item.id;

          return (
            <article key={item.id} className="zi-request-card">
              <div className="zi-summary">
                <div className="zi-summary-badges">
                  <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
                  <Badge tone={type.tone}>
                    {type.icon} {type.label}
                  </Badge>
                </div>

                <div className="zi-summary-main">
                  <strong>{mainTitle(item)}</strong>
                  <span>{subtitle(item)}</span>
                </div>

                <div className="zi-summary-contact">
                  <strong>{item.email || "Email mancante"}</strong>
                  <span>{item.billingCountry ? `Paese ${item.billingCountry}` : "Paese non indicato"}</span>
                </div>

                <div className="zi-summary-order">
                  <strong>{item.orderName || "Ordine non collegato"}</strong>
                  <span>{formatDate(item.createdAt)}</span>
                </div>

                <div className="zi-summary-tax">
                  <strong>{item.reverseCharge ? "Reverse charge sì" : "Reverse charge —"}</strong>
                  <span>{item.taxExemptApplied ? "Tax exempt sì" : "Tax exempt —"}</span>
                </div>

                <button
                  type="button"
                  className="zi-open"
                  onClick={() => setOpenId(isOpen ? null : item.id)}
                >
                  {isOpen ? "Chiudi" : "Apri"}
                </button>
              </div>

              {missing.length > 0 ? (
                <div className="zi-warning">
                  <strong>Da controllare:</strong> {missing.join(" · ")}
                </div>
              ) : (
                <div className="zi-complete">
                  <strong>Dati completi</strong>
                </div>
              )}

              {isOpen && (
                <div className="zi-detail">
                  <Form method="post">
                    <input type="hidden" name="id" value={item.id} />

                    <div className="zi-detail-grid">
                      <section className="zi-panel">
                        <h2>Cliente</h2>

                        <Field label="Email">
                          <input name="email" defaultValue={item.email || ""} />
                        </Field>

                        <Field label="Nome">
                          <input name="firstName" defaultValue={item.firstName || ""} />
                        </Field>

                        <Field label="Cognome">
                          <input name="lastName" defaultValue={item.lastName || ""} />
                        </Field>

                        <Field label="Customer ID">
                          <input name="customerId" defaultValue={item.customerId || ""} />
                        </Field>
                      </section>

                      <section className="zi-panel">
                        <h2>Dati fattura</h2>

                        <Field label="Tipo richiesta">
                          <select name="invoiceType" defaultValue={item.invoiceType || "private"}>
                            <option value="private">Privato</option>
                            <option value="company">Azienda</option>
                          </select>
                        </Field>

                        <Field label="Codice Fiscale">
                          <input name="fiscalCode" defaultValue={item.fiscalCode || ""} />
                        </Field>

                        <Field label="Ragione sociale">
                          <input name="companyName" defaultValue={item.companyName || ""} />
                        </Field>

                        <Field label="Partita IVA / VAT">
                          <input name="vatNumber" defaultValue={item.vatNumber || ""} />
                        </Field>

                        <Field label="Paese">
                          <input name="billingCountry" defaultValue={item.billingCountry || ""} />
                        </Field>

                        <Field label="PEC">
                          <input name="pec" defaultValue={item.pec || ""} />
                        </Field>

                        <Field label="Codice destinatario / SDI">
                          <input
                            name="codiceDestinatario"
                            defaultValue={item.codiceDestinatario || ""}
                          />
                        </Field>
                      </section>

                      <section className="zi-panel">
                        <h2>Controlli fiscali</h2>

                        <Read label="VIES controllato" value={item.viesChecked ? "Sì" : "No"} />
                        <Read label="VIES valido" value={item.viesValid ? "Sì" : "—"} />
                        <Read label="Azienda VIES" value={item.viesCompanyName || "—"} />
                        <Read label="Indirizzo VIES" value={item.viesAddress || "—"} multiline />
                        <Read label="Reverse charge" value={item.reverseCharge ? "Sì" : "—"} />
                        <Read label="Tax exempt" value={item.taxExemptApplied ? "Sì" : "—"} />
                      </section>

                      <section className="zi-panel">
                        <h2>Ordine</h2>

                        <Field label="Order ID">
                          <input name="orderId" defaultValue={item.orderId || ""} />
                        </Field>

                        <Field label="Nome ordine">
                          <input name="orderName" defaultValue={item.orderName || ""} />
                        </Field>

                        <Field label="Checkout token">
                          <input name="checkoutToken" defaultValue={item.checkoutToken || ""} />
                        </Field>

                        <Read label="Cart token" value={item.cartToken || "—"} />
                        <Read label="Creata il" value={formatDate(item.createdAt)} />
                        <Read label="Aggiornata il" value={formatDate(item.updatedAt)} />
                      </section>
                    </div>

                    <section className="zi-actions">
                      <div>
                        <h2>Azioni</h2>
                        <p>
                          Usa lo stato solo per la lavorazione interna. I dati
                          mancanti restano visibili sopra alla richiesta.
                        </p>
                      </div>

                      <div className="zi-action-buttons">
                        <button name="intent" value="save" className="zi-button zi-button-grey">
                          Salva modifiche
                        </button>

                        <button name="intent" value="registered" className="zi-button zi-button-yellow">
                          Segna inviata
                        </button>

                        <button name="intent" value="completed" className="zi-button zi-button-green">
                          Segna completata
                        </button>

                        <button name="intent" value="rejected" className="zi-button zi-button-red">
                          Rifiuta
                        </button>

                        <button
                          name="intent"
                          value="delete"
                          className="zi-button zi-button-dark"
                          onClick={(event) => {
                            if (!confirm("Eliminare definitivamente questa richiesta?")) {
                              event.preventDefault();
                            }
                          }}
                        >
                          Elimina
                        </button>
                      </div>
                    </section>
                  </Form>
                </div>
              )}
            </article>
          );
        })}

        {!filtered.length && (
          <div className="zi-empty">Nessuna richiesta fattura trovata.</div>
        )}
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
  return (
    <div className={`zi-stat ${tone ? `zi-stat-${tone}` : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Field({ label, children }: any) {
  return (
    <label className="zi-field">
      <strong>{label}</strong>
      {children}
    </label>
  );
}

function Read({ label, value, multiline }: any) {
  return (
    <div className="zi-read">
      <strong>{label}</strong>
      <span className={multiline ? "zi-read-multiline" : ""}>{value}</span>
    </div>
  );
}

function Style() {
  return (
    <style>{`
      .zi-page {
        padding: 24px;
        background: #f5f1df;
        min-height: 100vh;
        color: #30391f;
        overflow-x: hidden;
      }

      .zi-hero {
        display: flex;
        justify-content: space-between;
        gap: 24px;
        align-items: center;
        background: linear-gradient(135deg, #aec58b 0%, #f5f1df 66%, #ffd44d 100%);
        border-radius: 34px;
        padding: 34px;
        box-shadow: 0 18px 45px rgba(57,65,34,.12);
      }

      .zi-eyebrow {
        text-transform: uppercase;
        letter-spacing: .08em;
        font-size: 13px;
        font-weight: 900;
        color: #6f873d;
        margin-bottom: 10px;
      }

      .zi-hero h1 {
        margin: 0;
        font-size: clamp(38px, 5vw, 70px);
        line-height: .92;
        font-weight: 950;
      }

      .zi-hero p {
        max-width: 760px;
        font-size: 18px;
        line-height: 1.45;
        margin: 18px 0 0;
      }

      .zi-hero-icon {
        font-size: 72px;
        background: rgba(248,243,223,.78);
        width: 150px;
        height: 150px;
        border-radius: 34px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }

      .zi-stats {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 12px;
        margin-top: 20px;
      }

      .zi-stat {
        background: white;
        border-radius: 22px;
        padding: 18px;
        box-shadow: 0 12px 30px rgba(57,65,34,.08);
      }

      .zi-stat strong {
        display: block;
        font-size: 34px;
        line-height: 1;
        font-weight: 950;
        color: #394122;
      }

      .zi-stat span {
        display: block;
        margin-top: 8px;
        font-weight: 900;
        color: rgba(57,65,34,.72);
      }

      .zi-stat-success strong { color: #1f7a35; }
      .zi-stat-warning strong { color: #b87916; }
      .zi-stat-danger strong { color: #a13a24; }
      .zi-stat-info strong { color: #2f6fed; }

      .zi-toolbar {
        display: grid;
        grid-template-columns: 1fr 190px 210px;
        gap: 12px;
        margin-top: 20px;
      }

      .zi-toolbar input,
      .zi-toolbar select,
      .zi-field input,
      .zi-field select {
        width: 100%;
        min-height: 46px;
        border: 1px solid rgba(57,65,34,.16);
        border-radius: 999px;
        padding: 0 18px;
        font-size: 15px;
        background: white;
        box-sizing: border-box;
      }

      .zi-list {
        display: grid;
        gap: 14px;
        margin-top: 18px;
      }

      .zi-request-card {
        background: white;
        border-radius: 28px;
        box-shadow: 0 12px 30px rgba(57,65,34,.08);
        overflow: hidden;
      }

      .zi-summary {
        display: grid;
        grid-template-columns: 170px 1.2fr 1.1fr .9fr .95fr auto;
        gap: 14px;
        align-items: center;
        padding: 20px;
      }

      .zi-summary-badges {
        display: flex;
        gap: 7px;
        flex-wrap: wrap;
      }

      .zi-summary-main strong,
      .zi-summary-contact strong,
      .zi-summary-order strong,
      .zi-summary-tax strong {
        display: block;
        font-size: 16px;
        overflow-wrap: anywhere;
      }

      .zi-summary-main span,
      .zi-summary-contact span,
      .zi-summary-order span,
      .zi-summary-tax span {
        display: block;
        color: rgba(57,65,34,.62);
        margin-top: 4px;
        font-size: 13px;
        overflow-wrap: anywhere;
      }

      .zi-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 7px 12px;
        font-weight: 950;
        font-size: 13px;
        white-space: nowrap;
      }

      .zi-badge-success { background: #dff3df; color: #1e5d2a; }
      .zi-badge-danger { background: #ffe1dc; color: #812511; }
      .zi-badge-warning { background: #fff0bd; color: #6b4708; }
      .zi-badge-info { background: #e5f0ff; color: #184a9c; }
      .zi-badge-neutral { background: #eeeeea; color: #394122; }

      .zi-open {
        min-height: 44px;
        border: 0;
        border-radius: 999px;
        background: #303a21;
        color: white;
        padding: 0 18px;
        font-weight: 950;
        cursor: pointer;
      }

      .zi-warning,
      .zi-complete {
        margin: 0 20px 20px;
        border-radius: 18px;
        padding: 13px 16px;
        line-height: 1.35;
      }

      .zi-warning {
        background: #fff7dc;
        border: 1px solid #f3c24e;
        color: #5b3b05;
      }

      .zi-complete {
        background: #edf8ea;
        border: 1px solid #b8dfae;
        color: #245c27;
      }

      .zi-detail {
        padding: 20px;
        background: #f7f2df;
        border-top: 1px solid #efe4bd;
      }

      .zi-detail-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }

      .zi-panel {
        background: white;
        border: 1px solid #efe4bd;
        border-radius: 20px;
        padding: 18px;
      }

      .zi-panel h2,
      .zi-actions h2 {
        margin: 0 0 16px;
        font-size: 24px;
      }

      .zi-field {
        display: block;
        margin-bottom: 13px;
      }

      .zi-field strong,
      .zi-read strong {
        display: block;
        margin-bottom: 6px;
        font-weight: 950;
      }

      .zi-read {
        margin-bottom: 13px;
      }

      .zi-read span {
        display: block;
        overflow-wrap: anywhere;
      }

      .zi-read-multiline {
        white-space: pre-wrap;
        background: #f7f7f7;
        padding: 12px;
        border-radius: 12px;
      }

      .zi-actions {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 20px;
        align-items: center;
        background: white;
        border: 1px solid #efe4bd;
        border-radius: 20px;
        padding: 18px;
        margin-top: 14px;
      }

      .zi-actions p {
        margin: 0;
        color: rgba(57,65,34,.7);
      }

      .zi-action-buttons {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .zi-button {
        min-height: 42px;
        border: 0;
        border-radius: 999px;
        padding: 0 16px;
        font-weight: 950;
        cursor: pointer;
      }

      .zi-button-grey { background: #e6e6df; color: #2f3521; }
      .zi-button-yellow { background: #c9902f; color: white; }
      .zi-button-green { background: #1f7a35; color: white; }
      .zi-button-red { background: #9f2f1f; color: white; }
      .zi-button-dark { background: #303a21; color: white; }

      .zi-empty {
        background: white;
        border-radius: 24px;
        padding: 28px;
        text-align: center;
        color: rgba(57,65,34,.7);
      }

      @media (max-width: 980px) {
        .zi-page {
          padding: 12px;
        }

        .zi-hero {
          display: block;
          padding: 22px;
          border-radius: 26px;
        }

        .zi-hero h1 {
          font-size: 40px;
        }

        .zi-hero p {
          font-size: 15px;
        }

        .zi-hero-icon {
          display: none;
        }

        .zi-stats {
          display: flex;
          overflow-x: auto;
          padding-bottom: 4px;
          scroll-snap-type: x mandatory;
        }

        .zi-stat {
          min-width: 128px;
          scroll-snap-align: start;
        }

        .zi-toolbar {
          grid-template-columns: 1fr;
        }

        .zi-toolbar input,
        .zi-toolbar select {
          min-height: 50px;
          font-size: 16px;
        }

        .zi-summary {
          grid-template-columns: 1fr auto;
          gap: 12px;
          padding: 18px;
        }

        .zi-summary-badges {
          grid-column: 1 / -1;
          order: 1;
        }

        .zi-summary-main {
          grid-column: 1 / 2;
          order: 2;
        }

        .zi-open {
          grid-column: 2 / 3;
          grid-row: 2 / 3;
          order: 3;
          align-self: start;
          min-width: 78px;
        }

        .zi-summary-contact {
          grid-column: 1 / -1;
          order: 4;
        }

        .zi-summary-order {
          grid-column: 1 / -1;
          order: 5;
        }

        .zi-summary-tax {
          grid-column: 1 / -1;
          order: 6;
        }

        .zi-summary-main strong {
          font-size: 20px;
        }

        .zi-warning,
        .zi-complete {
          margin: 0 18px 18px;
          font-size: 15px;
        }

        .zi-detail {
          padding: 14px;
        }

        .zi-detail-grid {
          grid-template-columns: 1fr;
        }

        .zi-panel {
          padding: 16px;
        }

        .zi-actions {
          grid-template-columns: 1fr;
        }

        .zi-action-buttons {
          display: grid;
          grid-template-columns: 1fr;
          justify-content: stretch;
        }

        .zi-button {
          width: 100%;
          min-height: 48px;
        }
      }
    `}</style>
  );
}
