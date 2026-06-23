import { Form, useActionData } from "react-router";
import { authenticate } from "../shopify.server";

type Definition = {
  ownerType: "CUSTOMER" | "COMPANY" | "ORDER";
  namespace: string;
  key: string;
  name: string;
  type: string;
};

const DEFINITIONS: Definition[] = [
  { ownerType: "CUSTOMER", namespace: "custom", key: "fiscal_code", name: "Fiscal code", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "custom", key: "pec", name: "PEC", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "custom", key: "sdi", name: "SDI", type: "single_line_text_field" },

  { ownerType: "CUSTOMER", namespace: "b2b", key: "vat_number", name: "B2B VAT number", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "billing_country", name: "B2B billing country", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "company_name_submitted", name: "B2B submitted company", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "vies_company_name", name: "B2B VIES company", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "vies_address", name: "B2B VIES address", type: "multi_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "vies_status", name: "B2B VIES status", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "vies_match_score", name: "B2B VIES match score", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "pec", name: "B2B PEC", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "codice_destinatario", name: "B2B codice destinatario", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "company_id", name: "B2B Company ID", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "b2b", key: "company_location_id", name: "B2B Company Location ID", type: "single_line_text_field" },

  { ownerType: "COMPANY", namespace: "b2b", key: "vat_number", name: "B2B VAT number", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "billing_country", name: "B2B billing country", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "company_name_submitted", name: "B2B submitted company", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "vies_company_name", name: "B2B VIES company", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "vies_address", name: "B2B VIES address", type: "multi_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "vies_status", name: "B2B VIES status", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "pec", name: "B2B PEC", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "codice_destinatario", name: "B2B codice destinatario", type: "single_line_text_field" },

  { ownerType: "ORDER", namespace: "invoice", key: "request_id", name: "Invoice request ID", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "source", name: "Invoice source", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "invoice_type", name: "Invoice type", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "company_name", name: "Invoice company name", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "vat_number", name: "Invoice VAT number", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "billing_country", name: "Invoice billing country", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "fiscal_code", name: "Invoice fiscal code", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "pec", name: "Invoice PEC", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "codice_destinatario", name: "Invoice codice destinatario", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "vies_checked", name: "Invoice VIES checked", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "vies_valid", name: "Invoice VIES valid", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "vies_company_name", name: "Invoice VIES company name", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "vies_address", name: "Invoice VIES address", type: "multi_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "needs_manual_review", name: "Invoice needs manual review", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "reverse_charge", name: "Invoice reverse charge", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "tax_exempt_applied", name: "Invoice tax exempt applied", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "fiscal_note", name: "Invoice fiscal note", type: "multi_line_text_field" },

  { ownerType: "ORDER", namespace: "b2b", key: "is_b2b", name: "B2B order flag", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "source", name: "B2B source", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "company_id", name: "B2B Company ID", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "company_location_id", name: "B2B Company Location ID", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "vat_number", name: "B2B VAT number", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "billing_country", name: "B2B billing country", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "company_name_submitted", name: "B2B submitted company", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "vies_company_name", name: "B2B VIES company", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "vies_address", name: "B2B VIES address", type: "multi_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "pec", name: "B2B PEC", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "codice_destinatario", name: "B2B codice destinatario", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "vies_status", name: "B2B VIES status", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "vies_match_score", name: "B2B VIES match score", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "reverse_charge", name: "B2B reverse charge", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "tax_exempt", name: "B2B tax exempt", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "b2b", key: "fiscal_note", name: "B2B fiscal note", type: "multi_line_text_field" },
];

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function createDefinition(admin: any, definition: Definition) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
            namespace
            key
            ownerType
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
    
      definition: {
        name: definition.name,
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        ownerType: definition.ownerType,
      },
    },
  );

  const errors = data?.data?.metafieldDefinitionCreate?.userErrors || [];

  if (errors.length) {
    const alreadyExists = errors.some((e: any) =>
      String(e.message || "").toLowerCase().includes("already exists"),
    );

    return {
      ...definition,
      ok: alreadyExists,
      skipped: alreadyExists,
      error: alreadyExists ? null : errors.map((e: any) => e.message).join(" | "),
    };
  }

  return {
    ...definition,
    ok: true,
    skipped: false,
    error: null,
  };
}

export async function loader({ request }: any) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }: any) {
  const { admin } = await authenticate.admin(request);

  const results = [];

  for (const definition of DEFINITIONS) {
    results.push(await createDefinition(admin, definition));
  }

  return {
    ok: true,
    results,
    created: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
  };
}

export default function SettingsPage() {
  const actionData = useActionData<typeof action>();

  return (
    <div style={page}>
      <section style={hero}>
        <div>
          <div style={eyebrow}>Zig Business Engine</div>
          <h1 style={title}>Settings</h1>
          <p style={subtitle}>
            Sync metafield definitions for customers, companies and orders.
          </p>
        </div>
        <div style={icon}>⚙️</div>
      </section>

      <section style={card}>
        <h2>Metafield definitions</h2>
        <p>
          Create or sync the metafield definitions used by B2B approvals,
          invoice requests and order fiscal notes.
        </p>

        <Form method="post">
          <button style={button} type="submit">
            Sync metafield definitions
          </button>
        </Form>

        {actionData && (
          <div style={resultBox}>
            <strong>Sync completed</strong>
            <p>
              Created: {actionData.created} · Existing: {actionData.skipped} ·
              Failed: {actionData.failed}
            </p>

            <div style={list}>
              {actionData.results.map((item: any) => (
                <div key={`${item.ownerType}-${item.namespace}-${item.key}`} style={row}>
                  <span>
                    {item.ownerType} · {item.namespace}.{item.key}
                  </span>
                  <strong>
                    {item.ok ? (item.skipped ? "Existing" : "OK") : "Failed"}
                  </strong>
                  {item.error && <small style={error}>{item.error}</small>}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

const page: React.CSSProperties = {
  padding: 24,
  background: "#f5f1df",
  minHeight: "100vh",
  color: "#394122",
};

const hero: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 24,
  alignItems: "center",
  background: "linear-gradient(135deg, #aec58b 0%, #f5f1df 66%, #ffd44d 100%)",
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
  fontSize: "clamp(42px, 6vw, 72px)",
  lineHeight: ".92",
  fontWeight: 950,
};

const subtitle: React.CSSProperties = {
  maxWidth: 760,
  fontSize: 18,
  lineHeight: 1.45,
  marginTop: 18,
};

const icon: React.CSSProperties = {
  fontSize: 72,
  background: "rgba(248,243,223,.78)",
  width: 150,
  height: 150,
  borderRadius: 34,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const card: React.CSSProperties = {
  background: "white",
  borderRadius: 28,
  padding: 24,
  marginTop: 20,
  boxShadow: "0 12px 30px rgba(57,65,34,.08)",
};

const button: React.CSSProperties = {
  minHeight: 46,
  padding: "0 20px",
  border: 0,
  borderRadius: 999,
  background: "#394122",
  color: "white",
  fontWeight: 900,
  cursor: "pointer",
};

const resultBox: React.CSSProperties = {
  marginTop: 22,
  background: "#f7f2df",
  borderRadius: 18,
  padding: 18,
};

const list: React.CSSProperties = {
  display: "grid",
  gap: 8,
  marginTop: 12,
};

const row: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 10,
  background: "white",
  borderRadius: 12,
  padding: 12,
};

const error: React.CSSProperties = {
  gridColumn: "1 / -1",
  color: "#9f2f1f",
};