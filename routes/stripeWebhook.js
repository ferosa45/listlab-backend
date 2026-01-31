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

      // Zkusíme získat ID z subscription objektu
      if (invoice.subscription) {
          try {
            const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
            ownerType = subscription.metadata.ownerType;
            ownerId = subscription.metadata.ownerId;
          } catch (e) { console.warn("Sub not found for invoice"); }
      } 
      
      // Fallback na metadata faktury
      if (!ownerId) {
          ownerType = invoice.metadata?.ownerType;
          ownerId = invoice.metadata?.ownerId;
      }

      if (ownerId && ownerType) {
         const { number, sequence } = await generateInvoiceNumber(); 
         const currentYear = new Date().getFullYear();
         
         // Základní objekt faktury
         const invoiceData = {
            year: currentYear,
            sequence: sequence,
            number: number,
            stripeInvoiceId: invoice.id,
            stripeCustomerId: invoice.customer,
            amountPaid: invoice.amount_paid,
            currency: invoice.currency,
            status: "PAID",
            issuedAt: new Date(),
            // Defaultní hodnoty (aby Prisma neřvala, že něco chybí)
            billingStreet: "",
            billingCity: "",
            billingZip: "",
            billingCountry: "CZ" 
         };

         if (ownerType === "SCHOOL") {
             const schoolData = await prisma.school.findUnique({ where: { id: ownerId } });
             if (schoolData) {
                 invoiceData.billingName = schoolData.billingName || schoolData.name;
                 invoiceData.billingStreet = schoolData.billingStreet || "";
                 invoiceData.billingCity = schoolData.billingCity || "";
                 invoiceData.billingZip = schoolData.billingZip || "";
                 invoiceData.billingCountry = schoolData.billingCountry || "CZ";
                 invoiceData.billingIco = schoolData.billingIco || "";
                 invoiceData.school = { connect: { id: ownerId } };
             }
         } 
         else if (ownerType === "USER") {
             const userData = await prisma.user.findUnique({ where: { id: ownerId } });
             if (userData) {
                 // 🔥 TADY BYLA CHYBA: Musíme explicitně načíst data z uživatele
                 invoiceData.billingName = userData.name || userData.email || invoice.customer_name;
                 
                 // Použijeme data z DB, pokud nejsou, dáme prázdný string ""
                 invoiceData.billingStreet = userData.billingStreet || ""; 
                 invoiceData.billingCity = userData.billingCity || "";
                 invoiceData.billingZip = userData.billingZip || "";
                 invoiceData.billingCountry = userData.billingCountry || "CZ";

                 // Pozor na velké "U" u User (podle tvého schématu)
                 invoiceData.User = { connect: { id: ownerId } };
             }
         }

         // Uložíme jen pokud se podařilo spárovat
         if (invoiceData.User || invoiceData.school) {
            await prisma.invoice.create({ data: invoiceData });
            console.log(`🧾 Faktura ${number} (${ownerType}) úspěšně vytvořena.`);
         } else {
             console.error("❌ Nepodařilo se najít User/School pro fakturu.");
         }
      }
    }

    // ======================================================
    // 2️⃣ ZMĚNA / VYTVOŘENÍ PŘEDPLATNÉHO (Update + Subscription Table)
    // ======================================================
    if (
      event.type === "checkout.session.completed" || 
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const dataObject = event.data.object;
      
      let sub;

      // 🔍 ROZHODOVACÍ LOGIKA: Kde vezmeme data?
      if (dataObject.object === 'subscription') {
          // A) Událost je přímo Subscription -> Použijeme data z webhooku (je to rychlejší a přesnější)
          sub = dataObject;
          console.log("⚡ Používám přímá data z webhooku (žádné další volání API).");
      } else {
          // B) Událost je Checkout Session -> Musíme stáhnout Subscription z API
          const subId = dataObject.subscription;
          if (subId) {
            sub = await stripe.subscriptions.retrieve(subId);
            console.log("🌐 Stahuji data z API (Checkout Session).");
          }
      }

      if (sub) {
        // Metadata: Zkusíme je najít v Session (pokud existuje) nebo přímo v Sub
        const ownerType = dataObject.metadata?.ownerType || sub.metadata?.ownerType;
        const ownerId = dataObject.metadata?.ownerId || sub.metadata?.ownerId;
        const planCode = dataObject.metadata?.planCode || sub.metadata?.planCode;

        if (ownerId && ownerType) {
            
            // --- LOGOVÁNÍ PRO KONTROLU ---
            console.log(`🕒 Raw current_period_end ze Stripe: ${sub.current_period_end}`);

            // Získání Start Date
            let currentPeriodStart = new Date();
            if (sub.current_period_start) {
                currentPeriodStart = new Date(sub.current_period_start * 1000);
            }

            // Získání End Date (Expirace)
            let currentPeriodEnd = null;
            if (sub.current_period_end) {
                const d = new Date(sub.current_period_end * 1000);
                if (!isNaN(d.getTime())) {
                    currentPeriodEnd = d;
                }
            }
            
            // Pokud by NÁHODOU datum chybělo (což by teď už nemělo), dáme tam raději +30 dní,
            // aby uživatel v aplikaci neviděl "Předplatné vypršelo".
            if (!currentPeriodEnd) {
                console.warn("⚠️ Datum stále chybí, používám fallback +30 dní.");
                currentPeriodEnd = new Date();
                currentPeriodEnd.setDate(currentPeriodEnd.getDate() + 30);
            } else {
                console.log(`✅ Datum úspěšně převedeno: ${currentPeriodEnd.toISOString()}`);
            }

            // 1. ZÁPIS DO TABULKY SUBSCRIPTION
            await prisma.subscription.upsert({
              where: { stripeSubscriptionId: sub.id },
              update: {
                  status: sub.status,
                  currentPeriodEnd: currentPeriodEnd,
                  currentPeriodStart: currentPeriodStart,
                  planCode: planCode,
                  cancelAtPeriodEnd: sub.cancel_at_period_end
              },
              create: {
                  stripeSubscriptionId: sub.id,
                  stripeCustomerId: sub.customer,
                  stripePriceId: sub.items.data[0].price.id,
                  ownerType: ownerType,
                  ownerId: ownerId,
                  planCode: planCode,
                  billingPeriod: sub.items.data[0].price.recurring?.interval || 'month',
                  status: sub.status,
                  currentPeriodStart: currentPeriodStart,
                  currentPeriodEnd: currentPeriodEnd,
                  seatLimit: ownerType === 'SCHOOL' ? (planCode?.includes('TEAM') ? 20 : 1) : null
              }
            });

            // 2. UPDATE USER / SCHOOL MODELU
            const updateData = {
                subscriptionStatus: sub.status,
                subscriptionPlan: planCode,
                subscriptionUntil: currentPeriodEnd,
                stripeCustomerId: sub.customer
            };

            if (ownerType === "SCHOOL") {
                let newSeatLimit = 1;
                if (planCode && planCode.includes("TEAM")) {
                     const quantity = sub.items?.data[0]?.quantity || 1;
                     newSeatLimit = (quantity > 1) ? quantity : 20; 
                }
                await prisma.school.update({
                  where: { id: ownerId },
                  data: { ...updateData, seatLimit: newSeatLimit }
                });
            } 
            else if (ownerType === "USER") {
                await prisma.user.update({
                  where: { id: ownerId },
                  data: updateData
                });
            }
            console.log(`✅ Hotovo: ${ownerType} ${ownerId} má PRO do ${currentPeriodEnd.toISOString()}`);
        }
      }
    }

    // ======================================================
    // 3️⃣ SMAZÁNÍ PŘEDPLATNÉHO
    // ======================================================
    if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { ownerType, ownerId } = sub.metadata;

        // Update Subscription table
        try {
            await prisma.subscription.update({
                where: { stripeSubscriptionId: sub.id },
                data: { status: "canceled" }
            });
        } catch (e) {}

        if (ownerType === "SCHOOL") {
            await prisma.school.update({
                where: { id: ownerId },
                data: { subscriptionStatus: "canceled", subscriptionPlan: null, seatLimit: 0 }
            });
        }
        else if (ownerType === "USER") {
            await prisma.user.update({
                where: { id: ownerId },
                data: { subscriptionStatus: "canceled", subscriptionPlan: null }
            });
        }
        console.log(`❌ Předplatné zrušeno pro ${ownerType}.`);
    }

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    // Vracíme 200, abychom nezacyklili Stripe, pokud je chyba trvalá
    return res.status(200).send("Webhook handled with error");
  }

  res.json({ received: true });
});

export default router;