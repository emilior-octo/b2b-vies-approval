import { Form, useLoaderData } from "react-router";
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function loader({ request }: any) {
  await authenticate.admin(request);

  const applications = await db.b2BApplication.findMany({
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  const stats = {
    total: applications.length,
    pending: applications.filter((item) => item.status === "pending_review").length,
    approved: applications.filter((item) => item.status === "approved").length,
    rejected: applications.filter((item) => item.status === "rejected").length,
    pendingSynced: applications.filter(
      (item) => item.status === "pending_review" && item.shopifyCompanyId,
    ).length,
    approvedUnsynced: applications.filter(
      (item) => item.status === "approved" && !item.shopifyCompanyId,
    ).length,
  };

  return { applications, stats };
}

function appendNote(current: string | null | undefined, note: string) {
  const existing = String(current || "").trim();
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing}\n${note}`;
}


const MANAGED_B2B_TAGS = [
  "b2b_pending_review",
  "b2b_rejected",
  "b2b_customer",
  "b2b_auto_approved",
  "vat_verified",
  "b2b_manual_approved",
];

function cleanText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || null;
}

function cleanUpper(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return text || null;
}

function cleanMatchScore(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cleanViesValid(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (text === "true") return true;
  if (text === "false") return false;
  return null;
}

function normalizeCountry(country: string | null | undefined) {
  const value = String(country || "").trim().toUpperCase();
  if (["IT", "ITA", "ITALIA", "ITALY"].includes(value)) return "IT";
  return value;
}

function normalizeVat(vatNumber: string | null | undefined) {
  return String(vatNumber || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[.\-_/]/g, "")
    .toUpperCase();
}

function normalizeVatForCountry(vatNumber: string | null | undefined, billingCountry?: string | null) {
  let raw = normalizeVat(vatNumber);
  const country = normalizeCountry(billingCountry || "");

  if (!raw) return raw;

  const hasCountryPrefix = /^[A-Z]{2}/.test(raw);

  if (!hasCountryPrefix && country) {
    raw = `${country}${raw}`;
  }

  if (country === "AT") {
    if (/^ATU/.test(raw)) return raw;
    if (/^AT/.test(raw)) return `ATU${raw.slice(2).replace(/^U/, "")}`;
    if (/^U/.test(raw)) return `AT${raw}`;
    return `ATU${raw}`;
  }

  return raw;
}

function cleanViesValue(value: string | null | undefined) {
  const text = String(value || "").trim();
  if (!text || text === "---" || text === "--" || text === "-") return "";
  return text;
}

function firstLine(value: string | null | undefined) {
  return cleanViesValue(value).split("\n").map((line) => line.trim()).find(Boolean) || "";
}

async function graphQL(admin: any, query: string, variables: any = {}) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function findCustomerById(admin: any, id: string | null | undefined) {
  if (!id) return null;

  const data = await graphQL(
    admin,
    `#graphql
      query FindCustomerById($id: ID!) {
        customer(id: $id) {
          id
          email
          tags
          companyContactProfiles {
            id
            company {
              id
              name
              locations(first: 1) {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { id },
  );

  return data?.data?.customer ?? null;
}

async function findCustomerByEmail(admin: any, email: string) {
  if (!email) return null;

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
                locations(first: 1) {
                  nodes {
                    id
                    name
                  }
                }
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

async function createCustomer(admin: any, input: any, tagsToApply: string[]) {
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
                locations(first: 1) {
                  nodes {
                    id
                    name
                  }
                }
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
        email: input.email,
        firstName: input.firstName || "B2B",
        lastName: input.lastName || "Customer",
        note: `B2B application - ${input.companyName || ""}`,
        tags: tagsToApply,
      },
    },
  );

  const errors = data?.data?.customerCreate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((error: any) => error.message).join(" | "));
  }

  return data?.data?.customerCreate?.customer ?? null;
}

async function syncB2BTags(admin: any, customerId: string, existingTags: string[], newTags: string[]) {
  const tagsToRemove = existingTags.filter((tag) => MANAGED_B2B_TAGS.includes(tag));

  if (tagsToRemove.length) {
    const removeData = await graphQL(
      admin,
      `#graphql
        mutation TagsRemove($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) {
            userErrors { field message }
          }
        }
      `,
      { id: customerId, tags: tagsToRemove },
    );

    const removeErrors = removeData?.data?.tagsRemove?.userErrors ?? [];
    if (removeErrors.length) {
      throw new Error(removeErrors.map((error: any) => error.message).join(" | "));
    }
  }

  const addData = await graphQL(
    admin,
    `#graphql
      mutation TagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors { field message }
        }
      }
    `,
    { id: customerId, tags: newTags },
  );

  const addErrors = addData?.data?.tagsAdd?.userErrors ?? [];
  if (addErrors.length) {
    throw new Error(addErrors.map((error: any) => error.message).join(" | "));
  }
}

async function updateCustomerTaxExempt(admin: any, customerId: string, taxExempt: boolean) {
  const data = await graphQL(
    admin,
    `#graphql
      mutation CustomerUpdateTaxExempt($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id email taxExempt tags }
          userErrors { field message }
        }
      }
    `,
    { input: { id: customerId, taxExempt } },
  );

  const errors = data?.data?.customerUpdate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((error: any) => error.message).join(" | "));
  }

  return data?.data?.customerUpdate?.customer ?? null;
}

