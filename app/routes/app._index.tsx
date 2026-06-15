import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const [total, pending, approved, rejected, latest] = await Promise.all([
    db.b2BApplication.count(),
    db.b2BApplication.count({ where: { status: "pending_review" } }),
    db.b2BApplication.count({ where: { status: "approved" } }),
    db.b2BApplication.count({ where: { status: "rejected" } }),
    db.b2BApplication.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  return { total, pending, approved, rejected, latest };
};

export default function Index() {
  const { total, pending, approved, rejected, latest } =
    useLoaderData<typeof loader>();

  return (
    <div style={page}>
      <section style={hero}>
        <div>
          <div style={eyebrow}>Zig B2B Engine</div>
          <h1 style={title}>Più clienti B2B. Zero pensieri.</h1>
          <p style={subtitle}>
            Verifica VAT, controllo VIES, richieste in revisione, customer tags,
            metafield fiscali e Company Shopify in un unico pannello.
          </p>

          <div style={heroActions}>
            <Link to="/app/applications" style={primaryButton}>
              Apri richieste B2B
            </Link>
            <a
              href="https://vies-approval-form.onrender.com/api/b2b-verify"
              target="_blank"
              rel="noreferrer"
              style={secondaryButton}
            >
              Test endpoint
            </a>
          </div>
        </div>

        <div style={peanutCard}>
          <div style={peanutIcon}>🥜</div>
          <strong>VIES Approval Form</strong>
          <span>Backend live · PostgreSQL · Shopify Admin</span>
        </div>
      </section>

      <section style={statsGrid}>
        <Stat label="Totale richieste" value={total} />
        <Stat label="In revisione" value={pending} tone="warning" />
        <Stat label="Approvate" value={approved} tone="success" />
        <Stat label="Rigettate" value={rejected} tone="danger" />
      </section>

      <section style={panel}>
        <div style={panelHeader}>
          <div>
            <h2 style={panelTitle}>Ultime richieste</h2>
            <p style={panelText}>
              Apri la dashboard per correggere dati, approvare manualmente,
              rigettare o creare Company Shopify.
            </p>
          </div>

          <Link to="/app/applications" style={smallButton}>
            Vedi tutto
          </Link>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Status</th>
                <th style={th}>Azienda</th>
                <th style={th}>VAT</th>
                <th style={th}>Email</th>
                <th style={th}>Match</th>
                <th style={th}>Data</th>
              </tr>
            </thead>
            <tbody>
              {latest.map((item) => (
                <tr key={item.id}>
                  <td style={td}>{statusLabel(item.status)}</td>
                  <td style={td}>{item.companyNameSubmitted}</td>
                  <td style={td}>{item.vatNumberSubmitted}</td>
                  <td style={td}>{item.email}</td>
                  <td style={td}>{item.matchScore ?? "-"}%</td>
                  <td style={td}>{new Date(item.createdAt).toLocaleString()}</td>
                </tr>
              ))}

              {!latest.length && (
                <tr>
                  <td style={td} colSpan={6}>
                    Ancora nessuna richiesta B2B.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
    tone === "success" ? "#7f9954" : tone === "warning" ? "#d99a2b" : tone === "danger" ? "#a13a24" : "#394122";

  return (
    <div style={statCard}>
      <div style={{ ...statValue, color }}>{value}</div>
      <div style={statLabel}>{label}</div>
    </div>
  );
}

function statusLabel(status: string) {
  if (status === "approved") return "✅ Approved";
  if (status === "rejected") return "❌ Rejected";
  return "🟡 Pending";
}

const page: React.CSSProperties = {
  padding: 24,
  background: "#f5f1df",
  minHeight: "100vh",
  color: "#394122",
};

const hero: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.5fr .8fr",
  gap: 24,
  alignItems: "center",
  background: "linear-gradient(135deg, #aec58b 0%, #f5f1df 62%, #ffd44d 100%)",
  borderRadius: 34,
  padding: 34,
  boxShadow: "0 18px 45px rgba(57,65,34,.12)",
};

const eyebrow: React.CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: ".08em",
  fontSize: 13,
  fontWeight: 900,
  color: "#6f873d",
  marginBottom: 10,
};

const title: React.CSSProperties = {
  margin: 0,
  maxWidth: 720,
  fontSize: "clamp(42px, 6vw, 78px)",
  lineHeight: ".92",
  fontWeight: 950,
};

const subtitle: React.CSSProperties = {
  maxWidth: 720,
  fontSize: 18,
  lineHeight: 1.45,
  marginTop: 18,
};

const heroActions: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  marginTop: 24,
};

const primaryButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 52,
  padding: "0 22px",
  borderRadius: 999,
  background: "#394122",
  color: "#f8f3df",
  textDecoration: "none",
  fontWeight: 900,
};

const secondaryButton: React.CSSProperties = {
  ...primaryButton,
  background: "rgba(57,65,34,.10)",
  color: "#394122",
};

const peanutCard: React.CSSProperties = {
  background: "rgba(248,243,223,.82)",
  borderRadius: 30,
  padding: 24,
  minHeight: 210,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  textAlign: "center",
  boxShadow: "inset 0 0 0 1px rgba(57,65,34,.10)",
};

const peanutIcon: React.CSSProperties = {
  fontSize: 62,
  marginBottom: 12,
};

const statsGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 16,
  marginTop: 20,
};

const statCard: React.CSSProperties = {
  background: "white",
  borderRadius: 24,
  padding: 20,
  boxShadow: "0 12px 30px rgba(57,65,34,.08)",
};

const statValue: React.CSSProperties = {
  fontSize: 42,
  fontWeight: 950,
  lineHeight: 1,
};

const statLabel: React.CSSProperties = {
  marginTop: 8,
  fontWeight: 800,
  color: "rgba(57,65,34,.72)",
};

const panel: React.CSSProperties = {
  background: "white",
  borderRadius: 28,
  padding: 22,
  marginTop: 20,
  boxShadow: "0 12px 30px rgba(57,65,34,.08)",
};

const panelHeader: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
  alignItems: "center",
  marginBottom: 16,
};

const panelTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 28,
};

const panelText: React.CSSProperties = {
  margin: "8px 0 0",
  color: "rgba(57,65,34,.72)",
};

const smallButton: React.CSSProperties = {
  ...primaryButton,
  minHeight: 42,
  padding: "0 16px",
};

const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: 12,
  borderBottom: "1px solid #e7e0c7",
};

const td: React.CSSProperties = {
  padding: 12,
  borderBottom: "1px solid #f0ead3",
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};