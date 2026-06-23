import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const applications = await db.b2BApplication.findMany({
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  const stats = {
    total: applications.length,
    pending: applications.filter((item) => item.status === "pending_review").length,
    approved: applications.filter((item) => item.status === "approved").length,
    rejected: applications.filter((item) => item.status === "rejected").length,
    pendingSynced: applications.filter(
      (item) => item.status === "pending_review" && item.shopifyCompanyId,
    ).length,
  };

  return { applications, stats };
}

function appendNote(current: string | null | undefined, note: string) {
  const existing = String(current || "").trim();
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing}\n${note}`;
}

export async function action({ request }: any) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent === "bulk_approve_pending") {
    await db.b2BApplication.updateMany({
      where: {
        status: "pending_review",
      },
      data: {
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
        reviewNotes:
          "Approvata massivamente dall'app: richieste pending segnate come approvate manualmente.",
      },
    });

    return null;
  }

  if (intent === "bulk_approve_rejected") {
    await db.b2BApplication.updateMany({
      where: {
        status: "rejected",
      },
      data: {
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
        reviewNotes:
          "Approvata massivamente dall'app: richieste rifiutate riaperte e segnate come approvate manualmente.",
      },
    });

    return null;
  }

  if (intent === "bulk_approve_synced_pending") {
    await db.b2BApplication.updateMany({
      where: {
        status: "pending_review",
        shopifyCompanyId: { not: null },
      },
      data: {
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
        reviewNotes:
          "Approvata massivamente: Company Shopify già creata/sincronizzata.",
      },
    });

    return null;
  }

  if (!id) {
    throw new Response("Missing application id", { status: 400 });
  }

  if (intent === "delete") {
    await db.b2BApplication.delete({ where: { id } });
    return null;
  }

  if (intent === "approve_status_only") {
    const application = await db.b2BApplication.findUnique({ where: { id } });

    if (!application) {
      throw new Response("Application not found", { status: 404 });
    }

    await db.b2BApplication.update({
      where: { id },
      data: {
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
        reviewNotes: appendNote(
          application.reviewNotes,
          "Approvata manualmente dall'app dall'operatore.",
        ),
      },
    });

    return null;
  }

  if (intent === "reject") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        status: "rejected",
        rejectedAt: new Date(),
      },
    });

    return null;
  }

  if (intent === "pending") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        status: "pending_review",
        approvedAt: null,
        rejectedAt: null,
      },
    });

    return null;
  }

  return null;
}

function formatDate(value: string | Date) {
  return new Date(value).toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusText(status: string) {
  if (status === "approved") return "Approvata";
  if (status === "rejected") return "Rifiutata";
  return "In revisione";
}

function statusTone(status: string): "success" | "danger" | "warning" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function viesText(app: any) {
  if (app.viesValid === true) return "VIES valido";
  if (app.viesValid === false) return "VIES non valido";
  return "VIES non controllato";
}

function viesTone(app: any): "success" | "danger" | "neutral" {
  if (app.viesValid === true) return "success";
  if (app.viesValid === false) return "danger";
  return "neutral";
}

function shopifySyncText(app: any) {
  if (app.shopifyCompanyId) return "Company creata";
  if (app.shopifyCustomerId) return "Cliente creato";
  return "Non sincronizzata";
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "success" | "danger" | "warning" | "info" | "neutral";
}) {
  return <span className={`zbe-badge zbe-badge--${tone}`}>{children}</span>;
}

function Read({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="zbe-read">
      <strong>{label}</strong>
      <div>{value}</div>
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
  tone?: "success" | "warning" | "danger";
}) {
  return (
    <div className="zbe-stat">
      <div className={`zbe-stat-value ${tone ? `zbe-stat-value--${tone}` : ""}`}>
        {value}
      </div>
      <div className="zbe-stat-label">{label}</div>
    </div>
  );
}

export default function ApplicationsPage() {
  const { applications, stats } = useLoaderData<typeof loader>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return applications.filter((app) => {
      const matchesStatus = statusFilter === "all" || app.status === statusFilter;
      const haystack = [
        app.companyNameSubmitted,
        app.vatNumberSubmitted,
        app.email,
        app.viesCompanyName,
        app.billingCountry,
        app.pec,
        app.codiceDestinatario,
        app.shopifyCompanyId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return matchesStatus && (!q || haystack.includes(q));
    });
  }, [applications, query, statusFilter]);

  return (
    <div className="zbe-page">
      <style>{styles}</style>

      <section className="zbe-hero">
        <div>
          <div className="zbe-eyebrow">Zig Business Engine</div>
          <h1>Richieste B2B</h1>
          <p>
            Controlla accessi, VIES, dati fiscali e sincronizzazione Shopify.
          </p>
        </div>
        <div className="zbe-hero-icon">👥</div>
      </section>

      <section className="zbe-stats">
        <Stat label="Totali" value={stats.total} />
        <Stat label="In revisione" value={stats.pending} tone="warning" />
        <Stat label="Approvate" value={stats.approved} tone="success" />
        <Stat label="Rifiutate" value={stats.rejected} tone="danger" />
      </section>

      {(stats.pending > 0 || stats.rejected > 0 || stats.pendingSynced > 0) && (
        <section className="zbe-bulk-box">
          <div>
            <strong>Azioni massive</strong>
            <p>
              Approva in blocco le richieste B2B in revisione o rifiutate. Questa azione aggiorna lo stato nell'app senza ricreare clienti o company Shopify.
            </p>
          </div>

          <div className="zbe-bulk-actions">
            {stats.pending > 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="bulk_approve_pending" />
                <button
                  className="zbe-button zbe-button--green"
                  type="submit"
                  onClick={(event) => {
                    if (!window.confirm(`Approvare manualmente tutte le ${stats.pending} richieste in revisione?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  Approva tutti i pending
                </button>
              </Form>
            )}

            {stats.rejected > 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="bulk_approve_rejected" />
                <button
                  className="zbe-button zbe-button--green"
                  type="submit"
                  onClick={(event) => {
                    if (!window.confirm(`Approvare manualmente tutte le ${stats.rejected} richieste rifiutate?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  Approva tutte le rifiutate
                </button>
              </Form>
            )}

            {stats.pendingSynced > 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="bulk_approve_synced_pending" />
                <button
                  className="zbe-button zbe-button--outline"
                  type="submit"
                  onClick={(event) => {
                    if (!window.confirm(`Approvare ${stats.pendingSynced} richieste pending già sincronizzate?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  Approva solo sincronizzate
                </button>
              </Form>
            )}
          </div>
        </section>
      )}

      <section className="zbe-toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca azienda, VAT, email..."
        />

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="all">Tutti gli stati</option>
          <option value="pending_review">In revisione</option>
          <option value="approved">Approvate</option>
          <option value="rejected">Rifiutate</option>
        </select>
      </section>

      <section className="zbe-list">
        {filtered.map((app) => {
          const isOpen = openId === app.id;
          const canApproveStatusOnly = app.status !== "approved";

          return (
            <article key={app.id} className="zbe-request">
              <div className="zbe-summary">
                <div className="zbe-summary-main">
                  <div className="zbe-badges">
                    <Badge tone={statusTone(app.status)}>{statusText(app.status)}</Badge>
                    <Badge tone={viesTone(app)}>{viesText(app)}</Badge>
                    {app.shopifyCompanyId && <Badge tone="info">Company creata</Badge>}
                  </div>

                  <strong className="zbe-company">
                    {app.companyNameSubmitted || "Azienda senza nome"}
                  </strong>

                  <div className="zbe-mobile-meta">
                    {app.vatNumberSubmitted || "VAT mancante"} ·{" "}
                    {app.email || "Email mancante"}
                  </div>
                </div>

                <div className="zbe-summary-cell">
                  <span>Azienda / VAT</span>
                  <strong>{app.companyNameSubmitted || "-"}</strong>
                  <small>{app.vatNumberSubmitted || "VAT mancante"}</small>
                </div>

                <div className="zbe-summary-cell">
                  <span>Contatto</span>
                  <strong>{app.email || "-"}</strong>
                  <small>{app.billingCountry || "Paese non indicato"}</small>
                </div>

                <div className="zbe-summary-cell">
                  <span>Controllo</span>
                  <strong>
                    {app.matchScore === null || app.matchScore === undefined
                      ? "Match —"
                      : `Match ${app.matchScore}%`}
                  </strong>
                  <small>{shopifySyncText(app)}</small>
                </div>

                <div className="zbe-summary-cell">
                  <span>Data</span>
                  <strong>{formatDate(app.createdAt)}</strong>
                  <small>Agg. {formatDate(app.updatedAt)}</small>
                </div>

                <button
                  type="button"
                  className="zbe-button zbe-button--dark"
                  onClick={() => setOpenId(isOpen ? null : app.id)}
                >
                  {isOpen ? "Chiudi" : "Apri"}
                </button>
              </div>

              {isOpen && (
                <div className="zbe-detail">
                  <div className="zbe-detail-grid">
                    <section className="zbe-card">
                      <h2>Richiesta</h2>
                      <Read label="Azienda inserita" value={app.companyNameSubmitted || "-"} />
                      <Read label="Email" value={app.email || "-"} />
                      <Read label="Nome" value={app.firstName || "-"} />
                      <Read label="Cognome" value={app.lastName || "-"} />
                    </section>

                    <section className="zbe-card">
                      <h2>Dati fiscali</h2>
                      <Read label="Partita IVA / VAT" value={app.vatNumberSubmitted || "-"} />
                      <Read label="Paese" value={app.billingCountry || "-"} />
                      <Read label="PEC" value={app.pec || "-"} />
                      <Read
                        label="Codice destinatario / SDI"
                        value={app.codiceDestinatario || "-"}
                      />
                    </section>

                    <section className="zbe-card">
                      <h2>VIES</h2>
                      <Read
                        label="Validità"
                        value={
                          app.viesValid
                            ? "Valido"
                            : app.viesValid === false
                              ? "Non valido"
                              : "-"
                        }
                      />
                      <Read label="Azienda VIES" value={app.viesCompanyName || "-"} />
                      <Read label="Paese VIES" value={app.viesCountryCode || "-"} />
                      <Read label="VAT VIES" value={app.viesVatNumber || "-"} />
                      <Read
                        label="Match"
                        value={
                          app.matchScore === null || app.matchScore === undefined
                            ? "-"
                            : `${app.matchScore}%`
                        }
                      />
                      <Read
                        label="Indirizzo VIES"
                        value={<pre className="zbe-pre">{app.viesAddress || "-"}</pre>}
                      />
                    </section>

                    <section className="zbe-card">
                      <h2>Shopify</h2>
                      <Read label="Customer ID" value={app.shopifyCustomerId || "Non creato"} />
                      <Read label="Company ID" value={app.shopifyCompanyId || "Non creata"} />
                      <Read
                        label="Location ID"
                        value={app.shopifyCompanyLocationId || "Non creata"}
                      />
                      <Read label="Note revisione" value={app.reviewNotes || "-"} />
                    </section>
                  </div>

                  <section className="zbe-actions">
                    {canApproveStatusOnly && (
                      <Form method="post">
                        <input type="hidden" name="id" value={app.id} />
                        <button
                          className="zbe-button zbe-button--green"
                          name="intent"
                          value="approve_status_only"
                          type="submit"
                        >
                          Approva manualmente
                        </button>
                      </Form>
                    )}

                    {app.status !== "pending_review" && (
                      <Form method="post">
                        <input type="hidden" name="id" value={app.id} />
                        <button
                          className="zbe-button zbe-button--yellow"
                          name="intent"
                          value="pending"
                          type="submit"
                        >
                          Rimetti in revisione
                        </button>
                      </Form>
                    )}

                    {app.status !== "rejected" && (
                      <Form method="post">
                        <input type="hidden" name="id" value={app.id} />
                        <button
                          className="zbe-button zbe-button--red"
                          name="intent"
                          value="reject"
                          type="submit"
                        >
                          Rifiuta
                        </button>
                      </Form>
                    )}

                    <Form method="post">
                      <input type="hidden" name="id" value={app.id} />
                      <button
                        className="zbe-button zbe-button--outline-red"
                        name="intent"
                        value="delete"
                        type="submit"
                        onClick={(event) => {
                          if (
                            !window.confirm(
                              "Eliminare definitivamente questa richiesta?",
                            )
                          ) {
                            event.preventDefault();
                          }
                        }}
                      >
                        Elimina test
                      </button>
                    </Form>
                  </section>
                </div>
              )}
            </article>
          );
        })}

        {!filtered.length && (
          <div className="zbe-empty">Nessuna richiesta B2B trovata.</div>
        )}
      </section>
    </div>
  );
}

