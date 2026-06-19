import { Form, useLoaderData } from "react-router";
import { useState } from "react";
import type { CSSProperties } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const MANAGED_B2B_TAGS = [
  "b2b_pending_review",
  "b2b_rejected",
  "b2b_customer",
  "b2b_auto_approved",
  "b2b_manually_approved",
  "vat_verified",
];

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const applications = await db.b2BApplication.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return { applications };
}

export async function action({ request }: any) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();

  const id = String(formData.get("id") || "");
  const intent = String(formData.get("intent") || "");

  if (!id) {
    throw new Response("Missing application id", { status: 400 });
  }

  const baseData = {
    email: String(formData.get("email") || "").trim(),
    firstName: String(formData.get("firstName") || "").trim() || null,
    lastName: String(formData.get("lastName") || "").trim() || null,
    companyNameSubmitted: String(formData.get("companyNameSubmitted") || "").trim(),
    vatNumberSubmitted: normalizeVat(String(formData.get("vatNumberSubmitted") || "")),
    billingCountry: String(formData.get("billingCountry") || "").trim() || null,
    pec: String(formData.get("pec") || "").trim() || null,
    codiceDestinatario: String(formData.get("codiceDestinatario") || "").trim() || null,
    reviewNotes: String(formData.get("reviewNotes") || "").trim() || null,
  };

  if (intent === "save") {
    await db.b2BApplication.update({
      where: { id },
      data: baseData,
    });

    return null;
  }

  if (intent === "pending") {
    const application = await db.b2BApplication.update({
      where: { id },
      data: {
        ...baseData,
        status: "pending_review",
        approvedAt: null,
        rejectedAt: null,
      },
    });

    await syncApplicationToShopify(admin, application, "pending_review");

    return null;
  }

  if (intent === "reject") {
    const application = await db.b2BApplication.update({
      where: { id },
      data: {
        ...baseData,
        status: "rejected",
        rejectedAt: new Date(),
        approvedAt: null,
      },
    });

    await syncApplicationToShopify(admin, application, "rejected");

    return null;
  }

  if (intent === "approve") {
    const application = await db.b2BApplication.update({
      where: { id },
      data: {
        ...baseData,
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
      },
    });

    const shopifyWrite = await syncApplicationToShopify(admin, application, "approved");

    await db.b2BApplication.update({
      where: { id },
      data: {
        shopifyCustomerId: shopifyWrite.customer?.id || application.shopifyCustomerId || null,
        shopifyCompanyId: shopifyWrite.company?.companyId || application.shopifyCompanyId || null,
        shopifyCompanyLocationId:
          shopifyWrite.company?.companyLocationId || application.shopifyCompanyLocationId || null,
      },
    });

    return null;
  }

  return null;
}

async function syncApplicationToShopify(admin: any, application: any, status: string) {
  let tagsToApply = ["b2b_pending_review"];

  if (status === "approved") {
    tagsToApply = ["b2b_customer", "vat_verified", "b2b_manually_approved"];
  }

  if (status === "rejected") {
    tagsToApply = ["b2b_rejected"];
  }

  const payload = {
    email: application.email,
    firstName: application.firstName || "B2B",
    lastName: application.lastName || "Customer",
    companyName: application.companyNameSubmitted,
  };

  const vies = {
    valid: application.viesValid,
    companyName: application.viesCompanyName || application.companyNameSubmitted,
    address: application.viesAddress || "",
    countryCode: application.viesCountryCode || application.billingCountry || "IT",
    vatNumber: application.viesVatNumber || application.vatNumberSubmitted,
  };

  const billingValidation = {
    billingCountry: application.billingCountry || vies.countryCode || "IT",
    pec: application.pec || "",
    codiceDestinatario: application.codiceDestinatario || "",
  };

  const metafieldsToWrite = {
    "b2b.pec": billingValidation.pec,
    "b2b.codice_destinatario": billingValidation.codiceDestinatario,
    "b2b.vat_number": normalizeVat(application.vatNumberSubmitted),
    "b2b.vies_company_name": application.viesCompanyName || "",
    "b2b.vies_address": application.viesAddress || "",
    "b2b.vies_match_score": String(application.matchScore ?? ""),
    "b2b.vies_status": application.viesValid ? "valid" : "invalid",
    "b2b.verified_at": new Date().toISOString(),
    "b2b.company_name_submitted": application.companyNameSubmitted || "",
    "b2b.billing_country": application.billingCountry || "",
  };

  let customer = await findCustomerByEmail(admin, application.email);

  if (!customer) {
    customer = await createCustomer(admin, payload, tagsToApply);
  } else {
    await syncB2BTags(admin, customer.id, customer.tags || [], tagsToApply);
  }

  const metafields = await setCustomerMetafields(admin, customer.id, metafieldsToWrite);

  let company = null;

  if (status === "approved") {
    customer = (await findCustomerByEmail(admin, application.email)) || customer;

    company = await createCompanyForApprovedCustomer({
      admin,
      customer,
      payload,
      vies,
      billingValidation,
    });
  }

  return {
    customer,
    metafields,
    company,
  };
}

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function findCustomerByEmail(admin: any, email: string) {
  const data = await graphQL(
    admin,
    `#graphql
      query FindCustomerByEmail($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            email
            tags
            companyContactProfiles {
              id
              company {
                id
                name
              }
            }
          }
        }
      }
    `,
    { query: `email:${email}` },
  );

  return data?.data?.customers?.nodes?.[0] ?? null;
}

