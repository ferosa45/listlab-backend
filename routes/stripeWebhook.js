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

      // Generování čísla faktury (tvá funkce vrací objekt { number, sequence })
      const invResult = await generateInvoiceNumber(prisma);

      const invoiceData = {
        year: new Date().getFullYear(),
        sequence: invResult.sequence,
        number: invResult.number, // String
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

      // VAZBY
      if (ownerType === "SCHOOL") {
        invoiceData.school = { connect: { id: ownerId } };
      } else if (ownerType === "USER") {
        // Pozor na velké "U" u User, dle schema.prisma
        invoiceData.User = { connect: { id: ownerId } };
      }

      await prisma.invoice.create({
        data: invoiceData
      });

      console.log(`📄 Faktura ${invResult.number} uložena do DB.`);
    }

    // ======================================================
    // 2️⃣ AKTUALIZACE PŘEDPLATNÉHO (checkout, update)
    // ======================================================
    // ======================================================
    // 2️⃣ AKTUALIZACE PŘEDPLATNÉHO (checkout, update)
    // ======================================================
    if (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated") {
      const sessionOrSub = event.data.object;
      
      // 1. Získáme ID subscription
      const subId = sessionOrSub.subscription || sessionOrSub.id;
      
      // 2. Načteme čerstvá data o předplatném (hlavně kvůli datumu expirace)
      const sub = await stripe.subscriptions.retrieve(subId);
      
      // 3. INTELIGENTNÍ ZÍSKÁNÍ METADAT (To je ta oprava!)
      // Nejdřív se podíváme do objektu, který přišel (Session), pokud tam nejsou, zkusíme Subscription
      const ownerType = sessionOrSub.metadata?.ownerType || sub.metadata?.ownerType;
      const ownerId = sessionOrSub.metadata?.ownerId || sub.metadata?.ownerId;
      const activePlanCode = sessionOrSub.metadata?.planCode || sub.metadata?.planCode;

      console.log(`🔍 Webhook processing: Type=${ownerType}, ID=${ownerId}, Plan=${activePlanCode}`);

      if (!ownerId || !ownerType) {
        console.error("❌ CHYBA: Metadata nenalezena ani v Session, ani v Subscription!");
        // Vracíme 200, aby Stripe nezkoušel posílat chybný požadavek donekonečna
        return res.json({ received: true });
      }

      // Datum konce předplatného (převod z UNIX timestamp)
      const currentPeriodEnd = new Date(sub.current_period_end * 1000);
      
      // Status
      const status = ['active', 'trialing'].includes(sub.status) ? 'active' : 'canceled';

      if (ownerType === "SCHOOL") {
          let newSeatLimit = 1; 
          if (activePlanCode && (activePlanCode.includes('TEAM_MONTHLY') || activePlanCode.includes('TEAM_YEARLY'))) {
             newSeatLimit = 10; 
          }

          await prisma.school.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: status,
              subscriptionUntil: currentPeriodEnd,
              seatLimit: newSeatLimit,
              stripeCustomerId: sub.customer, 
              subscriptionPlan: activePlanCode, 
            }
          });
          console.log(`✅ Škola ${ownerId} aktualizována.`);
      } 
      else if (ownerType === "USER") {
          await prisma.user.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: status,       
              subscriptionPlan: activePlanCode, 
              subscriptionUntil: currentPeriodEnd, 
              stripeCustomerId: sub.customer    
            }
          });
          console.log(`✅ User ${ownerId} aktualizován: ${activePlanCode}, do: ${currentPeriodEnd.toISOString()}`);
      }
    }

    // ======================================================
    // 3️⃣ SMAZÁNÍ PŘEDPLATNÉHO
    // ======================================================
    if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { ownerType, ownerId } = sub.metadata;

        if (ownerType === "SCHOOL") {
            // --- TVOJE PŮVODNÍ LOGIKA PRO ŠKOLU (NEMĚNĚNO) ---
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
        // 👇👇👇 NOVÁ ČÁST PRO JEDNOTLIVCE (USER) 👇👇👇
        else if (ownerType === "USER") {
            await prisma.user.update({
                where: { id: ownerId },
                data: {
                    subscriptionStatus: "canceled",
                    subscriptionPlan: null
                    // subscriptionUntil nemazeme, aby videl kdy mu to skoncilo
                }
            });
            console.log(`❌ User ${ownerId} - předplatné zrušeno.`);
        }
    }

    res.json({ received: true });

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook failed" }); 
  }
});

export default router;