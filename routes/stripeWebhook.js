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
    // 2️⃣ AKTUALIZACE PŘEDPLATNÉHO (To, co ti padalo)
    // ======================================================
    if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
      const sessionOrSub = event.data.object;
      const metadata = sessionOrSub.metadata || {};

      // 1. Primární zdroj dat je to, co přišlo ve webhooku (Session)
      let ownerId = metadata.ownerId;
      let ownerType = metadata.ownerType;
      let planCode = metadata.planCode;
      
      // ID subscription a zákazníka
      const subId = sessionOrSub.subscription || sessionOrSub.id;
      let stripeCustomerId = sessionOrSub.customer;

      // 2. Pokusíme se načíst přesné datum konce ze Stripe
      // Default: nastavíme +31 dní, kdyby Stripe API selhalo (pojistka)
      let currentPeriodEnd = new Date();
      currentPeriodEnd.setDate(currentPeriodEnd.getDate() + 31);
      
      let status = 'active';

      if (subId && typeof subId === 'string') {
        try {
            const sub = await stripe.subscriptions.retrieve(subId);
            
            // Pokud metadata nebyla v session, vezmeme je ze subscription
            if (!ownerId) ownerId = sub.metadata.ownerId;
            if (!ownerType) ownerType = sub.metadata.ownerType;
            if (!planCode) planCode = sub.metadata.planCode;

            // Datum expirace
            if (sub.current_period_end) {
                currentPeriodEnd = new Date(sub.current_period_end * 1000);
            }
            
            stripeCustomerId = sub.customer;
            status = ['active', 'trialing'].includes(sub.status) ? 'active' : 'canceled';

        } catch (e) {
            console.error("⚠️ Chyba při stahování subscription details, používám fallback data.", e);
        }
      }

      console.log(`🔍 Update DB: ${ownerType} ${ownerId} -> ${planCode}`);

      // 3. Zápis do databáze (jen pokud máme ID)
      if (ownerId && ownerType) {
        if (ownerType === "SCHOOL") {
            let newSeatLimit = 1; 
            if (planCode && planCode.includes('TEAM')) {
               newSeatLimit = 20; 
            }

            await prisma.school.update({
              where: { id: ownerId },
              data: {
                subscriptionStatus: status,
                subscriptionUntil: currentPeriodEnd,
                seatLimit: newSeatLimit,
                stripeCustomerId: stripeCustomerId, 
                subscriptionPlan: planCode, 
              }
            });
        } 
        else if (ownerType === "USER") {
            await prisma.user.update({
              where: { id: ownerId },
              data: {
                subscriptionStatus: status,       
                subscriptionPlan: planCode, 
                subscriptionUntil: currentPeriodEnd, 
                stripeCustomerId: stripeCustomerId    
              }
            });
        }
        console.log(`✅ Úspěšně aktualizováno: ${ownerType} ${ownerId}`);
      } else {
          console.warn("❌ Webhook nemá ownerId, ignoruji.");
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