async function createCustomer(admin: any, payload: any, tagsToApply: string[]) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer {
            id
            email
            tags
            companyContactProfiles {
              id
              company {
                id
                name
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        email: String(payload.email || "").trim(),
        firstName: payload.firstName || "B2B",
        lastName: payload.lastName || "Customer",
        note: `B2B application manual review - ${payload.companyName || ""}`,
        tags: tagsToApply,
      },
    },
  );

  const errors = data?.data?.customerCreate?.userErrors ?? [];

  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return data?.data?.customerCreate?.customer;
}

async function syncB2BTags(
  admin: any,
  customerId: string,
  existingTags: string[],
  newTags: string[],
) {
  const tagsToRemove = existingTags.filter((tag) =>
    MANAGED_B2B_TAGS.includes(tag),
  );

  if (tagsToRemove.length) {
    const removeData = await graphQL(
      admin,
      `#graphql
        mutation TagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        id: customerId,
        tags: tagsToRemove,
      },
    );

    const removeErrors = removeData?.data?.tagsRemove?.userErrors ?? [];

    if (removeErrors.length) {
      throw new Error(removeErrors.map((e: any) => e.message).join(" | "));
    }
  }

  const addData = await graphQL(
    admin,
    `#graphql
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: customerId,
      tags: newTags,
    },
  );

  const addErrors = addData?.data?.tagsAdd?.userErrors ?? [];

  if (addErrors.length) {
    throw new Error(addErrors.map((e: any) => e.message).join(" | "));
  }
}

