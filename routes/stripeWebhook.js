// routes/stripeWebhook.js
import express from "express";
import Stripe from "stripe";
import { prisma } from "../src/lib/prisma.js";
import { generateInvoiceNumber } from "../src/services/invoiceNumber.js";

console.log("🧪 generateInvoiceNumber import:", typeof generateInvoiceNumber);


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

// ======================================================
// ⚠️ STRIPE WEBHOOK – RAW BODY
// ======================================================
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send("Invalid signature");
    }

    console.log("➡️ Stripe event:", event.type);
// --------------------------------------------------
// 🧾 FAKTURA ZAPLACENA → vytvoření INTERNÍ FAKTURY
// --------------------------------------------------
if (event.type === "invoice.paid") {
  const stripeInvoice = event.data.object;

  console.log("🧾 invoice.paid:", stripeInvoice.id);

  await prisma.$transaction(async (tx) => {
    const exists = await tx.invoice.findUnique({
      where: { stripeInvoiceId: stripeInvoice.id },
    });

    if (exists) {
      console.log("↩️ Invoice already exists");
      return;
    }

    const school = await tx.school.findFirst({
      where: { stripeCustomerId: stripeInvoice.customer },
    });

    console.log("🏫 School lookup result:", school?.id);

    if (!school) {
      console.warn("⚠️ School not found for invoice");
      return;
    }

    const { year, sequence, number } =
      await generateInvoiceNumber(tx);

    console.log("📄 Creating invoice:", number);

    await tx.invoice.create({
      data: {
        stripeInvoiceId: stripeInvoice.id,
        stripeCustomerId: stripeInvoice.customer,
        stripeSubscriptionId: stripeInvoice.subscription,

        year,
        sequence,
        number,

        schoolId: school.id,

        amountPaid: stripeInvoice.amount_paid,
        currency: stripeInvoice.currency,
        status: "PAID",
        issuedAt: new Date(stripeInvoice.created * 1000),

        billingName: school.billingName,
        billingStreet: school.billingStreet,
        billingCity: school.billingCity,
        billingZip: school.billingZip,
        billingCountry: school.billingCountry,
        billingIco: school.billingIco,
        billingEmail: school.billingEmail,
      },
    });

    console.log("✅ Internal invoice created:", number);
  });
}


    try {
      switch (event.type) {
        case "checkout.session.completed":
          await handleCheckoutCompleted(event.data.object);
          break;

        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
          await syncSubscription(event.data.object);
          break;

        case "invoice.payment_succeeded":
        case "invoice.paid":
        case "invoice.payment_failed": {
          const invoice = event.data.object;

          if (invoice.subscription) {
            const subscription = await stripe.subscriptions.retrieve(
              invoice.subscription
            );

            const line = invoice.lines?.data?.[0];

            const periodStart = line?.period?.start
              ? new Date(line.period.start * 1000)
              : null;

            const periodEnd = line?.period?.end
              ? new Date(line.period.end * 1000)
              : null;

            await syncSubscription(subscription, {
              periodStart,
              periodEnd,
            });
          }
          break;
        }

        default:
          console.log("ℹ️ Ignored event:", event.type);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook handler error:", err);
      res.status(500).json({ error: "Webhook failed" });
    }
  }
);

export default router;

// ======================================================
// 🔥 FIRST TEAM ACTIVATION (10 seats)
// ======================================================
async function handleCheckoutCompleted(session) {
  if (!session.subscription || !session.metadata) return;

  const { ownerType, schoolId, planCode, seatCount } = session.metadata;

  if (ownerType !== "SCHOOL" || planCode !== "TEAM") {
    console.log("ℹ️ Checkout not TEAM/SCHOOL – ignored");
    return;
  }

  if (!schoolId) {
    console.error("❌ Missing schoolId in checkout metadata");
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(
    session.subscription
  );

  const seats =
  subscription.items.data[0]?.quantity ?? 10;

  await prisma.school.update({
    where: { id: schoolId },
    data: {
      subscriptionStatus: "ACTIVE",
      subscriptionPlan: "TEAM",
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      seatLimit: seats,
    },
  });

  console.log(
    `✅ TEAM activated for school ${schoolId} with ${seats} licenses`
  );

  await syncSubscription(subscription, {
    forceSeatLimit: seats,
  });
}

// ======================================================
// 🔄 SYNC SUBSCRIPTION → DB
// ======================================================
async function syncSubscription(subscription, overrides = {}) {
  console.log("🔄 Syncing subscription", subscription.id);

  const item = subscription.items.data[0];
  const meta = subscription.metadata || {};

  const ownerType = meta.ownerType || "USER";
let ownerId =
  ownerType === "SCHOOL"
    ? meta.schoolId
    : meta.ownerId;

// 🔥 FALLBACK: dohledání školy přes stripeCustomerId
if (!ownerId && ownerType === "SCHOOL") {
  const school = await prisma.school.findFirst({
    where: {
      stripeCustomerId: subscription.customer,
    },
  });

  if (school) {
    ownerId = school.id;
    console.log(
      "🧩 ownerId resolved via stripeCustomerId:",
      ownerId
    );
  }
}

if (!ownerId) {
  console.error(
    "❌ Missing ownerId after fallback",
    meta,
    subscription.customer
  );
  return;
}


  // --------------------------------------------------
  // 🧠 PERIOD CALCULATION (SAFE)
  // --------------------------------------------------
  let periodStart =
    overrides.periodStart ??
    (subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000)
      : null);

  let periodEnd =
    overrides.periodEnd ??
    (subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null);

  // 🔥 FALLBACK PRO ROČNÍ PLÁN
  if (
    !periodEnd &&
    item.price.recurring.interval === "year" &&
    periodStart
  ) {
    periodEnd = new Date(periodStart);
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);

    console.log(
      "🧩 Yearly fallback applied:",
      periodStart,
      "→",
      periodEnd
    );
  }

  // 🔥 FALLBACK PRO MĚSÍČNÍ PLÁN
if (
  !periodEnd &&
  item.price.recurring.interval === "month" &&
  periodStart
) {
  periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  console.log(
    "🧩 Monthly fallback applied:",
    periodStart,
    "→",
    periodEnd
  );
}


  const quantity = item.quantity ?? 1;

const data = {
  ownerType,
  ownerId,
  planCode: meta.planCode || "UNKNOWN",
  billingPeriod: item.price.recurring.interval,
  stripeCustomerId: subscription.customer,
  stripeSubscriptionId: subscription.id,
  stripePriceId: item.price.id,
  status: subscription.status,
  cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
  currentPeriodStart: periodStart,
  currentPeriodEnd: periodEnd,

  // 🔥 JEDINÝ SPRÁVNÝ ZDROJ
  seatLimit: quantity,
};


  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    update: data,
    create: data,
  });

  await updateOwnerStatus(data);

  console.log("✅ Subscription synced:", subscription.id);
}

// ======================================================
// 🔄 UPDATE OWNER (USER / SCHOOL)
// ======================================================
async function updateOwnerStatus(data) {
  const updates = {
    subscriptionStatus: data.status,
    subscriptionPlan: data.planCode,
    subscriptionUntil: data.currentPeriodEnd,
    stripeCustomerId: data.stripeCustomerId,
  };

  if (data.ownerType === "USER") {
    await prisma.user.update({
      where: { id: data.ownerId },
      data: updates,
    });
  }

  if (data.ownerType === "SCHOOL") {
    await prisma.school.update({
      where: { id: data.ownerId },
      data: {
        ...updates,
        seatLimit: data.seatLimit ?? undefined,
      },
    });
  }
}