async function setCustomerMetafields(admin: any, customerId: string, metafieldsToWrite: Record<string, string>) {
  const metafields = Object.entries(metafieldsToWrite)
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([fullKey, value]) => {
      const [namespace, key] = fullKey.split(".");

      return {
        ownerId: customerId,
        namespace,
        key,
        type: key === "vies_address" ? "multi_line_text_field" : "single_line_text_field",
        value: String(value ?? "").trim(),
      };
    });

  if (!metafields.length) return [];

  const data = await graphQL(
    admin,
    `#graphql
      mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key value }
          userErrors { field message }
        }
      }
    `,
    { metafields },
  );

  const errors = data?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) {
    throw new Error(errors.map((error: any) => error.message).join(" | "));
  }

  return data?.data?.metafieldsSet?.metafields ?? [];
}

function buildApplicationPayload(application: any) {
  const companyName =
    cleanViesValue(application.viesCompanyName) ||
    cleanViesValue(application.companyNameSubmitted) ||
    cleanViesValue(`${application.firstName || ""} ${application.lastName || ""}`) ||
    cleanViesValue(String(application.email || "").split("@")[0]) ||
    cleanViesValue(application.vatNumberSubmitted) ||
    "Azienda B2B";

  const billingCountry =
    normalizeCountry(application.billingCountry) ||
    normalizeCountry(application.viesCountryCode) ||
    normalizeCountry(normalizeVat(application.vatNumberSubmitted).slice(0, 2)) ||
    "IT";

  const vatNumber = normalizeVatForCountry(
    application.viesVatNumber || application.vatNumberSubmitted,
    billingCountry,
  );

  return {
    email: String(application.email || "").trim(),
    firstName: cleanViesValue(application.firstName) || "B2B",
    lastName: cleanViesValue(application.lastName) || "Customer",
    companyName,
    billingCountry,
    vatNumber,
    pec: cleanViesValue(application.pec),
    codiceDestinatario: cleanViesValue(application.codiceDestinatario),
    viesCompanyName: cleanViesValue(application.viesCompanyName) || companyName,
    viesAddress: cleanViesValue(application.viesAddress),
    viesCountryCode: normalizeCountry(application.viesCountryCode) || billingCountry,
    viesVatNumber: normalizeVat(application.viesVatNumber) || vatNumber,
    matchScore:
      application.matchScore === null || application.matchScore === undefined
        ? ""
        : String(application.matchScore),
    viesStatus:
      application.viesValid === true
        ? "valid_manual_approved"
        : application.viesValid === false
          ? "invalid_manual_approved"
          : "manual_approved",
  };
}

