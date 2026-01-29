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

      if (ownerType === "SCHOOL" && ownerId) {
         // 1. NEJDŘÍVE NAČTEME DATA O ŠKOLE
         const schoolData = await prisma.school.findUnique({
            where: { id: ownerId }
         });

         if (!schoolData) {
             console.error(`❌ Škola ${ownerId} nenalezena pro fakturaci.`);
             return res.json({ received: true });
         }

         // 2. Vygenerujeme číslo faktury
         const { number, sequence } = await generateInvoiceNumber(); 
         const currentYear = new Date().getFullYear();

         // 3. Vytvoříme fakturu se všemi údaji
         await prisma.invoice.create({
            data: {
                year: currentYear,
                sequence: sequence,
                number: number,
                stripeInvoiceId: invoice.id,
                stripeCustomerId: invoice.customer,
                amountPaid: invoice.amount_paid,
                currency: invoice.currency,
                status: "PAID",
                // invoicePdfUrl odstraněno
                issuedAt: new Date(),
                
                // Fakturační údaje (snapshot)
                billingName: schoolData.billingName || schoolData.name, 
                billingStreet: schoolData.billingStreet || "",
                billingCity: schoolData.billingCity || "",
                billingZip: schoolData.billingZip || "",
                billingCountry: schoolData.billingCountry || "CZ",
                billingIco: schoolData.billingIco || "",
                // ❌ ODSTRANĚNO: billingDic (v DB tento sloupec není)

                school: { connect: { id: ownerId } }
            }
         });
         console.log(`🧾 Faktura ${number} uložena pro ŠKOLU: ${ownerId}`);
      } else {
          console.warn("⚠️ Faktura zaplacena, ale chybí metadata ownerType/ownerId.");
      }
    }

    // ======================================================
    // 2️⃣ ZMĚNA / VYTVOŘENÍ PŘEDPLATNÉHO
    // ======================================================
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sub = event.data.object;
      const { ownerType, ownerId, planCode } = sub.metadata;
      const quantity = sub.items?.data[0]?.quantity || 1;
      
      // Získáme info o ceně z první položky
      const price = sub.items.data[0].price;
      const interval = price.recurring.interval; // "month" nebo "year"
      
      // Určíme správný kód plánu dynamicky (ignorujeme stará metadata, pokud se liší interval)
      let activePlanCode = "TEAM_MONTHLY";
      if (interval === "year") activePlanCode = "TEAM_YEARLY";

      if (ownerType === "SCHOOL" && ownerId) {
          const status = sub.status;
          const currentPeriodEnd = new Date(sub.current_period_end * 1000);
          
          let newSeatLimit = 0;
          if (status === 'active' || status === 'trialing') {
              // Kontrola, zda jde o týmový plán (podle metadat)
              if (planCode && planCode.includes("TEAM")) {
                  newSeatLimit = quantity; 
              }
          }

          await prisma.school.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: status,
              // subscriptionPlan: planCode, // ❌ TENTO ŘÁDEK JSEM SMAZAL (byl tu navíc)
              subscriptionUntil: currentPeriodEnd,
              seatLimit: newSeatLimit,
              stripeCustomerId: sub.customer, 
              subscriptionPlan: activePlanCode, // ✅ ZDE SE ULOŽÍ TA SPRÁVNÁ HODNOTA
            }
          });
          console.log(`✅ Škola ${ownerId} aktualizována: ${activePlanCode} (Licence: ${newSeatLimit})`);
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
    return res.status(200).send(`Error processing webhook: ${err.message}`);
  }

  res.json({ received: true });
});

export default router;