async function setCustomerMetafields(
  admin: any,
  customerId: string,
  metafieldsToWrite: Record<string, string>,
) {
  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId: customerId,
        namespace,
        key,
        type:
          key === "vies_address"
            ? "multi_line_text_field"
            : "single_line_text_field",
        value: String(value ?? "").trim(),
      };
    });

  if (!metafields.length) return [];

  const data = await graphQL(
    admin,
    `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors ?? [];

  if (errors.length) {
    throw new Error(errors.map((e: any) => e.message).join(" | "));
  }

  return data?.data?.metafieldsSet?.metafields ?? [];
}

async function createCompanyForApprovedCustomer({
  admin,
  customer,
  payload,
  vies,
  billingValidation,
}: {
  admin: any;
  customer: any;
  payload: any;
  vies: any;
  billingValidation: any;
}) {
  const existingCompany =
    customer?.companyContactProfiles?.[0]?.company ?? null;

  if (existingCompany?.id) {
    return {
      skipped: true,
      reason: "Customer already assigned to a company.",
      companyId: existingCompany.id,
      companyName: existingCompany.name,
    };
  }

  const companyName =
    String(vies.companyName || "").trim() ||
    String(payload.companyName || "").trim();

  if (!companyName) {
    return {
      skipped: true,
      reason: "Missing company name.",
    };
  }

  const address1 =
    String(vies.address || "").split("\n")[0]?.trim() || "Address from VIES";

  const countryCode =
    billingValidation.billingCountry || vies.countryCode || "IT";

  const taxRegistrationId = normalizeVat(vies.vatNumber || "");

  const companyCreateData = await graphQL(
    admin,
    `#graphql
      mutation CompanyCreate($input: CompanyCreateInput!) {
        companyCreate(input: $input) {
          company {
            id
            name
            contactRoles(first: 10) {
              nodes {
                id
                name
              }
            }
            locations(first: 10) {
              nodes {
                id
                name
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: {
        company: {
          name: companyName,
        },
        companyLocation: {
          name: companyName,
          taxRegistrationId,
          taxExempt: false,
          billingAddress: {
            recipient: companyName,
            address1,
            city: "N/A",
            countryCode,
          },
        },
      },
    },
  );

  const companyErrors =
    companyCreateData?.data?.companyCreate?.userErrors ?? [];

  if (companyErrors.length) {
    throw new Error(companyErrors.map((e: any) => e.message).join(" | "));
  }

  const company = companyCreateData?.data?.companyCreate?.company;
  const location = company?.locations?.nodes?.[0];
  const role = company?.contactRoles?.nodes?.[0];

  if (!company?.id || !location?.id || !role?.id) {
    return {
      skipped: true,
      reason: "Company created but location or role missing.",
      companyId: company?.id,
      companyName: company?.name,
    };
  }

  const assignCustomerData = await graphQL(
    admin,
    `#graphql
      mutation AssignCustomer($companyId: ID!, $customerId: ID!) {
        companyAssignCustomerAsContact(
          companyId: $companyId
          customerId: $customerId
        ) {
          companyContact {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      companyId: company.id,
      customerId: customer.id,
    },
  );

  const assignErrors =
    assignCustomerData?.data?.companyAssignCustomerAsContact?.userErrors ?? [];

  if (assignErrors.length) {
    throw new Error(assignErrors.map((e: any) => e.message).join(" | "));
  }

  const companyContact =
    assignCustomerData?.data?.companyAssignCustomerAsContact?.companyContact;

  if (!companyContact?.id) {
    return {
      skipped: true,
      reason: "Company contact was not returned.",
      companyId: company.id,
      companyName: company.name,
      companyLocationId: location.id,
    };
  }

  const assignRoleData = await graphQL(
    admin,
    `#graphql
      mutation AssignRole(
        $companyContactId: ID!
        $companyLocationId: ID!
        $companyContactRoleId: ID!
      ) {
        companyContactAssignRole(
          companyContactId: $companyContactId
          companyLocationId: $companyLocationId
          companyContactRoleId: $companyContactRoleId
        ) {
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      companyContactId: companyContact.id,
      companyLocationId: location.id,
      companyContactRoleId: role.id,
    },
  );

  const roleErrors =
    assignRoleData?.data?.companyContactAssignRole?.userErrors ?? [];

  if (roleErrors.length) {
    throw new Error(roleErrors.map((e: any) => e.message).join(" | "));
  }

  return {
    created: true,
    companyId: company.id,
    companyName: company.name,
    companyLocationId: location.id,
    companyLocationName: location.name,
    companyContactId: companyContact.id,
    companyContactRoleId: role.id,
    companyContactRoleName: role.name,
  };
}

function normalizeVat(vatNumber: string) {
  return String(vatNumber || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.\-_/]/g, "")
    .toUpperCase();
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


function ApplicationDetailPanel({ app }: any) {
  return (
    <div style={detailBox}>
      <Form method="post">
        <input type="hidden" name="id" value={app.id} />

        <div style={statusPill(app.status)}>{statusLabel(app.status)}</div>

        <div style={grid}>
          <section style={card}>
            <h2>Submitted data</h2>

            <Field label="Company name">
              <input
                name="companyNameSubmitted"
                defaultValue={app.companyNameSubmitted || ""}
                style={input}
              />
            </Field>

            <Field label="VAT number">
              <input
                name="vatNumberSubmitted"
                defaultValue={app.vatNumberSubmitted || ""}
                style={input}
              />
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
              <input
                name="billingCountry"
                defaultValue={app.billingCountry || ""}
                style={input}
              />
            </Field>

            <Field label="PEC">
              <input name="pec" defaultValue={app.pec || ""} style={input} />
            </Field>

            <Field label="Codice destinatario">
              <input
                name="codiceDestinatario"
                defaultValue={app.codiceDestinatario || ""}
                style={input}
              />
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
          <h2>Shopify sync</h2>
          <Read label="Customer ID" value={app.shopifyCustomerId || "-"} />
          <Read label="Company ID" value={app.shopifyCompanyId || "-"} />
          <Read label="Company location ID" value={app.shopifyCompanyLocationId || "-"} />
        </section>

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
              Approve + create company
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
  );
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
                <tr key={`${app.id}-detail-row`}>
                  <td colSpan={8} style={{ padding: 0, borderBottom: "1px solid #ddd" }}>
                    <ApplicationDetailPanel app={app} />
                  </td>
                </tr>
              )}
            </>
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

const th: CSSProperties = {
  textAlign: "left",
  padding: 12,
  borderBottom: "1px solid #ddd",
};

const td: CSSProperties = {
  padding: 12,
  borderBottom: "1px solid #eee",
};

const detailBox: CSSProperties = {
  padding: 20,
  background: "#f6f6f6",
  borderBottom: "1px solid #ddd",
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
};

const card: CSSProperties = {
  background: "white",
  border: "1px solid #e5e5e5",
  borderRadius: 16,
  padding: 18,
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
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 10,
  marginTop: 16,
};

const buttonBase: CSSProperties = {
  minHeight: 42,
  border: 0,
  borderRadius: 999,
  fontWeight: 800,
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

function statusPill(status: string): CSSProperties {
  return {
    display: "inline-block",
    background: statusColor(status),
    padding: "7px 12px",
    borderRadius: 999,
    fontWeight: 800,
    marginBottom: 16,
  };
}