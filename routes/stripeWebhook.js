// routes/stripeWebhook.js
import express from "express";
import Stripe from "stripe";
import { prisma } from "../src/lib/prisma.js";

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

  const { ownerType, ownerId, planCode } = session.metadata;

  if (ownerType !== "SCHOOL" || planCode !== "TEAM") {
    console.log("ℹ️ Checkout not TEAM/SCHOOL – ignored");
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(
    session.subscription
  );

  // 🔥 PRVNÍ AKTIVACE TEAM = 10 LICENCÍ
  await prisma.school.update({
    where: { id: ownerId },
    data: {
      subscriptionStatus: "ACTIVE",
      subscriptionPlan: "TEAM",
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      seatLimit: 10, // 🔥 KLÍČOVÉ
    },
  });

  console.log(
    `✅ TEAM activated for school ${ownerId} with 10 licenses`
  );

  // 🔁 uložíme i do subscription tabulky
  await syncSubscription(subscription, {
    forceSeatLimit: 10,
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
  const ownerId = meta.ownerId;

  if (!ownerId) {
    console.error("❌ Missing ownerId in Stripe metadata");
    return;
  }

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

    currentPeriodStart:
      overrides.periodStart ??
      (subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000)
        : null),

    currentPeriodEnd:
      overrides.periodEnd ??
      (subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null),

    seatLimit:
      overrides.forceSeatLimit ??
      (meta.seatLimit ? Number(meta.seatLimit) : null),
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
