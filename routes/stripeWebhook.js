import express from "express";
import Stripe from "stripe";
import { prisma } from "../src/lib/prisma.js";
import { generateInvoiceNumber } from "../src/services/invoiceNumber.js"; 

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

router.post("/", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ======================================================
    // 1️⃣ FAKTURA ZAPLACENA (invoice.payment_succeeded)
    // ======================================================
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      
      let ownerType, ownerId;

      if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          ownerType = subscription.metadata.ownerType;
          ownerId = subscription.metadata.ownerId;
      } else {
          ownerType = invoice.metadata?.ownerType;
          ownerId = invoice.metadata?.ownerId;
      }

      if (!ownerId) {
          console.error("❌ No ownerId found in metadata/subscription");
          return res.status(400).json({ error: "Missing metadata" });
      }

      console.log(`💰 Faktura zaplacena. Owner: ${ownerType} ID: ${ownerId}`);

      const amountPaid = invoice.amount_paid;
      const currency = invoice.currency;
      const stripeInvoiceId = invoice.id;
      const customerId = invoice.customer;

      const billingDetails = {
        name: invoice.customer_name || "",
        street: invoice.customer_address?.line1 || "",
        city: invoice.customer_address?.city || "",
        zip: invoice.customer_address?.postal_code || "",
        country: invoice.customer_address?.country || "CZ",
      };

      const now = new Date();
      
      // 🔥 OPRAVA ZDE: generateInvoiceNumber vrací objekt { number, sequence }
      const invResult = await generateInvoiceNumber(prisma);

      // --- PŘÍPRAVA DAT PRO FAKTURU ---
      const invoiceData = {
        year: now.getFullYear(),
        sequence: invResult.sequence, // 👈 vytáhneme číslo sekvence
        number: invResult.number,     // 👈 vytáhneme string (číslo faktury)
        stripeInvoiceId,
        stripeCustomerId: customerId,
        amountPaid,
        currency,
        status: "PAID",
        issuedAt: new Date(),
        billingName: billingDetails.name,
        billingStreet: billingDetails.street,
        billingCity: billingDetails.city,
        billingZip: billingDetails.zip,
        billingCountry: billingDetails.country,
      };

      // --- LOGIKA PŘIPOJENÍ (ŠKOLA vs UŽIVATEL) ---
      if (ownerType === "SCHOOL") {
        invoiceData.school = { connect: { id: ownerId } };
      } else if (ownerType === "USER") {
        invoiceData.user = { connect: { id: ownerId } };
        // schoolId zůstane null, což schema.prisma díky otazníku už dovolí
      }

      await prisma.invoice.create({
        data: invoiceData
      });

      console.log(`📄 Faktura ${invResult.number} uložena do DB.`);
    }

    // ======================================================
    // 2️⃣ AKTUALIZACE PŘEDPLATNÉHO (checkout nebo update)
    // ======================================================
    if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
      const sessionOrSub = event.data.object;
      
      let ownerType, ownerId, activePlanCode;

      if (event.type === "checkout.session.completed") {
          ownerType = sessionOrSub.metadata.ownerType;
          ownerId = sessionOrSub.metadata.ownerId;
          activePlanCode = sessionOrSub.metadata.planCode;
      } else {
          ownerType = sessionOrSub.metadata.ownerType;
          ownerId = sessionOrSub.metadata.ownerId;
          // Získání planCode z položek subscription
          activePlanCode = sessionOrSub.items?.data[0]?.plan?.metadata?.planCode || sessionOrSub.metadata?.planCode;
      }

      if (ownerType === "SCHOOL") {
          const seatLimit = activePlanCode && activePlanCode.includes("TEAM") ? 20 : 1;
          await prisma.school.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: "active",
              subscriptionPlan: activePlanCode,
              seatLimit: seatLimit,
            }
          });
          console.log(`✅ Škola ${ownerId} aktualizována: ${activePlanCode}`);
      } 
      else if (ownerType === "USER") {
          await prisma.user.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: "active",
              subscriptionPlan: activePlanCode,
            }
          });
          console.log(`✅ User ${ownerId} aktualizován: ${activePlanCode}`);
      }
    }

    // ======================================================
    // 3️⃣ SMAZÁNÍ PŘEDPLATNÉHO
    // ======================================================
    if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { ownerType, ownerId } = sub.metadata;

        if (ownerType === "SCHOOL") {
            await prisma.school.update({
                where: { id: ownerId },
                data: {
                    subscriptionStatus: "canceled",
                    subscriptionPlan: null,
                    seatLimit: 0 
                }
            });
            console.log(`❌ Škola ${ownerId} - předplatné zrušeno.`);
        }
        else if (ownerType === "USER") {
            await prisma.user.update({
                where: { id: ownerId },
                data: {
                    subscriptionStatus: "canceled",
                    subscriptionPlan: null
                }
            });
            console.log(`❌ User ${ownerId} - předplatné zrušeno.`);
        }
    }

    res.json({ received: true });

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

export default router;