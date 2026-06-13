-- CreateTable
CREATE TABLE "B2BApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyNameSubmitted" TEXT NOT NULL,
    "vatNumberSubmitted" TEXT NOT NULL,
    "billingCountry" TEXT,
    "pec" TEXT,
    "codiceDestinatario" TEXT,
    "viesValid" BOOLEAN,
    "viesCompanyName" TEXT,
    "viesAddress" TEXT,
    "viesCountryCode" TEXT,
    "viesVatNumber" TEXT,
    "matchScore" INTEGER,
    "shopifyCustomerId" TEXT,
    "shopifyCompanyId" TEXT,
    "shopifyCompanyLocationId" TEXT,
    "reviewNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "rejectedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "B2BApplication_shop_idx" ON "B2BApplication"("shop");

-- CreateIndex
CREATE INDEX "B2BApplication_email_idx" ON "B2BApplication"("email");

-- CreateIndex
CREATE INDEX "B2BApplication_status_idx" ON "B2BApplication"("status");
