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

  // console.log("➡️ Stripe event:", event.type);

  try {
    // ------------------------------------------------------
    // 1️⃣ FAKTURA ZAPLACENA (Vytvoření faktury v DB)
    // ------------------------------------------------------
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      
      // Získáme subscription pro metadata
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      const { ownerType, ownerId } = subscription.metadata;

      const invoiceNumber = await generateInvoiceNumber(); 

      const invoiceData = {
        stripeInvoiceId: invoice.id,
        stripeCustomerId: invoice.customer,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        status: "PAID",
        invoicePdfUrl: invoice.hosted_invoice_url,
        number: invoiceNumber,
        issuedAt: new Date(),
      };

      if (ownerType === "SCHOOL") {
         await prisma.invoice.create({
            data: {
                ...invoiceData,
                school: { connect: { id: ownerId } } // Napojení na školu
            }
         });
         console.log(`🧾 Faktura vytvořena pro ŠKOLU: ${ownerId}`);
      } 
      // ... (případně user logic)
    }

    // ------------------------------------------------------
    // 2️⃣ ZMĚNA PŘEDPLATNÉHO (Aktivace/Deaktivace)
    // ------------------------------------------------------
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object;
      const { ownerType, ownerId, planCode } = sub.metadata;

      // Pokud chybí metadata, nemůžeme nic dělat
      if (!ownerType || !ownerId) {
          console.warn("⚠️ Subscription chybí metadata. Ignoruji.");
          return res.json({ received: true });
      }

      const status = sub.status; // active, past_due, canceled...
      const currentPeriodEnd = new Date(sub.current_period_end * 1000);

      // 🔥 LOGIKA PRO LICENCE:
      // Pokud je status 'active' a je to TEAM plán, dáme 10 licencí. Jinak 0 (Free).
      let newSeatLimit = 0;
      if (status === 'active' || status === 'trialing') {
          // Zde si můžeš nastavit logiku, např. TEAM = 10, PRO = 100...
          newSeatLimit = 10; 
      }

      if (ownerType === "SCHOOL") {
        await prisma.school.update({
          where: { id: ownerId },
          data: {
            subscriptionStatus: status,
            subscriptionPlan: planCode,
            subscriptionUntil: currentPeriodEnd,
            seatLimit: newSeatLimit, // 👈 TOTO AKTUALIZUJE LICENCE NA DASHBOARDU
            stripeCustomerId: sub.customer, 
          }
        });
        console.log(`✅ Škola ${ownerId} aktualizována: ${planCode}, Status: ${status}, Licence: ${newSeatLimit}`);
      }
    }

    // ------------------------------------------------------
    // 3️⃣ SMAZÁNÍ PŘEDPLATNÉHO
    // ------------------------------------------------------
    if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { ownerType, ownerId } = sub.metadata;

        if (ownerType === "SCHOOL") {
            await prisma.school.update({
                where: { id: ownerId },
                data: {
                    subscriptionStatus: "canceled",
                    subscriptionPlan: null,
                    seatLimit: 0 // Reset na Free
                }
            });
            console.log(`❌ Škola ${ownerId} - předplatné zrušeno.`);
        }
    }

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(400).send(`Error: ${err.message}`);
  }

  res.json({ received: true });
});

export default router;