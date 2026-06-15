import { Form, useLoaderData } from "react-router";
import { useState } from "react";
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

export async function action({ request }: any) {
  await authenticate.admin(request);

  const formData = await request.formData();

  const id = String(formData.get("id") || "");
  const intent = String(formData.get("intent") || "");

  if (!id) {
    throw new Response("Missing application id", { status: 400 });
  }

  const baseData = {
    email: String(formData.get("email") || ""),
    firstName: String(formData.get("firstName") || "") || null,
    lastName: String(formData.get("lastName") || "") || null,
    companyNameSubmitted: String(formData.get("companyNameSubmitted") || ""),
    vatNumberSubmitted: String(formData.get("vatNumberSubmitted") || ""),
    billingCountry: String(formData.get("billingCountry") || "") || null,
    pec: String(formData.get("pec") || "") || null,
    codiceDestinatario: String(formData.get("codiceDestinatario") || "") || null,
    reviewNotes: String(formData.get("reviewNotes") || "") || null,
  };

  if (intent === "save") {
    await db.b2BApplication.update({
      where: { id },
      data: baseData,
    });
  }

  if (intent === "approve") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        ...baseData,
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
      },
    });
  }

  if (intent === "reject") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        ...baseData,
        status: "rejected",
        rejectedAt: new Date(),
        approvedAt: null,
      },
    });
  }

  if (intent === "pending") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        ...baseData,
        status: "pending_review",
        approvedAt: null,
        rejectedAt: null,
      },
    });
  }

  return null;
}

function statusLabel(status: string) {
  if (status === "approved") return "✅ Approved";
  if (status === "rejected") return "❌ Rejected";
  return "🟡 Pending review";
}

function statusColor(status: string) {
  if (status === "approved") return "#dff3df";
  if (status === "rejected") return "#ffe1dc";
  return "#fff3cd";
}

export default function ApplicationsPage() {
  const { applications } = useLoaderData<typeof loader>();
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div style={{ padding: 24 }}>
      <h1>B2B Applications</h1>

      <p style={{ marginBottom: 24 }}>
        Review, edit, approve or reject B2B access requests.
      </p>

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
            <>
              <tr key={app.id}>
                <td style={td}>{statusLabel(app.status)}</td>
                <td style={td}>{app.companyNameSubmitted || "-"}</td>
                <td style={td}>{app.vatNumberSubmitted}</td>
                <td style={td}>{app.email}</td>
                <td style={td}>{app.matchScore ?? "-"}%</td>
                <td style={td}>{app.viesValid ? "Valid" : "Invalid"}</td>
                <td style={td}>{new Date(app.createdAt).toLocaleString()}</td>
                <td style={td}>
                  <button
                    type="button"
                    style={buttonDark}
                    onClick={() => setOpenId(openId === app.id ? null : app.id)}
                  >
                    {openId === app.id ? "Close" : "Open"}
                  </button>
                </td>
              </tr>

              {openId === app.id && (
                <tr>
                  <td colSpan={8} style={{ padding: 0 }}>
                    <div style={detailBox}>
                      <Form method="post">
                        <input type="hidden" name="id" value={app.id} />

                        <div style={statusPill(app.status)}>
                          {statusLabel(app.status)}
                        </div>

                        <div style={grid}>
                          <section style={card}>
                            <h2>Submitted data</h2>

                            <Field label="Company name">
                              <input name="companyNameSubmitted" defaultValue={app.companyNameSubmitted || ""} style={input} />
                            </Field>

                            <Field label="VAT number">
                              <input name="vatNumberSubmitted" defaultValue={app.vatNumberSubmitted || ""} style={input} />
                            </Field>

                            <Field label="Email">
                              <input name="email" defaultValue={app.email || ""} style={input} />
                            </Field>

                            <Field label="First name">
                              <input name="firstName" defaultValue={app.firstName || ""} style={input} />
                            </Field>

                            <Field label="Last name">
                              <input name="lastName" defaultValue={app.lastName || ""} style={input} />
                            </Field>

                            <Field label="Billing country">
                              <input name="billingCountry" defaultValue={app.billingCountry || ""} style={input} />
                            </Field>

                            <Field label="PEC">
                              <input name="pec" defaultValue={app.pec || ""} style={input} />
                            </Field>

                            <Field label="Codice destinatario">
                              <input name="codiceDestinatario" defaultValue={app.codiceDestinatario || ""} style={input} />
                            </Field>
                          </section>

                          <section style={card}>
                            <h2>VIES data</h2>

                            <Read label="VIES valid" value={app.viesValid ? "✅ Valid" : "❌ Invalid"} />
                            <Read label="VIES company" value={app.viesCompanyName || "-"} />
                            <Read label="VIES VAT" value={app.viesVatNumber || "-"} />
                            <Read label="VIES country" value={app.viesCountryCode || "-"} />

                            <div style={{ marginTop: 12 }}>
                              <strong>VIES address</strong>
                              <pre style={pre}>{app.viesAddress || "-"}</pre>
                            </div>

                            <Read label="Match score" value={`${app.matchScore ?? "-"}%`} />
                          </section>
                        </div>

                        <section style={{ ...card, marginTop: 16 }}>
                          <h2>Review notes</h2>
                          <textarea
                            name="reviewNotes"
                            defaultValue={app.reviewNotes || ""}
                            rows={4}
                            style={{ ...input, minHeight: 100, borderRadius: 14, paddingTop: 12 }}
                          />

                          <div style={actions}>
                            <button name="intent" value="save" style={buttonGrey}>
                              Save edits
                            </button>

                            <button name="intent" value="approve" style={buttonGreen}>
                              Approve
                            </button>

                            <button name="intent" value="pending" style={buttonYellow}>
                              Pending
                            </button>

                            <button name="intent" value="reject" style={buttonRed}>
                              Reject
                            </button>
                          </div>
                        </section>
                      </Form>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
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

const th: React.CSSProperties = {
  textAlign: "left",
  padding: 12,
  borderBottom: "1px solid #ddd",
};

const td: React.CSSProperties = {
  padding: 12,
  borderBottom: "1px solid #eee",
};

const detailBox: React.CSSProperties = {
  padding: 20,
  background: "#f6f6f6",
  borderBottom: "1px solid #ddd",
};

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
};

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e5e5",
  borderRadius: 16,
  padding: 18,
};

const input: React.CSSProperties = {
  width: "100%",
  minHeight: 42,
  border: "1px solid #ddd",
  borderRadius: 999,
  padding: "0 14px",
};

const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  background: "#f7f7f7",
  padding: 12,
  borderRadius: 12,
};

const actions: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 10,
  marginTop: 16,
};

const buttonBase: React.CSSProperties = {
  minHeight: 42,
  border: 0,
  borderRadius: 999,
  fontWeight: 800,
  cursor: "pointer",
};

const buttonDark = { ...buttonBase, background: "#303a21", color: "white", padding: "0 16px" };
const buttonGrey = { ...buttonBase, background: "#ddd", color: "#222" };
const buttonGreen = { ...buttonBase, background: "#1f7a35", color: "white" };
const buttonYellow = { ...buttonBase, background: "#c9902f", color: "white" };
const buttonRed = { ...buttonBase, background: "#9f2f1f", color: "white" };

function statusPill(status: string): React.CSSProperties {
  return {
    display: "inline-block",
    background: statusColor(status),
    padding: "7px 12px",
    borderRadius: 999,
    fontWeight: 800,
    marginBottom: 16,
  };
}