import { Form, Link, redirect, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request, params }: any) {
  await authenticate.admin(request);

  const application = await db.b2BApplication.findUnique({
    where: { id: params.id },
  });

  if (!application) {
    throw new Response("Application not found", { status: 404 });
  }

  return { application };
}

export async function action({ request, params }: any) {
  await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const reviewNotes = String(formData.get("reviewNotes") || "");

  if (intent === "set_pending") {
    await db.b2BApplication.update({
      where: { id: params.id },
      data: {
        status: "pending_review",
        reviewNotes,
        approvedAt: null,
        rejectedAt: null,
      },
    });
  }

  if (intent === "reject") {
    await db.b2BApplication.update({
      where: { id: params.id },
      data: {
        status: "rejected",
        reviewNotes,
        rejectedAt: new Date(),
        approvedAt: null,
      },
    });
  }

  if (intent === "approve") {
    await db.b2BApplication.update({
      where: { id: params.id },
      data: {
        status: "approved",
        reviewNotes,
        approvedAt: new Date(),
        rejectedAt: null,
      },
    });
  }

  return redirect(`/app/applications/${params.id}`);
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

function diffStyle(a?: string | null, b?: string | null) {
  const left = String(a || "").trim().toLowerCase();
  const right = String(b || "").trim().toLowerCase();

  if (!left || !right) return {};
  if (left === right) return {};

  return {
    background: "#fff3cd",
    borderRadius: 10,
    padding: "8px 10px",
  };
}

function formatDate(value?: string | Date | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export default function ApplicationDetailPage() {
  const { application } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: 24, maxWidth: 1180 }}>
      <p style={{ marginBottom: 18 }}>
        <Link to="/app/applications">← Back to applications</Link>
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ margin: 0 }}>B2B Application</h1>
        <span
          style={{
            background: statusColor(application.status),
            borderRadius: 999,
            padding: "7px 12px",
            fontWeight: 700,
          }}
        >
          {statusLabel(application.status)}
        </span>
      </div>

      <p style={{ marginTop: 8, color: "#666" }}>
        Created: {formatDate(application.createdAt)} · Updated:{" "}
        {formatDate(application.updatedAt)}
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
          marginTop: 24,
        }}
      >
        <Card title="Submitted by customer">
          <Field label="Company name">
            <div style={diffStyle(application.companyNameSubmitted, application.viesCompanyName)}>
              {application.companyNameSubmitted || "-"}
            </div>
          </Field>

          <Field label="VAT number">{application.vatNumberSubmitted || "-"}</Field>
          <Field label="Email">{application.email || "-"}</Field>
          <Field label="First name">{application.firstName || "-"}</Field>
          <Field label="Last name">{application.lastName || "-"}</Field>
          <Field label="Billing country">{application.billingCountry || "-"}</Field>
          <Field label="PEC">{application.pec || "-"}</Field>
          <Field label="Codice destinatario">
            {application.codiceDestinatario || "-"}
          </Field>
        </Card>

        <Card title="VIES result">
          <Field label="VIES valid">
            {application.viesValid ? "✅ Valid" : "❌ Invalid"}
          </Field>

          <Field label="VIES company name">
            <div style={diffStyle(application.viesCompanyName, application.companyNameSubmitted)}>
              {application.viesCompanyName || "-"}
            </div>
          </Field>

          <Field label="VIES VAT">{application.viesVatNumber || "-"}</Field>
          <Field label="VIES country">{application.viesCountryCode || "-"}</Field>

          <Field label="VIES address">
            <pre
              style={{
                whiteSpace: "pre-wrap",
                margin: 0,
                fontFamily: "inherit",
                background: "#f7f7f7",
                padding: 12,
                borderRadius: 10,
              }}
            >
              {application.viesAddress || "-"}
            </pre>
          </Field>

          <Field label="Match score">
            <strong style={{ fontSize: 22 }}>
              {application.matchScore ?? "-"}%
            </strong>
          </Field>
        </Card>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 18,
          marginTop: 18,
        }}
      >
        <Card title="Shopify sync">
          <Field label="Customer ID">{application.shopifyCustomerId || "-"}</Field>
          <Field label="Company ID">{application.shopifyCompanyId || "-"}</Field>
          <Field label="Company Location ID">
            {application.shopifyCompanyLocationId || "-"}
          </Field>
          <Field label="Approved at">{formatDate(application.approvedAt)}</Field>
          <Field label="Rejected at">{formatDate(application.rejectedAt)}</Field>
        </Card>

        <Card title="Manual review">
          <Form method="post">
            <label style={{ display: "block", marginBottom: 8, fontWeight: 700 }}>
              Review notes
            </label>

            <textarea
              name="reviewNotes"
              defaultValue={application.reviewNotes || ""}
              rows={7}
              style={{
                width: "100%",
                border: "1px solid #ddd",
                borderRadius: 12,
                padding: 12,
                fontSize: 15,
                resize: "vertical",
              }}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 10,
                marginTop: 14,
              }}
            >
              <button
                name="intent"
                value="approve"
                style={button("#1f7a35", "white")}
              >
                Approve
              </button>

              <button
                name="intent"
                value="set_pending"
                style={button("#c9902f", "white")}
              >
                Pending
              </button>

              <button
                name="intent"
                value="reject"
                style={button("#9f2f1f", "white")}
              >
                Reject
              </button>
            </div>
          </Form>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: any) {
  return (
    <section
      style={{
        background: "white",
        border: "1px solid #e5e5e5",
        borderRadius: 16,
        padding: 18,
      }}
    >
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: any) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16 }}>{children}</div>
    </div>
  );
}

function button(background: string, color: string): React.CSSProperties {
  return {
    minHeight: 44,
    border: 0,
    borderRadius: 999,
    background,
    color,
    fontWeight: 800,
    cursor: "pointer",
  };
}