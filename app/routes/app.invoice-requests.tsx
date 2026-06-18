import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const invoiceRequests = await db.invoiceRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
  });

  const [total, registered, pending, completed, rejected, reverseCharge] =
    await Promise.all([
      db.invoiceRequest.count(),
      db.invoiceRequest.count({ where: { status: "registered" } }),
      db.invoiceRequest.count({ where: { status: "pending_review" } }),
      db.invoiceRequest.count({ where: { status: "completed" } }),
      db.invoiceRequest.count({ where: { status: "rejected" } }),
      db.invoiceRequest.count({ where: { reverseCharge: true } }),
    ]);

  return {
    invoiceRequests,
    stats: {
      total,
      registered,
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
    throw new Response("Missing invoice request id", { status: 400 });
  }

  const baseData = {
    invoiceType: String(formData.get("invoiceType") || "private"),
    email: emptyToNull(formData.get("email")),
    firstName: emptyToNull(formData.get("firstName")),
    lastName: emptyToNull(formData.get("lastName")),
    companyName: emptyToNull(formData.get("companyName")),
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

  if (intent === "registered") {
    await db.invoiceRequest.update({
      where: { id },
      data: {
        ...baseData,
        status: "registered",
      },
    });

    return null;
  }

  if (intent === "pending") {
    await db.invoiceRequest.update({
      where: { id },
      data: {
        ...baseData,
        status: "pending_review",
      },
    });

    return null;
  }

  if (intent === "completed") {
    await db.invoiceRequest.update({
      where: { id },
      data: {
        ...baseData,
        status: "completed",
      },
    });

    return null;
  }

  if (intent === "reject") {
    await db.invoiceRequest.update({
      where: { id },
      data: {
        ...baseData,
        status: "rejected",
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
  if (status === "completed") return "✅ Completed";
  if (status === "rejected") return "❌ Rejected";
  if (status === "pending_review") return "🟡 Manual review";
  return "🟢 Registered";
}

function statusColor(status: string) {
  if (status === "completed") return "#dff3df";
  if (status === "rejected") return "#ffe1dc";
  if (status === "pending_review") return "#fff3cd";
  return "#e5f0ff";
}

function invoiceTypeLabel(type: string) {
  if (type === "company") return "Company";
  return "Private";
}

export default function InvoiceRequestsPage() {
  const { invoiceRequests, stats } = useLoaderData<typeof loader>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return invoiceRequests.filter((item) => {
      const matchesStatus =
        statusFilter === "all" || item.status === statusFilter;

      const haystack = [
        item.email,
        item.companyName,
        item.vatNumber,
        item.billingCountry,
        item.orderName,
        item.viesCompanyName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesQuery = !q || haystack.includes(q);

      return matchesStatus && matchesQuery;
    });
  }, [invoiceRequests, query, statusFilter]);

  return (
    <div style={page}>
      <section style={hero}>
        <div>
          <div style={eyebrow}>Zig Business Engine</div>
          <h1 style={title}>Invoice Requests</h1>
          <p style={subtitle}>
            Gestisci richieste fattura, dati fiscali, VIES, reverse charge,
            customer tax exempt e collegamento ordine.
          </p>
        </div>

        <div style={heroIcon}>🧾</div>
      </section>

      <section style={statsGrid}>
        <Stat label="Totale" value={stats.total} />
        <Stat label="Registered" value={stats.registered} tone="info" />
        <Stat label="Manual review" value={stats.pending} tone="warning" />
        <Stat label="Completed" value={stats.completed} tone="success" />
        <Stat label="Rejected" value={stats.rejected} tone="danger" />
        <Stat label="Reverse charge" value={stats.reverseCharge} tone="success" />
      </section>

      <section style={toolbar}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search email, company, VAT, order..."
          style={searchInput}
        />

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          style={select}
        >
          <option value="all">All statuses</option>
          <option value="registered">Registered</option>
          <option value="pending_review">Manual review</option>
          <option value="completed">Completed</option>
          <option value="rejected">Rejected</option>
        </select>
      </section>

      <section style={list}>
        {filtered.map((item) => (
          <article key={item.id} style={requestCard}>
            <div style={summaryGrid}>
              <div>
                <span style={badge(item.status)}>{statusLabel(item.status)}</span>
                <span style={typeBadge}>{invoiceTypeLabel(item.invoiceType)}</span>
              </div>

              <div>
                <strong>{item.companyName || item.email || "Invoice request"}</strong>
                <div style={muted}>{item.vatNumber || "-"}</div>
              </div>

              <div>
                <strong>{item.email || "-"}</strong>
                <div style={muted}>{item.billingCountry || "-"}</div>
              </div>

              <div>
                <strong>{item.reverseCharge ? "Reverse charge ✅" : "Reverse charge —"}</strong>
                <div style={muted}>
                  Tax exempt {item.taxExemptApplied ? "✅" : "—"}
                </div>
              </div>

              <div>
                <strong>{item.orderName || "No order yet"}</strong>
                <div style={muted}>{new Date(item.createdAt).toLocaleString()}</div>
              </div>

              <button
                type="button"
                style={buttonDark}
                onClick={() => setOpenId(openId === item.id ? null : item.id)}
              >
                {openId === item.id ? "Close" : "Open"}
              </button>
            </div>

            {openId === item.id && (
              <div style={detailBox}>
                <Form method="post">
                  <input type="hidden" name="id" value={item.id} />

                  <div style={detailGrid}>
                    <section style={card}>
                      <h2>Customer</h2>

                      <Field label="Email">
                        <input name="email" defaultValue={item.email || ""} style={input} />
                      </Field>

                      <Field label="First name">
                        <input
                          name="firstName"
                          defaultValue={item.firstName || ""}
                          style={input}
                        />
                      </Field>

                      <Field label="Last name">
                        <input
                          name="lastName"
                          defaultValue={item.lastName || ""}
                          style={input}
                        />
                      </Field>

                      <Field label="Customer ID">
                        <input
                          name="customerId"
                          defaultValue={item.customerId || ""}
                          style={input}
                        />
                      </Field>
                    </section>

                    <section style={card}>
                      <h2>Invoice data</h2>

                      <Field label="Invoice type">
                        <select
                          name="invoiceType"
                          defaultValue={item.invoiceType || "private"}
                          style={input}
                        >
                          <option value="private">Private</option>
                          <option value="company">Company</option>
                        </select>
                      </Field>

                      <Field label="Company name">
                        <input
                          name="companyName"
                          defaultValue={item.companyName || ""}
                          style={input}
                        />
                      </Field>

                      <Field label="VAT number">
                        <input
                          name="vatNumber"
                          defaultValue={item.vatNumber || ""}
                          style={input}
                        />
                      </Field>

                      <Field label="Billing country">
                        <input
                          name="billingCountry"
                          defaultValue={item.billingCountry || ""}
                          style={input}
                        />
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
                      <h2>VIES / Tax</h2>

                      <Read label="VIES checked" value={item.viesChecked ? "Yes" : "No"} />
                      <Read label="VIES valid" value={item.viesValid ? "✅ Valid" : "—"} />
                      <Read label="VIES company" value={item.viesCompanyName || "-"} />

                      <div style={{ marginTop: 12 }}>
                        <strong>VIES address</strong>
                        <pre style={pre}>{item.viesAddress || "-"}</pre>
                      </div>

                      <Read
                        label="Reverse charge"
                        value={item.reverseCharge ? "✅ Yes" : "—"}
                      />
                      <Read
                        label="Tax exempt applied"
                        value={item.taxExemptApplied ? "✅ Yes" : "—"}
                      />
                    </section>

                    <section style={card}>
                      <h2>Order / Tokens</h2>

                      <Field label="Order ID">
                        <input name="orderId" defaultValue={item.orderId || ""} style={input} />
                      </Field>

                      <Field label="Order name">
                        <input
                          name="orderName"
                          defaultValue={item.orderName || ""}
                          style={input}
                        />
                      </Field>

                      <Field label="Checkout token">
                        <input
                          name="checkoutToken"
                          defaultValue={item.checkoutToken || ""}
                          style={input}
                        />
                      </Field>

                      <Read label="Cart token" value={item.cartToken || "-"} />
                      <Read label="Created" value={new Date(item.createdAt).toLocaleString()} />
                      <Read label="Updated" value={new Date(item.updatedAt).toLocaleString()} />
                    </section>
                  </div>

                  <section style={{ ...card, marginTop: 16 }}>
                    <h2>Actions</h2>

                    <div style={actions}>
                      <button name="intent" value="save" style={buttonGrey}>
                        Save edits
                      </button>

                      <button name="intent" value="registered" style={buttonBlue}>
                        Registered
                      </button>

                      <button name="intent" value="pending" style={buttonYellow}>
                        Manual review
                      </button>

                      <button name="intent" value="completed" style={buttonGreen}>
                        Completed
                      </button>

                      <button name="intent" value="reject" style={buttonRed}>
                        Reject
                      </button>
                    </div>
                  </section>
                </Form>
              </div>
            )}
          </article>
        ))}

        {!filtered.length && (
          <div style={emptyState}>Nessuna richiesta fattura trovata.</div>
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
  fontSize: 82,
  background: "rgba(248,243,223,.78)",
  width: 160,
  height: 160,
  borderRadius: 34,
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
  fontSize: 34,
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
  gridTemplateColumns: "170px 1.2fr 1.2fr 1fr 1fr auto",
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
  };
}

const typeBadge: CSSProperties = {
  display: "inline-flex",
  background: "rgba(57,65,34,.08)",
  borderRadius: 999,
  padding: "7px 11px",
  fontWeight: 900,
  fontSize: 13,
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
};

const pre: CSSProperties = {
  whiteSpace: "pre-wrap",
  background: "#f7f7f7",
  padding: 12,
  borderRadius: 12,
};

const actions: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, 1fr)",
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

const emptyState: CSSProperties = {
  background: "white",
  borderRadius: 24,
  padding: 28,
  textAlign: "center",
  color: "rgba(57,65,34,.7)",
};