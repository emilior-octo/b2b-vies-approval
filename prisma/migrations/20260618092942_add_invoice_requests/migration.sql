-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT,
    "orderId" TEXT,
    "orderName" TEXT,
    "cartToken" TEXT,
    "checkoutToken" TEXT,
    "invoiceType" TEXT NOT NULL,
    "email" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "companyName" TEXT,
    "vatNumber" TEXT,
    "billingCountry" TEXT,
    "pec" TEXT,
    "codiceDestinatario" TEXT,
    "viesChecked" BOOLEAN DEFAULT false,
    "viesValid" BOOLEAN,
    "viesCompanyName" TEXT,
    "viesAddress" TEXT,
    "reverseCharge" BOOLEAN DEFAULT false,
    "taxExemptApplied" BOOLEAN DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceRequest_shop_idx" ON "InvoiceRequest"("shop");

-- CreateIndex
CREATE INDEX "InvoiceRequest_email_idx" ON "InvoiceRequest"("email");

-- CreateIndex
CREATE INDEX "InvoiceRequest_status_idx" ON "InvoiceRequest"("status");

-- CreateIndex
CREATE INDEX "InvoiceRequest_cartToken_idx" ON "InvoiceRequest"("cartToken");
