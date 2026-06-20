import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
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
  return new Date(value).toLocaleString("it-IT");
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
  return <span style={{ ...badgeBase, ...badgeTone[tone] }}>{children}</span>;
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
    <div style={page}>
      <section style={hero}>
        <div>
          <div style={eyebrow}>Zig Business Engine</div>
          <h1 style={title}>Richieste B2B</h1>
          <p style={subtitle}>
            Controlla richieste di accesso, risultato VIES, dati fiscali e sincronizzazione Shopify.
          </p>
        </div>
        <div style={heroIcon}>👥</div>
      </section>

      <section style={statsGrid}>
        <Stat label="Totali" value={stats.total} />
        <Stat label="In revisione" value={stats.pending} tone="warning" />
        <Stat label="Approvate" value={stats.approved} tone="success" />
        <Stat label="Rifiutate" value={stats.rejected} tone="danger" />
      </section>

      <section style={toolbar}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca azienda, VAT, email..."
          style={searchInput}
        />

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          style={selectInput}
        >
          <option value="all">Tutti gli stati</option>
          <option value="pending_review">In revisione</option>
          <option value="approved">Approvate</option>
          <option value="rejected">Rifiutate</option>
        </select>
      </section>

      <section style={list}>
        {filtered.map((app) => {
          const isOpen = openId === app.id;

          return (
            <article key={app.id} style={requestCard}>
              <div style={summaryGrid}>
                <div style={badges}>
                  <Badge tone={statusTone(app.status)}>{statusText(app.status)}</Badge>
                  <Badge tone={app.viesValid ? "success" : app.viesValid === false ? "danger" : "neutral"}>
                    {viesText(app)}
                  </Badge>
                </div>

                <div>
                  <strong style={primaryText}>{app.companyNameSubmitted || "Azienda senza nome"}</strong>
                  <div style={muted}>{app.vatNumberSubmitted || "VAT mancante"}</div>
                </div>

                <div>
                  <strong>{app.email || "-"}</strong>
                  <div style={muted}>{app.billingCountry || "Paese non indicato"}</div>
                </div>

                <div>
                  <strong>{app.matchScore === null || app.matchScore === undefined ? "Match —" : `Match ${app.matchScore}%`}</strong>
                  <div style={muted}>{shopifySyncText(app)}</div>
                </div>

                <div>
                  <strong>{formatDate(app.createdAt)}</strong>
                  <div style={muted}>Aggiornata {formatDate(app.updatedAt)}</div>
                </div>

                <button
                  type="button"
                  style={buttonDark}
                  onClick={() => setOpenId(isOpen ? null : app.id)}
                >
                  {isOpen ? "Chiudi" : "Apri"}
                </button>
              </div>

              {isOpen && (
                <div style={detailBox}>
                  <div style={detailGrid}>
                    <section style={card}>
                      <h2 style={sectionTitle}>Richiesta</h2>
                      <Read label="Azienda inserita" value={app.companyNameSubmitted || "-"} />
                      <Read label="Email" value={app.email || "-"} />
                      <Read label="Nome" value={app.firstName || "-"} />
                      <Read label="Cognome" value={app.lastName || "-"} />
                    </section>

                    <section style={card}>
                      <h2 style={sectionTitle}>Dati fiscali</h2>
                      <Read label="Partita IVA / VAT" value={app.vatNumberSubmitted || "-"} />
                      <Read label="Paese" value={app.billingCountry || "-"} />
                      <Read label="PEC" value={app.pec || "-"} />
                      <Read label="Codice destinatario / SDI" value={app.codiceDestinatario || "-"} />
                    </section>

                    <section style={card}>
                      <h2 style={sectionTitle}>VIES</h2>
                      <Read label="Validità" value={app.viesValid ? "Valido" : app.viesValid === false ? "Non valido" : "-"} />
                      <Read label="Azienda VIES" value={app.viesCompanyName || "-"} />
                      <Read label="Paese VIES" value={app.viesCountryCode || "-"} />
                      <Read label="VAT VIES" value={app.viesVatNumber || "-"} />
                      <Read label="Match" value={app.matchScore === null || app.matchScore === undefined ? "-" : `${app.matchScore}%`} />
                      <div style={{ marginTop: 12 }}>
                        <strong>Indirizzo VIES</strong>
                        <pre style={pre}>{app.viesAddress || "-"}</pre>
                      </div>
                    </section>

                    <section style={card}>
                      <h2 style={sectionTitle}>Shopify</h2>
                      <Read label="Customer ID" value={app.shopifyCustomerId || "Non creato"} />
                      <Read label="Company ID" value={app.shopifyCompanyId || "Non creata"} />
                      <Read label="Location ID" value={app.shopifyCompanyLocationId || "Non creata"} />
                      <Read label="Note revisione" value={app.reviewNotes || "-"} />
                    </section>
                  </div>

                  <div style={dangerZone}>
                    <div>
                      <strong>Elimina richiesta</strong>
                      <div style={muted}>Usalo solo per pulire test o richieste duplicate. L’azione è definitiva.</div>
                    </div>

                    <Form method="post" onSubmit={(event) => {
                      if (!window.confirm("Eliminare definitivamente questa richiesta B2B?")) {
                        event.preventDefault();
                      }
                    }}>
                      <input type="hidden" name="id" value={app.id} />
                      <button type="submit" name="intent" value="delete" style={buttonRed}>
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
          <div style={emptyState}>Nessuna richiesta B2B trovata.</div>
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
  tone?: "success" | "warning" | "danger";
}) {
  const color =
    tone === "success" ? "#1f7a35" : tone === "warning" ? "#b7791f" : tone === "danger" ? "#9f2f1f" : "#394122";

  return (
    <div style={statCard}>
      <div style={{ ...statValue, color }}>{value}</div>
      <div style={statLabel}>{label}</div>
    </div>
  );
}

function Read({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <strong style={{ display: "block", marginBottom: 4 }}>{label}</strong>
      <div style={{ overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

const page: CSSProperties = {
  padding: 24,
  background: "#f5f1df",
  minHeight: "100vh",
  color: "#253018",
};

const hero: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 24,
  alignItems: "center",
  background: "linear-gradient(135deg, #aec58b 0%, #f5f1df 68%, #ffd44d 100%)",
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
  fontSize: "clamp(42px, 6vw, 72px)",
  lineHeight: ".92",
  fontWeight: 950,
};

const subtitle: CSSProperties = {
  maxWidth: 760,
  fontSize: 18,
  lineHeight: 1.45,
  marginTop: 18,
};

const heroIcon: CSSProperties = {
  fontSize: 72,
  background: "rgba(248,243,223,.78)",
  width: 150,
  height: 150,
  borderRadius: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const statsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
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
  fontSize: 34,
  fontWeight: 950,
  lineHeight: 1,
};

const statLabel: CSSProperties = {
  marginTop: 8,
  fontWeight: 800,
  color: "rgba(37,48,24,.70)",
};

const toolbar: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 220px",
  gap: 12,
  marginTop: 20,
};

const searchInput: CSSProperties = {
  minHeight: 48,
  border: "1px solid rgba(57,65,34,.18)",
  borderRadius: 999,
  padding: "0 18px",
  fontSize: 15,
};

const selectInput: CSSProperties = {
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
  gridTemplateColumns: "250px 1.2fr 1.1fr 1fr 1fr auto",
  gap: 14,
  alignItems: "center",
  padding: 18,
};

const badges: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
};

const badgeBase: CSSProperties = {
  display: "inline-flex",
  borderRadius: 999,
  padding: "7px 11px",
  fontWeight: 900,
  fontSize: 13,
  whiteSpace: "nowrap",
};

const badgeTone: Record<string, CSSProperties> = {
  success: { background: "#dff3df", color: "#1f5f2f" },
  danger: { background: "#ffe1dc", color: "#8a2b1b" },
  warning: { background: "#fff3cd", color: "#7a4b00" },
  info: { background: "#e5f0ff", color: "#234f9d" },
  neutral: { background: "rgba(57,65,34,.08)", color: "#394122" },
};

const primaryText: CSSProperties = {
  fontSize: 16,
};

const muted: CSSProperties = {
  color: "rgba(37,48,24,.62)",
  fontSize: 13,
  marginTop: 4,
};

const buttonDark: CSSProperties = {
  minHeight: 42,
  border: 0,
  borderRadius: 999,
  background: "#303a21",
  color: "white",
  padding: "0 18px",
  fontWeight: 900,
  cursor: "pointer",
};

const buttonRed: CSSProperties = {
  ...buttonDark,
  background: "#9f2f1f",
};

const dangerZone: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 16,
  marginTop: 16,
  background: "#fff",
  border: "1px solid #f0b8ad",
  borderRadius: 18,
  padding: 16,
};

const detailBox: CSSProperties = {
  padding: 18,
  background: "#f7f2df",
  borderTop: "1px solid #efe4bd",
};

const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 14,
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #efe4bd",
  borderRadius: 18,
  padding: 16,
};

const sectionTitle: CSSProperties = {
  marginTop: 0,
  marginBottom: 16,
};

const pre: CSSProperties = {
  whiteSpace: "pre-wrap",
  background: "#f7f7f7",
  padding: 12,
  borderRadius: 12,
};

const emptyState: CSSProperties = {
  background: "white",
  borderRadius: 24,
  padding: 28,
  textAlign: "center",
  color: "rgba(37,48,24,.7)",
};
