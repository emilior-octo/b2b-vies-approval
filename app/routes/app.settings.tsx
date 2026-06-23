import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

type OwnerType = "CUSTOMER" | "COMPANY" | "ORDER";

type Definition = {
  ownerType: OwnerType;
  namespace: string;
  key: string;
  name: string;
  type: string;
};

type SyncResult = Definition & {
  ok: boolean;
  created: boolean;
  existing: boolean;
  error: string | null;
};

type SyncResponse = {
  ok: boolean;
  results: SyncResult[];
  created: number;
  existing: number;
  failed: number;
  error?: string;
};

const DEFINITIONS: Definition[] = [
  // Customer fiscal fields used by invoice requests / checkout fiscal data.
  { ownerType: "CUSTOMER", namespace: "custom", key: "fiscal_code", name: "Fiscal code", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "custom", key: "pec", name: "PEC", type: "single_line_text_field" },
  { ownerType: "CUSTOMER", namespace: "custom", key: "sdi", name: "SDI", type: "single_line_text_field" },

  // Customer B2B fields written by the B2B form flow.
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

  // Company B2B fields written by the B2B form flow.
  { ownerType: "COMPANY", namespace: "b2b", key: "vat_number", name: "B2B VAT number", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "billing_country", name: "B2B billing country", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "company_name_submitted", name: "B2B submitted company", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "vies_company_name", name: "B2B VIES company", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "vies_address", name: "B2B VIES address", type: "multi_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "vies_status", name: "B2B VIES status", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "pec", name: "B2B PEC", type: "single_line_text_field" },
  { ownerType: "COMPANY", namespace: "b2b", key: "codice_destinatario", name: "B2B codice destinatario", type: "single_line_text_field" },

  // Order invoice fields, used by cart invoice requests and checkout fiscal fields.
  { ownerType: "ORDER", namespace: "invoice", key: "source", name: "Invoice source", type: "single_line_text_field" },
  { ownerType: "ORDER", namespace: "invoice", key: "request_id", name: "Invoice request ID", type: "single_line_text_field" },
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

  // Order B2B fields, copied from true B2B customer/company data.
  { ownerType: "ORDER", namespace: "b2b", key: "is_b2b", name: "B2B order", type: "single_line_text_field" },
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

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch (_error) {
    return String(error);
  }
}

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  const data = await response.json();

  if (data?.errors) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data;
}

async function existingDefinitionId(admin: any, definition: Definition) {
  const data = await graphQL(
    admin,
    `#graphql
      query ExistingMetafieldDefinition(
        $ownerType: MetafieldOwnerType!
        $namespace: String!
        $key: String!
      ) {
        metafieldDefinitions(
          first: 1
          ownerType: $ownerType
          namespace: $namespace
          key: $key
        ) {
          nodes {
            id
          }
        }
      }
    `,
    {
      ownerType: definition.ownerType,
      namespace: definition.namespace,
      key: definition.key,
    },
  );

  return data?.data?.metafieldDefinitions?.nodes?.[0]?.id || "";
}

async function createDefinition(admin: any, definition: Definition): Promise<SyncResult> {
  try {
    const existingId = await existingDefinitionId(admin, definition);

    if (existingId) {
      return {
        ...definition,
        ok: true,
        created: false,
        existing: true,
        error: null,
      };
    }

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
      const alreadyExists = errors.some((error: any) => {
        const message = String(error?.message || "").toLowerCase();
        const code = String(error?.code || "").toLowerCase();
        return message.includes("already exists") || message.includes("taken") || code.includes("taken");
      });

      return {
        ...definition,
        ok: alreadyExists,
        created: false,
        existing: alreadyExists,
        error: alreadyExists ? null : errors.map((error: any) => error.message).join(" | "),
      };
    }

    return {
      ...definition,
      ok: true,
      created: true,
      existing: false,
      error: null,
    };
  } catch (error) {
    return {
      ...definition,
      ok: false,
      created: false,
      existing: false,
      error: errorMessage(error),
    };
  }
}

export async function loader({ request }: any) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }: any) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "sync_metafields");

  if (intent !== "sync_metafields") {
    return json({ ok: false, error: "Invalid action" }, 400);
  }

  const results: SyncResult[] = [];

  for (const definition of DEFINITIONS) {
    results.push(await createDefinition(admin, definition));
  }

  const response: SyncResponse = {
    ok: results.every((result) => result.ok),
    results,
    created: results.filter((result) => result.created).length,
    existing: results.filter((result) => result.existing).length,
    failed: results.filter((result) => !result.ok).length,
  };

  return json(response, response.ok ? 200 : 207);
}

export default function SettingsPage() {
  const fetcher = useFetcher<SyncResponse>();
  const actionData = fetcher.data;
  const isSubmitting = fetcher.state !== "idle";

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

        <fetcher.Form method="post">
          <button style={button} type="submit" name="intent" value="sync_metafields" disabled={isSubmitting}>
            {isSubmitting ? "Syncing..." : "Sync metafield definitions"}
          </button>
        </fetcher.Form>

        {actionData && (
          <div style={resultBox}>
            <strong>{actionData.ok ? "Sync completed" : "Sync completed with errors"}</strong>
            <p>
              Created: {actionData.created} · Existing: {actionData.existing} · Failed: {actionData.failed}
            </p>

            {actionData.error && <p style={error}>{actionData.error}</p>}

            <div style={list}>
              {actionData.results.map((item: SyncResult) => (
                <div key={`${item.ownerType}-${item.namespace}-${item.key}`} style={row}>
                  <span>
                    {item.ownerType} · {item.namespace}.{item.key}
                  </span>
                  <strong>
                    {item.ok ? (item.existing ? "Existing" : "Created") : "Failed"}
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
