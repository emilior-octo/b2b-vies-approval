import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const applications = await db.b2BApplication.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
  });

  const stats = {
    total: applications.length,
    pending: applications.filter((item) => item.status === "pending_review").length,
    approved: applications.filter((item) => item.status === "approved").length,
    rejected: applications.filter((item) => item.status === "rejected").length,
  };

  return { applications, stats };
}

export async function action({ request }: any) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const id = String(formData.get("id") || "");
  const intent = String(formData.get("intent") || "");

  if (!id) {
    throw new Response("Missing application id", { status: 400 });
  }

  if (intent === "delete") {
    await db.b2BApplication.delete({ where: { id } });
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

function statusTone(status: string) {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function viesText(app: any) {
  if (app.viesValid === true) return "VIES valido";
  if (app.viesValid === false) return "VIES non valido";
  return "VIES non controllato";
}

function viesTone(app: any) {
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

          return (
            <article key={app.id} className="zbe-request">
              <div className="zbe-summary">
                <div className="zbe-summary-main">
                  <div className="zbe-badges">
                    <Badge tone={statusTone(app.status) as any}>{statusText(app.status)}</Badge>
                    <Badge tone={viesTone(app) as any}>{viesText(app)}</Badge>
                  </div>

                  <strong className="zbe-company">
                    {app.companyNameSubmitted || "Azienda senza nome"}
                  </strong>

                  <div className="zbe-mobile-meta">
                    {app.vatNumberSubmitted || "VAT mancante"} ·{" "}
                    {app.billingCountry || "Paese non indicato"}
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
                      <Read label="Codice destinatario / SDI" value={app.codiceDestinatario || "-"} />
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
                      <div className="zbe-read">
                        <strong>Indirizzo VIES</strong>
                        <pre>{app.viesAddress || "-"}</pre>
                      </div>
                    </section>

                    <section className="zbe-card">
                      <h2>Shopify</h2>
                      <Read label="Customer ID" value={app.shopifyCustomerId || "Non creato"} />
                      <Read label="Company ID" value={app.shopifyCompanyId || "Non creata"} />
                      <Read label="Location ID" value={app.shopifyCompanyLocationId || "Non creata"} />
                      <Read label="Note revisione" value={app.reviewNotes || "-"} />
                    </section>
                  </div>

                  <div className="zbe-danger">
                    <div>
                      <strong>Elimina richiesta</strong>
                      <small>
                        Solo per test o duplicati. L’azione è definitiva.
                      </small>
                    </div>

                    <Form
                      method="post"
                      onSubmit={(event) => {
                        if (
                          !window.confirm(
                            "Eliminare definitivamente questa richiesta B2B?",
                          )
                        ) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="id" value={app.id} />
                      <button
                        type="submit"
                        name="intent"
                        value="delete"
                        className="zbe-button zbe-button--red"
                      >
                        Elimina
                      </button>
                    </Form>
                  </div>
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
    margin: 18px 0 0;
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
    flex: 0 0 auto;
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
    grid-template-columns: minmax(230px, 1.2fr) minmax(190px, 1fr) minmax(190px, 1fr) minmax(160px, .8fr) minmax(150px, .75fr) auto;
    gap: 14px;
    align-items: center;
    padding: 18px;
  }

  .zbe-summary-main {
    min-width: 0;
  }

  .zbe-company {
    display: none;
    font-size: 17px;
    line-height: 1.2;
    margin-top: 10px;
    overflow-wrap: anywhere;
  }

  .zbe-mobile-meta {
    display: none;
    color: rgba(37,48,24,.62);
    font-size: 13px;
    margin-top: 6px;
  }

  .zbe-summary-cell {
    min-width: 0;
  }

  .zbe-summary-cell span {
    display: block;
    color: rgba(37,48,24,.55);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .04em;
    margin-bottom: 4px;
  }

  .zbe-summary-cell strong,
  .zbe-summary-cell small {
    display: block;
    overflow-wrap: anywhere;
  }

  .zbe-summary-cell small {
    color: rgba(37,48,24,.62);
    font-size: 13px;
    margin-top: 4px;
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

  .zbe-button {
    min-height: 42px;
    border: 0;
    border-radius: 999px;
    padding: 0 18px;
    font-weight: 900;
    cursor: pointer;
    white-space: nowrap;
  }

  .zbe-button--dark {
    background: #303a21;
    color: white;
  }

  .zbe-button--red {
    background: #9f2f1f;
    color: white;
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
    min-width: 0;
  }

  .zbe-card h2 {
    margin: 0 0 16px;
    font-size: 18px;
  }

  .zbe-read {
    margin-bottom: 12px;
  }

  .zbe-read strong {
    display: block;
    margin-bottom: 4px;
  }

  .zbe-read div,
  .zbe-read pre {
    overflow-wrap: anywhere;
  }

  .zbe-read pre {
    white-space: pre-wrap;
    background: #f7f7f7;
    padding: 12px;
    border-radius: 12px;
    margin: 0;
  }

  .zbe-danger {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-top: 16px;
    background: #fff;
    border: 1px solid #f0b8ad;
    border-radius: 18px;
    padding: 16px;
  }

  .zbe-danger small {
    display: block;
    color: rgba(37,48,24,.62);
    margin-top: 4px;
  }

  .zbe-empty {
    background: white;
    border-radius: 24px;
    padding: 28px;
    text-align: center;
    color: rgba(37,48,24,.7);
  }

  @media (max-width: 1180px) {
    .zbe-summary {
      grid-template-columns: minmax(230px, 1.3fr) minmax(190px, 1fr) minmax(190px, 1fr) auto;
    }

    .zbe-summary-cell:nth-of-type(4),
    .zbe-summary-cell:nth-of-type(5) {
      display: none;
    }

    .zbe-detail-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 760px) {
    .zbe-page {
      padding: 12px;
    }

    .zbe-hero {
      border-radius: 24px;
      padding: 22px;
    }

    .zbe-hero-icon {
      display: none;
    }

    .zbe-hero h1 {
      font-size: 42px;
    }

    .zbe-hero p {
      font-size: 15px;
    }

    .zbe-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .zbe-stat {
      border-radius: 18px;
      padding: 14px;
    }

    .zbe-stat-value {
      font-size: 28px;
    }

    .zbe-toolbar {
      grid-template-columns: 1fr;
    }

    .zbe-request {
      border-radius: 20px;
    }

    .zbe-summary {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      padding: 16px;
    }

    .zbe-company,
    .zbe-mobile-meta {
      display: block;
    }

    .zbe-summary-cell {
      display: none;
    }

    .zbe-summary .zbe-button {
      width: 100%;
    }

    .zbe-detail {
      padding: 14px;
    }

    .zbe-detail-grid {
      grid-template-columns: 1fr;
      gap: 12px;
    }

    .zbe-card {
      border-radius: 16px;
      padding: 14px;
    }

    .zbe-danger {
      display: grid;
      grid-template-columns: 1fr;
    }

    .zbe-danger .zbe-button {
      width: 100%;
    }
  }
`;
