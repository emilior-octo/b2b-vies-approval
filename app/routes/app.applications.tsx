import { useLoaderData, useLocation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const applications = await db.b2BApplication.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return { applications };
}

function statusLabel(status: string) {
  if (status === "approved") return "✅ Approved";
  if (status === "rejected") return "❌ Rejected";
  return "🟡 Pending review";
}

export default function ApplicationsPage() {
  const { applications } = useLoaderData<typeof loader>();
  const location = useLocation();

  function detailUrl(id: string) {
    return `/app/applications/${id}${location.search || ""}`;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>B2B Applications</h1>

      <p style={{ marginBottom: 24 }}>
        Review B2B access requests, VIES results and Shopify sync status.
      </p>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: "white" }}>
          <thead>
            <tr>
              <th style={th}>Status</th>
              <th style={th}>Company</th>
              <th style={th}>VAT</th>
              <th style={th}>Email</th>
              <th style={th}>Match</th>
              <th style={th}>VIES</th>
              <th style={th}>Created</th>
              <th style={th}>Action</th>
            </tr>
          </thead>

          <tbody>
            {applications.map((app) => (
              <tr key={app.id}>
                <td style={td}>{statusLabel(app.status)}</td>
                <td style={td}>{app.companyNameSubmitted || "-"}</td>
                <td style={td}>{app.vatNumberSubmitted}</td>
                <td style={td}>{app.email}</td>
                <td style={td}>{app.matchScore ?? "-"}%</td>
                <td style={td}>{app.viesValid ? "Valid" : "Invalid"}</td>
                <td style={td}>{new Date(app.createdAt).toLocaleString()}</td>
                <td style={td}>
                  <a href={detailUrl(app.id)} style={buttonLink}>
                    Open
                  </a>
                </td>
              </tr>
            ))}

            {!applications.length && (
              <tr>
                <td style={td} colSpan={8}>
                  No B2B applications yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "12px",
  borderBottom: "1px solid #ddd",
  fontWeight: 700,
};

const td: React.CSSProperties = {
  padding: "12px",
  borderBottom: "1px solid #eee",
};

const buttonLink: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 34,
  padding: "0 14px",
  borderRadius: 999,
  background: "#303a21",
  color: "white",
  textDecoration: "none",
  fontWeight: 700,
};