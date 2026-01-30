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

      console.log(`💰 Faktura zaplacena. Owner: ${ownerType} ID: ${ownerId}`);

      // --- A) FAKTURA PRO ŠKOLU ---
      if (ownerType === "SCHOOL" && ownerId) {
          const schoolData = await prisma.school.findUnique({ where: { id: ownerId } });
          
          if (!schoolData) {
            console.warn(`⚠️ Škola s ID ${ownerId} nenalezena, fakturu neukládám.`);
            return res.json({ received: true });
          }

          const { number, sequence } = await generateInvoiceNumber();
          const currentYear = new Date().getFullYear();

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
                issuedAt: new Date(),
                billingName: invoice.customer_name || schoolData.billingName || schoolData.name, 
                billingStreet: invoice.customer_address?.line1 || schoolData.billingStreet || "",
                billingCity: invoice.customer_address?.city || schoolData.billingCity || "",
                billingZip: invoice.customer_address?.postal_code || schoolData.billingZip || "",
                billingCountry: invoice.customer_address?.country || schoolData.billingCountry || "CZ",
                billingIco: invoice.metadata?.ico || schoolData.billingIco || "",
                billingDic: invoice.metadata?.dic || schoolData.billingDic || "",
                school: { connect: { id: ownerId } }
            }
         });
         console.log(`✅ Faktura ${number} uložena pro školu.`);
      } 
      
      // --- B) FAKTURA PRO UŽIVATELE (NOVÉ) ---
      else if (ownerType === "USER" && ownerId) {
          const userData = await prisma.user.findUnique({ where: { id: ownerId } });

          if (!userData) {
            console.warn(`⚠️ Uživatel s ID ${ownerId} nenalezen, fakturu neukládám.`);
            return res.json({ received: true });
          }

          const { number, sequence } = await generateInvoiceNumber();
          const currentYear = new Date().getFullYear();

          // Poznámka: Uživatel nemá IČO/DIČ v DB, bereme jen z faktury nebo fallback
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
                issuedAt: new Date(),
                billingName: invoice.customer_name || userData.email, 
                billingStreet: invoice.customer_address?.line1 || "",
                billingCity: invoice.customer_address?.city || "",
                billingZip: invoice.customer_address?.postal_code || "",
                billingCountry: invoice.customer_address?.country || "CZ",
                user: { connect: { id: ownerId } } // 👈 PROPOJENÍ S USEREM
            }
         });
         console.log(`✅ Faktura ${number} uložena pro uživatele.`);
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
      
      // 👇 Zjištění typu plánu (Měsíční vs Roční) - SPOLEČNÉ PRO VŠECHNY
      const price = sub.items.data[0].price;
      const interval = price.recurring.interval; // "month" nebo "year"
      
      // Určíme dynamický kód plánu (např. PRO_MONTHLY, PRO_YEARLY, TEAM_MONTHLY...)
      // Pokud je v metadatech planCode (např. TEAM_MONTHLY), zkusíme zachovat prefix
      let basePlanName = "PRO"; // Default pro jednotlivce
      if (planCode && planCode.includes("TEAM")) basePlanName = "TEAM";

      let activePlanCode = `${basePlanName}_${interval === "year" ? "YEARLY" : "MONTHLY"}`;
      
      // Pokud máme v metadatech přesný kód a sedí interval, použijeme ten (pro jistotu)
      if (planCode && planCode.includes(interval === "year" ? "YEARLY" : "MONTHLY")) {
          activePlanCode = planCode;
      }

      const status = sub.status;
      const currentPeriodEnd = new Date(sub.current_period_end * 1000);

      // --- A) UPDATE PRO ŠKOLU ---
      if (ownerType === "SCHOOL" && ownerId) {
          const quantity = sub.items?.data[0]?.quantity || 1;
          
          let newSeatLimit = 0;
          if (status === 'active' || status === 'trialing') {
              if (activePlanCode.includes("TEAM")) {
                  newSeatLimit = quantity; 
              }
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
          console.log(`✅ Škola ${ownerId} aktualizována: ${activePlanCode} (Licence: ${newSeatLimit})`);
      } 
      
      // --- B) UPDATE PRO UŽIVATELE (NOVÉ) ---
      else if (ownerType === "USER" && ownerId) {
          await prisma.user.update({
            where: { id: ownerId },
            data: {
              subscriptionStatus: status,
              subscriptionUntil: currentPeriodEnd,
              stripeCustomerId: sub.customer,
              subscriptionPlan: activePlanCode, // Uložíme např. PRO_MONTHLY
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
        // 👇 RESET PRO UŽIVATELE
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
    return res.status(200).send(`Error processing webhook: ${err.message}`);
  }
});

export default router;