const styles = `
.zbe-page {
  padding: 24px;
  background: #f5f1df;
  min-height: 100vh;
  color: #253018;
}

.zbe-hero {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: center;
  background: linear-gradient(135deg, #aec58b 0%, #f5f1df 68%, #ffd44d 100%);
  border-radius: 34px;
  padding: 34px;
  box-shadow: 0 18px 45px rgba(57,65,34,.12);
}

.zbe-eyebrow {
  text-transform: uppercase;
  letter-spacing: .08em;
  font-size: 13px;
  font-weight: 900;
  color: #6f873d;
  margin-bottom: 10px;
}

.zbe-hero h1 {
  margin: 0;
  font-size: clamp(42px, 6vw, 72px);
  line-height: .92;
  font-weight: 950;
}

.zbe-hero p {
  max-width: 760px;
  font-size: 18px;
  line-height: 1.45;
  margin-top: 18px;
}

.zbe-hero-icon {
  font-size: 72px;
  background: rgba(248,243,223,.78);
  width: 150px;
  height: 150px;
  border-radius: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.zbe-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 20px;
}

.zbe-stat {
  background: white;
  border-radius: 22px;
  padding: 18px;
  box-shadow: 0 12px 30px rgba(57,65,34,.08);
}

.zbe-stat-value {
  font-size: 34px;
  font-weight: 950;
  line-height: 1;
  color: #394122;
}

.zbe-stat-value--success { color: #1f7a35; }
.zbe-stat-value--warning { color: #b7791f; }
.zbe-stat-value--danger { color: #9f2f1f; }

.zbe-stat-label {
  margin-top: 8px;
  font-weight: 800;
  color: rgba(37,48,24,.70);
}

.zbe-bulk-box {
  margin-top: 18px;
  background: #fff7dc;
  border: 1px solid #ffd36a;
  border-radius: 22px;
  padding: 18px;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: center;
}

.zbe-bulk-box p {
  margin: 6px 0 0;
  color: rgba(37,48,24,.70);
}

.zbe-toolbar {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: 12px;
  margin-top: 20px;
}

.zbe-toolbar input,
.zbe-toolbar select {
  min-height: 48px;
  border: 1px solid rgba(57,65,34,.18);
  border-radius: 999px;
  padding: 0 18px;
  font-size: 15px;
  background: white;
}

.zbe-list {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}

.zbe-request {
  background: white;
  border-radius: 24px;
  box-shadow: 0 12px 30px rgba(57,65,34,.08);
  overflow: hidden;
}

.zbe-summary {
  display: grid;
  grid-template-columns: 250px 1.2fr 1.1fr 1fr 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 18px;
}

.zbe-summary-main {
  display: none;
}

.zbe-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.zbe-badge {
  display: inline-flex;
  border-radius: 999px;
  padding: 7px 11px;
  font-weight: 900;
  font-size: 13px;
  white-space: nowrap;
}

.zbe-badge--success { background: #dff3df; color: #1f5f2f; }
.zbe-badge--danger { background: #ffe1dc; color: #8a2b1b; }
.zbe-badge--warning { background: #fff3cd; color: #7a4b00; }
.zbe-badge--info { background: #e5f0ff; color: #234f9d; }
.zbe-badge--neutral { background: rgba(57,65,34,.08); color: #394122; }

.zbe-company {
  display: block;
  font-size: 18px;
  margin-top: 10px;
}

.zbe-mobile-meta {
  color: rgba(37,48,24,.62);
  font-size: 13px;
  margin-top: 4px;
}

.zbe-summary-cell span {
  display: block;
  color: rgba(37,48,24,.55);
  font-size: 12px;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: .04em;
  margin-bottom: 4px;
}

.zbe-summary-cell strong {
  display: block;
  overflow-wrap: anywhere;
}

.zbe-summary-cell small {
  display: block;
  color: rgba(37,48,24,.62);
  font-size: 13px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}

.zbe-button {
  min-height: 42px;
  border: 0;
  border-radius: 999px;
  padding: 0 18px;
  font-weight: 900;
  cursor: pointer;
  white-space: nowrap;
}

.zbe-button--dark { background: #303a21; color: white; }
.zbe-button--green { background: #1f7a35; color: white; }
.zbe-button--yellow { background: #f5c24b; color: #302100; }
.zbe-button--red { background: #9f2f1f; color: white; }
.zbe-button--outline-red {
  background: white;
  color: #9f2f1f;
  border: 1px solid #f0b8ad;
}

.zbe-detail {
  padding: 18px;
  background: #f7f2df;
  border-top: 1px solid #efe4bd;
}

.zbe-detail-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.zbe-card {
  background: white;
  border: 1px solid #efe4bd;
  border-radius: 18px;
  padding: 16px;
}

.zbe-card h2 {
  margin-top: 0;
  margin-bottom: 16px;
}

.zbe-read {
  margin-bottom: 12px;
}

.zbe-read strong {
  display: block;
  margin-bottom: 4px;
}

.zbe-read div {
  overflow-wrap: anywhere;
}

.zbe-pre {
  white-space: pre-wrap;
  background: #f7f7f7;
  padding: 12px;
  border-radius: 12px;
  margin: 0;
}

.zbe-actions {
  margin-top: 16px;
  background: white;
  border: 1px solid #efe4bd;
  border-radius: 18px;
  padding: 16px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.zbe-empty {
  background: white;
  border-radius: 24px;
  padding: 28px;
  text-align: center;
  color: rgba(37,48,24,.7);
}

@media (max-width: 980px) {
  .zbe-page {
    padding: 14px;
  }

  .zbe-hero {
    padding: 22px;
    border-radius: 26px;
  }

  .zbe-hero-icon {
    display: none;
  }

  .zbe-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .zbe-bulk-box {
    align-items: stretch;
    flex-direction: column;
  }

  .zbe-toolbar {
    grid-template-columns: 1fr;
  }

  .zbe-summary {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .zbe-summary-main {
    display: block;
  }

  .zbe-summary-cell {
    display: none;
  }

  .zbe-button {
    width: 100%;
  }

  .zbe-detail-grid {
    grid-template-columns: 1fr;
  }

  .zbe-actions {
    display: grid;
    grid-template-columns: 1fr;
  }
}
`
