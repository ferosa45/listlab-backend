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

      if (ownerId && ownerType) {
         // Společná příprava dat pro fakturu
         const { number, sequence } = await generateInvoiceNumber(); 
         const currentYear = new Date().getFullYear();
         
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
         };

         // --- VĚTEV PRO ŠKOLU (Původní logika) ---
         if (ownerType === "SCHOOL") {
             const schoolData = await prisma.school.findUnique({ where: { id: ownerId } });
             if (!schoolData) {
                 console.error(`❌ Škola ${ownerId} nenalezena.`);
                 return res.json({ received: true });
             }

             invoiceData.billingName = schoolData.billingName || schoolData.name;
             invoiceData.billingStreet = schoolData.billingStreet || "";
             invoiceData.billingCity = schoolData.billingCity || "";
             invoiceData.billingZip = schoolData.billingZip || "";
             invoiceData.billingCountry = schoolData.billingCountry || "CZ";
             invoiceData.billingIco = schoolData.billingIco || "";
             
             invoiceData.school = { connect: { id: ownerId } };
             
             console.log(`🧾 Faktura ${number} (ŠKOLA) uložena.`);
         } 
         // --- NOVÁ VĚTEV PRO USERA ---
         else if (ownerType === "USER") {
             const userData = await prisma.user.findUnique({ where: { id: ownerId } });
             if (!userData) {
                 console.error(`❌ User ${ownerId} nenalezen.`);
                 return res.json({ received: true });
             }

             // Uživatelé většinou nemají fakturační údaje v DB, použijeme jméno/email
             invoiceData.billingName = invoice.customer_name || userData.email;
             invoiceData.billingCountry = "CZ"; 
             
             // Pozor na velké "U" u User v Prisma schématu (záleží na tvém schema.prisma)
             invoiceData.User = { connect: { id: ownerId } };
             
             console.log(`🧾 Faktura ${number} (USER) uložena.`);
         }

         // Uložení faktury do DB
         await prisma.invoice.create({ data: invoiceData });

      } else {
          console.warn("⚠️ Faktura zaplacena, ale chybí metadata ownerType/ownerId.");
      }
    }

    // ======================================================
    // 2️⃣ ZMĚNA / VYTVOŘENÍ PŘEDPLATNÉHO (Update)
    // ======================================================
    if (
      event.type === "checkout.session.completed" || // Přidáno pro jistotu prvního nákupu
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated"
    ) {
      const sessionOrSub = event.data.object;
      const subId = sessionOrSub.subscription || sessionOrSub.id;

      // Načteme čerstvá data ze Stripe (pro jistotu datumu a metadat)
      const sub = await stripe.subscriptions.retrieve(subId);

      // Metadata bereme primárně ze Session (pokud je to checkout), jinak ze Subscription
      const ownerType = sessionOrSub.metadata?.ownerType || sub.metadata?.ownerType;
      const ownerId = sessionOrSub.metadata?.ownerId || sub.metadata?.ownerId;
      const planCode = sessionOrSub.metadata?.planCode || sub.metadata?.planCode;

      if (ownerId && ownerType) {
          const currentPeriodEnd = new Date(sub.current_period_end * 1000);
          const currentPeriodStart = new Date(sub.current_period_start * 1000);
          
          // ---------------------------------------------------------
          // A) ZÁPIS DO TABULKY "SUBSCRIPTION" (KLÍČOVÉ PRO OBA TYPY)
          // ---------------------------------------------------------
          // Toto zajistí, že SubscriptionService bude fungovat
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
                // SeatLimit uložíme do Subscription jen pro školy
                seatLimit: ownerType === 'SCHOOL' ? (planCode.includes('TEAM') ? 20 : 1) : null
            }
          });

          // ---------------------------------------------------------
          // B) AKTUALIZACE KONKRÉTNÍHO MODELU (SCHOOL nebo USER)
          // ---------------------------------------------------------
          
          if (ownerType === "SCHOOL") {
              // --- TVOJE PŮVODNÍ LOGIKA PRO ŠKOLU ---
              const quantity = sub.items?.data[0]?.quantity || 1;
              let newSeatLimit = 1; // Default
              
              if (sub.status === 'active' || sub.status === 'trialing') {
                  if (planCode && planCode.includes("TEAM")) {
                      // Pokud je to TEAM, použijeme quantity ze Stripe, nebo fixně 20
                      // (V původním kódu jsi měl quantity, v diskuzi jsme řešili fix 20. 
                      //  Nechávám logiku quantity, pokud ji Stripe posílá správně, je to lepší.)
                      newSeatLimit = (quantity > 1) ? quantity : 20; 
                  }
              }

              await prisma.school.update({
                where: { id: ownerId },
                data: {
                  subscriptionStatus: sub.status,
                  subscriptionUntil: currentPeriodEnd,
                  seatLimit: newSeatLimit,
                  stripeCustomerId: sub.customer, 
                  subscriptionPlan: planCode,
                }
              });
              console.log(`✅ Škola ${ownerId} aktualizována (čte z Subscription).`);
          } 
          else if (ownerType === "USER") {
              // --- NOVÁ LOGIKA PRO USERA ---
              await prisma.user.update({
                where: { id: ownerId },
                data: {
                  subscriptionStatus: sub.status,
                  subscriptionPlan: planCode,
                  subscriptionUntil: currentPeriodEnd,
                  stripeCustomerId: sub.customer
                }
              });
              console.log(`✅ User ${ownerId} aktualizován.`);
          }
      }
    }

    // ======================================================
    // 3️⃣ SMAZÁNÍ PŘEDPLATNÉHO
    // ======================================================
    if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const { ownerType, ownerId } = sub.metadata;

        // 1. Označíme jako canceled v tabulce Subscription
        try {
            await prisma.subscription.update({
                where: { stripeSubscriptionId: sub.id },
                data: { status: "canceled" }
            });
        } catch (e) { console.log("Subscription záznam nenalezen, nelze zrušit."); }

        // 2. Aktualizujeme User/School
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

  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(200).send(`Error processing webhook: ${err.message}`);
  }

  res.json({ received: true });
});

export default router;