-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "B2BApplication" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "B2BApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "B2BApplication_shop_idx" ON "B2BApplication"("shop");

-- CreateIndex
CREATE INDEX "B2BApplication_email_idx" ON "B2BApplication"("email");

-- CreateIndex
CREATE INDEX "B2BApplication_status_idx" ON "B2BApplication"("status");
