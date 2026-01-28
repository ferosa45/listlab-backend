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
    // Zde se vytváří záznam do databáze
    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      
      // Faktura za 0 Kč (např. trial) se často neukládá, ale pokud chceš všechny:
      // if (invoice.amount_paid === 0) return res.json({ received: true });

      // Musíme zjistit, komu faktura patří. To je uloženo v předplatném.
      // Pokud je to jednorázová platba, metadata mohou být přímo v invoice, 
      // ale u předplatného jsou v subscription objektu.
      let ownerType, ownerId;

      if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          ownerType = subscription.metadata.ownerType;
          ownerId = subscription.metadata.ownerId;
      } else {
          // Fallback pro případné jednorázové platby
          ownerType = invoice.metadata?.ownerType;
          ownerId = invoice.metadata?.ownerId;
      }

      if (ownerType === "SCHOOL" && ownerId) {
         // Vygenerujeme naše interní číslo faktury (např. 2026-00001)
         const newInvoiceNumber = await generateInvoiceNumber(); 

         // Vytvoření záznamu v DB
         await prisma.invoice.create({
            data: {
                number: newInvoiceNumber,
                stripeInvoiceId: invoice.id,
                stripeCustomerId: invoice.customer,
                amountPaid: invoice.amount_paid, // částka v haléřích/centech
                currency: invoice.currency,
                status: "PAID",
                // Stripe generuje PDF fakturu automaticky, uložíme odkaz
                invoicePdfUrl: invoice.hosted_invoice_url || invoice.invoice_pdf,
                issuedAt: new Date(),
                // Propojení se školou
                school: { connect: { id: ownerId } }
            }
         });
         console.log(`🧾 Faktura ${newInvoiceNumber} uložena pro ŠKOLU: ${ownerId}`);
      } else {
          console.warn("⚠️ Faktura zaplacena, ale chybí metadata ownerType/ownerId.");
      }
    }

    // ======================================================
    // 2️⃣ ZMĚNA / VYTVOŘENÍ PŘEDPLATNÉHO
    // ======================================================
    // Toto už ti funguje (aktualizuje plán školy)
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object;
      const { ownerType, ownerId, planCode } = sub.metadata;

      if (ownerType === "SCHOOL" && ownerId) {
          const status = sub.status; // active, past_due, etc.
          const currentPeriodEnd = new Date(sub.current_period_end * 1000);
          
          // Logika licencí: TEAM = 10, jinak 0
          let newSeatLimit = 0;
          if (status === 'active' || status === 'trialing') {
              if (planCode && planCode.includes("TEAM")) {
                  newSeatLimit = 10; 
              }
          }

          await prisma.school.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: status,
              subscriptionPlan: planCode,
              subscriptionUntil: currentPeriodEnd,
              seatLimit: newSeatLimit,
              stripeCustomerId: sub.customer, 
            }
          });
          console.log(`✅ Škola ${ownerId} aktualizována: ${planCode} (Licence: ${newSeatLimit})`);
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
    }

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    // Vracíme 200 i při chybě logiky, aby Stripe nezkoušel posílat request znovu donekonečna
    // (pokud je to chyba v našem kódu a ne dočasný výpadek DB)
    return res.status(200).send(`Error processing webhook: ${err.message}`);
  }

  res.json({ received: true });
});

export default router;