async function createCompanyForCustomer(admin: any, customer: any, input: any) {
  const existingCompany = customer?.companyContactProfiles?.[0]?.company ?? null;
  const existingLocation = existingCompany?.locations?.nodes?.[0] ?? null;

  if (existingCompany?.id) {
    return {
      skipped: true,
      reason: "Customer already assigned to a company.",
      companyId: existingCompany.id,
      companyName: existingCompany.name,
      companyLocationId: existingLocation?.id || null,
    };
  }

  const companyName = input.companyName || "Azienda B2B";
  const address1 = firstLine(input.viesAddress) || "Indirizzo non disponibile da VIES";

  async function runCompanyCreate(includeTaxRegistrationId: boolean) {
    const companyLocation: any = {
      name: companyName,
      taxExempt: input.billingCountry !== "IT",
      billingAddress: {
        recipient: companyName,
        address1,
        city: "N/A",
        countryCode: input.billingCountry || "IT",
      },
    };

    if (includeTaxRegistrationId && input.vatNumber) {
      companyLocation.taxRegistrationId = input.vatNumber;
    }

    return graphQL(
      admin,
      `#graphql
        mutation CompanyCreate($input: CompanyCreateInput!) {
          companyCreate(input: $input) {
            company {
              id
              name
              contactRoles(first: 10) { nodes { id name } }
              locations(first: 10) { nodes { id name } }
            }
            userErrors { field message }
          }
        }
      `,
      {
        input: {
          company: {
            name: companyName,
          },
          companyLocation,
        },
      },
    );
  }

  let companyCreateData = await runCompanyCreate(Boolean(input.vatNumber));
  let companyErrors = companyCreateData?.data?.companyCreate?.userErrors ?? [];

  if (companyErrors.length && input.vatNumber) {
    companyCreateData = await runCompanyCreate(false);
    companyErrors = companyCreateData?.data?.companyCreate?.userErrors ?? [];
  }

  if (companyErrors.length) {
    throw new Error(companyErrors.map((error: any) => error.message).join(" | "));
  }

  const company = companyCreateData?.data?.companyCreate?.company;
  const location = company?.locations?.nodes?.[0];
  const role = company?.contactRoles?.nodes?.[0];

  if (!company?.id || !location?.id || !role?.id) {
    return {
      skipped: true,
      reason: "Company created but location or role missing.",
      companyId: company?.id || null,
      companyName: company?.name || companyName,
      companyLocationId: location?.id || null,
    };
  }

  const assignCustomerData = await graphQL(
    admin,
    `#graphql
      mutation AssignCustomer($companyId: ID!, $customerId: ID!) {
        companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
          companyContact { id }
          userErrors { field message }
        }
      }
    `,
    { companyId: company.id, customerId: customer.id },
  );

  const assignErrors = assignCustomerData?.data?.companyAssignCustomerAsContact?.userErrors ?? [];
  if (assignErrors.length) {
    throw new Error(assignErrors.map((error: any) => error.message).join(" | "));
  }

  const companyContact = assignCustomerData?.data?.companyAssignCustomerAsContact?.companyContact;

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
      mutation AssignRole($companyContactId: ID!, $companyLocationId: ID!, $companyContactRoleId: ID!) {
        companyContactAssignRole(
          companyContactId: $companyContactId
          companyLocationId: $companyLocationId
          companyContactRoleId: $companyContactRoleId
        ) {
          userErrors { field message }
        }
      }
    `,
    {
      companyContactId: companyContact.id,
      companyLocationId: location.id,
      companyContactRoleId: role.id,
    },
  );

  const roleErrors = assignRoleData?.data?.companyContactAssignRole?.userErrors ?? [];
  if (roleErrors.length) {
    throw new Error(roleErrors.map((error: any) => error.message).join(" | "));
  }

  return {
    created: true,
    companyId: company.id,
    companyName: company.name,
    companyLocationId: location.id,
  };
}

async function approveAndSyncApplication(admin: any, application: any, note: string) {
  const input = buildApplicationPayload(application);

  if (!input.email) {
    throw new Error("Impossibile creare customer/company: email mancante nella richiesta B2B.");
  }

  const tagsToApply = [
    "b2b_customer",
    "b2b_manual_approved",
    ...(application.viesValid === true ? ["vat_verified"] : []),
  ];

  let customer =
    (await findCustomerById(admin, application.shopifyCustomerId)) ||
    (await findCustomerByEmail(admin, input.email));

  if (!customer) {
    customer = await createCustomer(admin, input, tagsToApply);
  } else {
    await syncB2BTags(admin, customer.id, customer.tags || [], tagsToApply);
  }

  if (!customer?.id) {
    throw new Error("Customer Shopify non creato/trovato.");
  }

  if (input.billingCountry !== "IT") {
    const taxExemptCustomer = await updateCustomerTaxExempt(admin, customer.id, true);
    customer = taxExemptCustomer ? { ...customer, ...taxExemptCustomer } : customer;
  }

  await setCustomerMetafields(admin, customer.id, {
    "b2b.pec": input.pec,
    "b2b.codice_destinatario": input.codiceDestinatario,
    "b2b.vat_number": input.vatNumber,
    "b2b.vies_company_name": input.viesCompanyName,
    "b2b.vies_address": input.viesAddress,
    "b2b.vies_match_score": input.matchScore,
    "b2b.vies_status": input.viesStatus,
    "b2b.verified_at": new Date().toISOString(),
    "b2b.company_name_submitted": application.companyNameSubmitted || input.companyName,
    "b2b.billing_country": input.billingCountry,
  });

  const refreshedCustomer = (await findCustomerByEmail(admin, input.email)) || customer;
  const company = application.shopifyCompanyId
    ? {
        skipped: true,
        reason: "Company già salvata nell'app.",
        companyId: application.shopifyCompanyId,
        companyLocationId: application.shopifyCompanyLocationId,
      }
    : await createCompanyForCustomer(admin, refreshedCustomer, input);

  await db.b2BApplication.update({
    where: { id: application.id },
    data: {
      status: "approved",
      approvedAt: new Date(),
      rejectedAt: null,
      shopifyCustomerId: customer.id,
      shopifyCompanyId: company?.companyId || application.shopifyCompanyId || null,
      shopifyCompanyLocationId:
        company?.companyLocationId || application.shopifyCompanyLocationId || null,
      reviewNotes: appendNote(application.reviewNotes, note),
    },
  });

  return { customer, company };
}

async function bulkApproveAndSync(admin: any, where: any, note: string) {
  const applications = await db.b2BApplication.findMany({ where, take: 250 });

  for (const application of applications) {
    try {
      await approveAndSyncApplication(admin, application, note);
    } catch (error: any) {
      await db.b2BApplication.update({
        where: { id: application.id },
        data: {
          status: "pending_review",
          approvedAt: null,
          rejectedAt: null,
          reviewNotes: appendNote(
            application.reviewNotes,
            `Errore approvazione/sincronizzazione: ${error?.message || "Errore imprevisto."}`,
          ),
        },
      });
    }
  }
}

export async function action({ request }: any) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const id = String(formData.get("id") || "");

  if (intent === "bulk_approve_pending") {
    await bulkApproveAndSync(
      admin,
      { status: "pending_review" },
      "Approvata manualmente in blocco: customer/company creati o sincronizzati.",
    );

    return null;
  }

  if (intent === "bulk_approve_rejected") {
    await bulkApproveAndSync(
      admin,
      { status: "rejected" },
      "Richiesta rifiutata riapprovata manualmente in blocco: customer/company creati o sincronizzati.",
    );

    return null;
  }

  if (intent === "bulk_sync_approved_without_company") {
    await bulkApproveAndSync(
      admin,
      { status: "approved", shopifyCompanyId: null },
      "Richiesta già approvata sincronizzata successivamente: customer/company creati o collegati.",
    );

    return null;
  }

  if (intent === "bulk_approve_synced_pending") {
    await db.b2BApplication.updateMany({
      where: {
        status: "pending_review",
        shopifyCompanyId: { not: null },
      },
      data: {
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
        reviewNotes:
          "Approvata massivamente: Company Shopify già creata/sincronizzata.",
      },
    });

    return null;
  }

  if (!id) {
    throw new Response("Missing application id", { status: 400 });
  }

  if (intent === "save_edits") {
    const application = await db.b2BApplication.findUnique({ where: { id } });

    if (!application) {
      throw new Response("Application not found", { status: 404 });
    }

    const operatorNote = "Dati richiesta modificati manualmente dall'operatore.";

    await db.b2BApplication.update({
      where: { id },
      data: {
        companyNameSubmitted: cleanText(formData.get("companyNameSubmitted")) || "",
        email: cleanText(formData.get("email")) || "",
        firstName: cleanText(formData.get("firstName")),
        lastName: cleanText(formData.get("lastName")),
        vatNumberSubmitted: cleanUpper(formData.get("vatNumberSubmitted")) || "",
        billingCountry: cleanUpper(formData.get("billingCountry")),
        pec: cleanText(formData.get("pec")),
        codiceDestinatario: cleanText(formData.get("codiceDestinatario")),
        viesValid: cleanViesValid(formData.get("viesValid")),
        viesCompanyName: cleanText(formData.get("viesCompanyName")),
        viesCountryCode: cleanUpper(formData.get("viesCountryCode")),
        viesVatNumber: cleanUpper(formData.get("viesVatNumber")),
        matchScore: cleanMatchScore(formData.get("matchScore")),
        viesAddress: cleanText(formData.get("viesAddress")),
        shopifyCustomerId: cleanText(formData.get("shopifyCustomerId")),
        shopifyCompanyId: cleanText(formData.get("shopifyCompanyId")),
        shopifyCompanyLocationId: cleanText(formData.get("shopifyCompanyLocationId")),
        reviewNotes: appendNote(cleanText(formData.get("reviewNotes")), operatorNote),
      },
    });

    return null;
  }

  if (intent === "delete") {
    await db.b2BApplication.delete({ where: { id } });
    return null;
  }

  if (intent === "approve_and_sync") {
    const application = await db.b2BApplication.findUnique({ where: { id } });

    if (!application) {
      throw new Response("Application not found", { status: 404 });
    }

    try {
      await approveAndSyncApplication(
        admin,
        application,
        "Approvata manualmente: customer/company creati o sincronizzati usando dati VIES con fallback sui dati cliente.",
      );
    } catch (error: any) {
      await db.b2BApplication.update({
        where: { id },
        data: {
          status: "pending_review",
          approvedAt: null,
          rejectedAt: null,
          reviewNotes: appendNote(
            application.reviewNotes,
            `Errore approvazione/sincronizzazione: ${error?.message || "Errore imprevisto."}`,
          ),
        },
      });
    }

    return null;
  }

  if (intent === "approve_status_only") {
    const application = await db.b2BApplication.findUnique({ where: { id } });

    if (!application) {
      throw new Response("Application not found", { status: 404 });
    }

    await db.b2BApplication.update({
      where: { id },
      data: {
        status: "approved",
        approvedAt: new Date(),
        rejectedAt: null,
        reviewNotes: appendNote(
          application.reviewNotes,
          "Approvata manualmente senza creare/modificare company Shopify.",
        ),
      },
    });

    return null;
  }

  if (intent === "reject") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        status: "rejected",
        rejectedAt: new Date(),
      },
    });

    return null;
  }

  if (intent === "pending") {
    await db.b2BApplication.update({
      where: { id },
      data: {
        status: "pending_review",
        approvedAt: null,
        rejectedAt: null,
      },
    });

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

function statusTone(status: string): "success" | "danger" | "warning" {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function statusLabel(status: string) {
  return statusText(status);
}

function statusPill(status: string): CSSProperties {
  const tone = statusTone(status);

  if (tone === "success") {
    return {
      display: "inline-flex",
      borderRadius: 999,
      padding: "7px 11px",
      fontWeight: 900,
      fontSize: 13,
      background: "#dff3df",
      color: "#1f5f2f",
      whiteSpace: "nowrap",
    };
  }

  if (tone === "danger") {
    return {
      display: "inline-flex",
      borderRadius: 999,
      padding: "7px 11px",
      fontWeight: 900,
      fontSize: 13,
      background: "#ffe1dc",
      color: "#8a2b1b",
      whiteSpace: "nowrap",
    };
  }

  return {
    display: "inline-flex",
    borderRadius: 999,
    padding: "7px 11px",
    fontWeight: 900,
    fontSize: 13,
    background: "#fff3cd",
    color: "#7a4b00",
    whiteSpace: "nowrap",
  };
}

function viesText(app: any) {
  if (app.viesValid === true) return "VIES valido";
  if (app.viesValid === false) return "VIES non valido";
  return "VIES non controllato";
}

function viesTone(app: any): "success" | "danger" | "neutral" {
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
  const { applications } = useLoaderData<typeof loader>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const stats = useMemo(() => {
    return {
      total: applications.length,
      pending: applications.filter((app: any) => app.status === "pending_review").length,
      approved: applications.filter((app: any) => app.status === "approved").length,
      rejected: applications.filter((app: any) => app.status === "rejected").length,
      pendingWithCompany: applications.filter(
        (app: any) => app.status === "pending_review" && app.shopifyCompanyId,
      ).length,
    };
  }, [applications]);

  const filteredApplications = useMemo(() => {
    const q = query.trim().toLowerCase();

    return applications.filter((app: any) => {
      const matchesStatus = statusFilter === "all" || app.status === statusFilter;
      const haystack = [
        app.companyNameSubmitted,
        app.vatNumberSubmitted,
        app.email,
        app.firstName,
        app.lastName,
        app.billingCountry,
        app.viesCompanyName,
        app.pec,
        app.codiceDestinatario,
        app.shopifyCustomerId,
        app.shopifyCompanyId,
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
            Gestisci richieste di accesso, verifica VIES e sincronizzazione Company Shopify.
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

      <section className="zbe-bulk">
        <div>
          <strong>Azioni massive</strong>
          <p>
            Usa queste azioni con attenzione: la prima rimette le pratiche in revisione,
            la seconda approva i pending e crea/sincronizza le aziende mancanti.
          </p>
        </div>

        <div className="zbe-bulk-actions">
          <Form method="post">
            <button
              name="intent"
              value="bulk_reset_to_pending"
              className="zbe-button zbe-button--yellow"
              type="submit"
              onClick={(event) => {
                if (
                  !window.confirm(
                    "Rimettere in revisione tutte le richieste approvate/rifiutate?",
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              Rimetti tutto in pending
            </button>
          </Form>

          <Form method="post">
            <button
              name="intent"
              value="bulk_approve_pending"
              className="zbe-button zbe-button--green"
              type="submit"
              onClick={(event) => {
                if (
                  !window.confirm(
                    "Approvare tutti i pending e creare/sincronizzare le aziende mancanti?",
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              Approva pending + crea aziende
            </button>
          </Form>
        </div>
      </section>

      <section className="zbe-toolbar">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca azienda, VAT, email, Company ID..."
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

      <section className="zbe-table-card">
        <table className="zbe-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Azienda</th>
              <th>VAT</th>
              <th>Email</th>
              <th>Match</th>
              <th>VIES</th>
              <th>Shopify</th>
              <th>Azione</th>
            </tr>
          </thead>

          <tbody>
            {filteredApplications.map((app: any) => {
              const isOpen = openId === app.id;

              return [
                <tr key={app.id} className="zbe-main-row">
                  <td data-label="Status">
                    <span style={statusPill(app.status)}>{statusLabel(app.status)}</span>
                  </td>

                  <td data-label="Azienda">
                    <strong>{app.companyNameSubmitted || "Azienda senza nome"}</strong>
                    <small>{formatDate(app.createdAt)}</small>
                  </td>

                  <td data-label="VAT">
                    <strong>{app.vatNumberSubmitted || "-"}</strong>
                    <small>{app.billingCountry || "Paese non indicato"}</small>
                  </td>

                  <td data-label="Email">
                    <strong>{app.email || "-"}</strong>
                    <small>
                      {[app.firstName, app.lastName].filter(Boolean).join(" ") || "-"}
                    </small>
                  </td>

                  <td data-label="Match">
                    <strong>
                      {app.matchScore === null || app.matchScore === undefined
                        ? "-"
                        : `${app.matchScore}%`}
                    </strong>
                  </td>

                  <td data-label="VIES">
                    <Badge tone={app.viesValid ? "success" : "danger"}>
                      {app.viesValid ? "Valido" : "Non valido"}
                    </Badge>
                  </td>

                  <td data-label="Shopify">
                    {app.shopifyCompanyId ? (
                      <Badge tone="info">Company creata</Badge>
                    ) : app.shopifyCustomerId ? (
                      <Badge tone="warning">Solo cliente</Badge>
                    ) : (
                      <Badge>Non sincronizzata</Badge>
                    )}
                  </td>

                  <td data-label="Azione">
                    <button
                      type="button"
                      className="zbe-button zbe-button--dark"
                      onClick={() => setOpenId(isOpen ? null : app.id)}
                    >
                      {isOpen ? "Chiudi" : "Apri"}
                    </button>
                  </td>
                </tr>,

                isOpen ? (
                  <tr key={`${app.id}-detail`} className="zbe-detail-row">
                    <td colSpan={8}>
                      <ApplicationDetail app={app} />
                    </td>
                  </tr>
                ) : null,
              ];
            })}

            {!filteredApplications.length && (
              <tr>
                <td colSpan={8} className="zbe-empty">
                  Nessuna richiesta trovata.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function ApplicationDetail({ app }: { app: any }) {
  return (
    <div className="zbe-detail">
      <Form method="post">
        <input type="hidden" name="id" value={app.id} />

        <div className="zbe-detail-head">
          <div>
            <span style={statusPill(app.status)}>{statusLabel(app.status)}</span>
            {app.shopifyCompanyId && <Badge tone="info">Company Shopify presente</Badge>}
          </div>

          <div className="zbe-detail-head-actions">
            <button name="intent" value="save" className="zbe-button zbe-button--grey">
              Salva modifiche
            </button>
            <button name="intent" value="approve" className="zbe-button zbe-button--green">
              Approva + crea Company
            </button>
            <button name="intent" value="pending" className="zbe-button zbe-button--yellow">
              Pending
            </button>
            <button name="intent" value="reject" className="zbe-button zbe-button--red">
              Rifiuta
            </button>
          </div>
        </div>

        <div className="zbe-detail-grid">
          <section className="zbe-card">
            <h2>Dati richiesta</h2>

            <Field label="Azienda">
              <input
                name="companyNameSubmitted"
                defaultValue={app.companyNameSubmitted || ""}
                className="zbe-input"
              />
            </Field>

            <Field label="Partita IVA / VAT">
              <input
                name="vatNumberSubmitted"
                defaultValue={app.vatNumberSubmitted || ""}
                className="zbe-input"
              />
            </Field>

            <Field label="Email">
              <input name="email" defaultValue={app.email || ""} className="zbe-input" />
            </Field>

            <div className="zbe-two-cols">
              <Field label="Nome">
                <input
                  name="firstName"
                  defaultValue={app.firstName || ""}
                  className="zbe-input"
                />
              </Field>

              <Field label="Cognome">
                <input
                  name="lastName"
                  defaultValue={app.lastName || ""}
                  className="zbe-input"
                />
              </Field>
            </div>
          </section>

          <section className="zbe-card">
            <h2>Dati fiscali</h2>

            <Field label="Paese fatturazione">
              <input
                name="billingCountry"
                defaultValue={app.billingCountry || ""}
                className="zbe-input"
              />
            </Field>

            <Field label="PEC">
              <input name="pec" defaultValue={app.pec || ""} className="zbe-input" />
            </Field>

            <Field label="Codice destinatario / SDI">
              <input
                name="codiceDestinatario"
                defaultValue={app.codiceDestinatario || ""}
                className="zbe-input"
              />
            </Field>

            <Read label="Tax exempt previsto" value={app.billingCountry && app.billingCountry !== "IT" ? "Sì" : "No"} />
          </section>

          <section className="zbe-card">
            <h2>VIES</h2>

            <Read label="Esito" value={app.viesValid ? "Valido" : "Non valido"} />
            <Read label="Ragione sociale VIES" value={app.viesCompanyName || "-"} />
            <Read label="VAT VIES" value={app.viesVatNumber || "-"} />
            <Read label="Paese VIES" value={app.viesCountryCode || "-"} />
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
              <pre className="zbe-pre">{app.viesAddress || "-"}</pre>
            </div>
          </section>

          <section className="zbe-card">
            <h2>Shopify</h2>

            <Read label="Customer ID" value={app.shopifyCustomerId || "Non presente"} />
            <Read label="Company ID" value={app.shopifyCompanyId || "Non presente"} />
            <Read
              label="Company Location ID"
              value={app.shopifyCompanyLocationId || "Non presente"}
            />

            <Field label="Note revisione">
              <textarea
                name="reviewNotes"
                defaultValue={app.reviewNotes || ""}
                rows={5}
                className="zbe-textarea"
              />
            </Field>
          </section>
        </div>

        <div className="zbe-bottom-actions">
          <button name="intent" value="save" className="zbe-button zbe-button--grey">
            Salva modifiche
          </button>

          <button name="intent" value="approve" className="zbe-button zbe-button--green">
            Approva + crea Company
          </button>

          <button name="intent" value="pending" className="zbe-button zbe-button--yellow">
            Rimetti in pending
          </button>

          <button name="intent" value="reject" className="zbe-button zbe-button--red">
            Rifiuta
          </button>

          <button
            name="intent"
            value="delete"
            className="zbe-button zbe-button--outline-red"
            onClick={(event) => {
              if (!window.confirm("Eliminare definitivamente questa richiesta?")) {
                event.preventDefault();
              }
            }}
          >
            Elimina test
          </button>
        </div>
      </Form>
    </div>
  );
}

function Field({ label, children }: any) {
  return (
    <label className="zbe-field">
      <strong>{label}</strong>
      {children}
    </label>
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
  margin-top: 18px;
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

.zbe-bulk {
  margin-top: 18px;
  background: #fff7dc;
  border: 1px solid #ffd36a;
  border-radius: 22px;
  padding: 18px;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: center;
}

.zbe-bulk p {
  margin: 6px 0 0;
  color: rgba(37,48,24,.70);
}

.zbe-bulk-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
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

.zbe-table-card {
  background: white;
  border-radius: 24px;
  box-shadow: 0 12px 30px rgba(57,65,34,.08);
  overflow: hidden;
  margin-top: 18px;
}

.zbe-table {
  width: 100%;
  border-collapse: collapse;
}

.zbe-table th,
.zbe-table td {
  text-align: left;
  padding: 14px;
  border-bottom: 1px solid #eee4bd;
  vertical-align: middle;
}

.zbe-table th {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: rgba(37,48,24,.55);
}

.zbe-table td small {
  display: block;
  color: rgba(37,48,24,.62);
  margin-top: 4px;
  overflow-wrap: anywhere;
}

.zbe-main-row:hover {
  background: #fffdf5;
}

.zbe-detail-row td {
  padding: 0;
  background: #f7f2df;
}

.zbe-detail {
  padding: 18px;
  border-top: 1px solid #efe4bd;
}

.zbe-detail-head {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: center;
  margin-bottom: 16px;
}

.zbe-detail-head > div {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.zbe-detail-head-actions {
  justify-content: flex-end;
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
}

.zbe-card h2 {
  margin-top: 0;
  margin-bottom: 16px;
}

.zbe-field,
.zbe-read {
  display: block;
  margin-bottom: 12px;
}

.zbe-field strong,
.zbe-read strong {
  display: block;
  margin-bottom: 5px;
}

.zbe-read div {
  overflow-wrap: anywhere;
}

.zbe-two-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.zbe-input,
.zbe-textarea {
  width: 100%;
  min-height: 42px;
  border: 1px solid #ddd3aa;
  border-radius: 999px;
  padding: 0 14px;
  background: #fff;
}

.zbe-textarea {
  border-radius: 14px;
  min-height: 110px;
  padding-top: 12px;
}

.zbe-pre {
  white-space: pre-wrap;
  background: #f7f7f7;
  padding: 12px;
  border-radius: 12px;
  margin: 0;
}

.zbe-bottom-actions {
  margin-top: 16px;
  background: white;
  border: 1px solid #efe4bd;
  border-radius: 18px;
  padding: 16px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.zbe-button {
  min-height: 42px;
  border: 0;
  border-radius: 999px;
  padding: 0 18px;
  font-weight: 900;
  cursor: pointer;
  white-space: nowrap;
}

.zbe-button--dark { background: #303a21; color: white; }
.zbe-button--green { background: #1f7a35; color: white; }
.zbe-button--yellow { background: #c9902f; color: white; }
.zbe-button--red { background: #9f2f1f; color: white; }
.zbe-button--grey { background: #e6e2d0; color: #253018; }
.zbe-button--outline-red {
  background: white;
  color: #9f2f1f;
  border: 1px solid #f0b8ad;
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

.zbe-empty {
  padding: 28px !important;
  text-align: center !important;
  color: rgba(37,48,24,.7);
}

@media (max-width: 980px) {
  .zbe-page {
    padding: 14px;
  }

  .zbe-hero {
    padding: 22px;
    border-radius: 26px;
  }

  .zbe-hero-icon {
    display: none;
  }

  .zbe-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .zbe-bulk {
    flex-direction: column;
    align-items: stretch;
  }

  .zbe-bulk-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .zbe-toolbar {
    grid-template-columns: 1fr;
  }

  .zbe-table-card {
    background: transparent;
    box-shadow: none;
    border-radius: 0;
  }

  .zbe-table,
  .zbe-table thead,
  .zbe-table tbody,
  .zbe-table tr,
  .zbe-table td {
    display: block;
    width: 100%;
  }

  .zbe-table thead {
    display: none;
  }

  .zbe-main-row {
    background: white;
    border-radius: 22px;
    margin-bottom: 12px;
    box-shadow: 0 12px 30px rgba(57,65,34,.08);
    overflow: hidden;
  }

  .zbe-table td {
    border-bottom: 1px solid #f1e8c5;
    padding: 12px 14px;
  }

  .zbe-main-row td::before {
    content: attr(data-label);
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: rgba(37,48,24,.55);
    font-weight: 900;
    margin-bottom: 4px;
  }

  .zbe-detail-row {
    margin-top: -12px;
    margin-bottom: 12px;
  }

  .zbe-detail-row td {
    border-bottom: 0;
  }

  .zbe-detail {
    border-radius: 0 0 22px 22px;
    padding: 14px;
  }

  .zbe-detail-head {
    align-items: stretch;
    flex-direction: column;
  }

  .zbe-detail-head-actions {
    display: none !important;
  }

  .zbe-detail-grid {
    grid-template-columns: 1fr;
  }

  .zbe-two-cols {
    grid-template-columns: 1fr;
  }

  .zbe-bottom-actions {
    display: grid;
    grid-template-columns: 1fr;
  }

  .zbe-button {
    width: 100%;
  }
}
`;
