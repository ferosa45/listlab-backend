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
      
      // Zkusíme metadata z faktury, případně ze subscription
      let ownerType = invoice.metadata?.ownerType;
      let ownerId = invoice.metadata?.ownerId;

      // Pokud nejsou na faktuře, zkusíme subscription (pokud existuje)
      if ((!ownerId || !ownerType) && invoice.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(invoice.subscription);
            ownerType = sub.metadata.ownerType;
            ownerId = sub.metadata.ownerId;
          } catch (e) {
            console.warn("⚠️ Nepodařilo se načíst subscription pro fakturu.");
          }
      }

      if (ownerId && ownerType) {
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

        const invResult = await generateInvoiceNumber(prisma);

        const invoiceData = {
            year: new Date().getFullYear(),
            sequence: invResult.sequence,
            number: invResult.number,
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

        if (ownerType === "SCHOOL") {
            invoiceData.school = { connect: { id: ownerId } };
        } else if (ownerType === "USER") {
            invoiceData.User = { connect: { id: ownerId } };
        }

        await prisma.invoice.create({ data: invoiceData });
        console.log(`📄 Faktura ${invResult.number} uložena do DB.`);
      }
    }

    // ======================================================
    // 2️⃣ AKTUALIZACE PŘEDPLATNÉHO (Dynamický update)
    // ======================================================
    if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
      const sessionOrSub = event.data.object;
      const subId = sessionOrSub.subscription || sessionOrSub.id;
      
      if (!subId || typeof subId !== 'string') {
          return res.json({ received: true });
      }

      // 1. Načteme data ze Stripe
      const sub = await stripe.subscriptions.retrieve(subId);

      // 2. Metadata
      const ownerId = sessionOrSub.metadata?.ownerId || sub.metadata?.ownerId;
      const ownerType = sessionOrSub.metadata?.ownerType || sub.metadata?.ownerType;
      const planCode = sessionOrSub.metadata?.planCode || sub.metadata?.planCode;
      const stripeCustomerId = sub.customer;

      // 3. Status
      const status = ['active', 'trialing'].includes(sub.status) ? 'active' : 'canceled';

      // 4. Datum - Získáme ho, ale zatím neukládáme
      let validDate = null;
      if (sub.current_period_end) {
          const d = new Date(sub.current_period_end * 1000);
          // Ověříme, že to není "Invalid Date"
          if (!isNaN(d.getTime())) {
              validDate = d;
          }
      }

      console.log(`🔍 Zpracovávám: ${ownerType} ${ownerId} -> ${planCode}`);

      if (ownerId && ownerType) {
        
        // --- DYNAMICKÁ PŘÍPRAVA DAT ---
        // Základní data, která máme vždy
        const dataToUpdate = {
            subscriptionStatus: status,
            subscriptionPlan: planCode,
            stripeCustomerId: stripeCustomerId
        };

        // Datum přidáme do update objektu JEN TEHDY, pokud ho Stripe skutečně poslal
        // Pokud ho neposlal, Prisma tento sloupec ignoruje a nechá tam to, co tam bylo (nebo null)
        if (validDate) {
            dataToUpdate.subscriptionUntil = validDate;
        }

        // --- ZÁPIS DO DB ---
        if (ownerType === "SCHOOL") {
            let newSeatLimit = 1; 
            if (planCode && planCode.includes('TEAM')) {
               newSeatLimit = 20; 
            }
            // Přidáme limit do objektu
            dataToUpdate.seatLimit = newSeatLimit;

            await prisma.school.update({
              where: { id: ownerId },
              data: dataToUpdate // <--- Použijeme dynamický objekt
            });
        } 
        else if (ownerType === "USER") {
            await prisma.user.update({
              where: { id: ownerId },
              data: dataToUpdate // <--- Použijeme dynamický objekt
            });
        }
        
        // Logování - vypíšeme datum jen pokud existuje
        console.log(`✅ Uloženo pro ${ownerType}: ${planCode}, Datum: ${validDate ? validDate.toISOString() : 'Zatím nedostupné'}`);
      
      } else {
          console.warn("⚠️ Chybí ownerId/ownerType, přeskakuji.");
      }
    }

    // ======================================================
    // 3️⃣ SMAZÁNÍ PŘEDPLATNÉHO
    // ======================================================
    if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { ownerType, ownerId } = sub.metadata || {};

        if (ownerId && ownerType === "SCHOOL") {
            await prisma.school.update({
                where: { id: ownerId },
                data: { subscriptionStatus: "canceled", subscriptionPlan: null, seatLimit: 0 }
            });
        }
        else if (ownerId && ownerType === "USER") {
            await prisma.user.update({
                where: { id: ownerId },
                data: { subscriptionStatus: "canceled", subscriptionPlan: null }
            });
        }
    }

    res.json({ received: true });

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    // Vracíme 200, i když to spadne, aby Stripe neposílal requesty pořád dokola
    res.status(200).json({ error: "Webhook failed handled" }); 
  }
});

export default router;