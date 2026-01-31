import express from 'express'
import Stripe from 'stripe'
import { prisma } from '../src/lib/prisma.js'
import { requireAuth } from '../src/middleware/authMiddleware.js'

const router = express.Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

/* -------------------------------------------------------
   CREATE CHECKOUT SESSION (UNIVERZÁLNÍ PRO ŠKOLY I USERY)
-------------------------------------------------------- */
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const { priceId, planCode, billingPeriod, quantity = 1 } = req.body
    const user = req.user

    if (!priceId || !planCode) {
      return res.status(400).json({ error: 'Chybí parametry platby.' })
    }

    // 🕵️‍♂️ ROZHODOVACÍ LOGIKA
    const isSchoolPurchase = user.schoolId && user.role === 'SCHOOL_ADMIN' && planCode.includes('TEAM');

    let customerId;
    let metadata = {};
    let finalQuantity = 1;

    // ==========================================
    // 1. PŘÍPRAVA ZÁKAZNÍKA (Vytvoření / Načtení)
    // ==========================================
    if (isSchoolPurchase) {
        // --- ŠKOLA ---
        const school = await prisma.school.findUnique({ where: { id: user.schoolId } })
        if (!school) return res.status(404).json({ error: 'Škola nenalezena.' })

        customerId = school.stripeCustomerId

        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: school.billingName || school.name,
                metadata: { schoolId: school.id, ownerType: 'SCHOOL' }
            })
            customerId = customer.id
            await prisma.school.update({
                where: { id: school.id },
                data: { stripeCustomerId: customerId }
            })
        }

        metadata = {
            ownerType: "SCHOOL",
            ownerId: school.id,
            planCode: planCode,
            billingPeriod: billingPeriod
        };
        finalQuantity = quantity; 

    } else {
        // --- JEDNOTLIVEC (USER) ---
        const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
        customerId = dbUser.stripeCustomerId;

        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.email,
                metadata: { userId: user.id, ownerType: 'USER' }
            })
            customerId = customer.id
            await prisma.user.update({
                where: { id: user.id },
                data: { stripeCustomerId: customerId }
            })
        }

        metadata = {
            ownerType: "USER",
            ownerId: user.id,
            planCode: planCode,
            billingPeriod: billingPeriod
        };
        finalQuantity = 1; 
    }

    // ==========================================
    // 2. VYTVOŘENÍ SESSION (Tady byla chyba)
    // ==========================================
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      
      line_items: [
        {
          price: priceId,
          quantity: finalQuantity 
        }
      ],

      // 👇👇👇 TOTO JE TA OPRAVA 👇👇👇
      // Musíme poslat metadata na dvě místa:
      
      // 1. Přímo do Session (pro událost checkout.session.completed)
      metadata: metadata,

      // 2. Do Subscription (pro budoucí faktury a updates)
      subscription_data: {
        metadata: metadata
      },
      // 👆👆👆 KONEC OPRAVY 👆👆👆

      success_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}${isSchoolPurchase ? '/school-admin' : '/user-admin'}?success=true`,
      cancel_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}${isSchoolPurchase ? '/school-admin' : '/user-admin'}?canceled=true`,
    })

    return res.json({ url: session.url })

  } catch (err) {
    console.error('Stripe Checkout Error:', err)
    return res.status(500).json({ error: err.message })
  }
})

/* -------------------------------------------------------
   CREATE PORTAL SESSION (SPRÁVA TARIFU - UNIVERZÁLNÍ)
-------------------------------------------------------- */
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const user = req.user

    // Znovu rozhodovací logika - kam uživatele poslat?
    // Pokud je School Admin, otvíráme správu školy. Pokud je učitel, správu osoby.
    // (Zde pro jednoduchost: Máš školu a jsi admin? Spravuješ školu. Jinak sebe.)
    const isSchoolAdmin = user.schoolId && user.role === 'SCHOOL_ADMIN';

    let customerId;
    let returnUrl = `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/user-admin`;

    if (isSchoolAdmin) {
        // --- ŠKOLA ---
        const school = await prisma.school.findUnique({ where: { id: user.schoolId } });
        if (!school || !school.stripeCustomerId) {
            return res.status(404).json({ error: 'Tato škola nemá aktivní fakturační účet.' });
        }
        customerId = school.stripeCustomerId;
        returnUrl = `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/school-admin`;
    } else {
        // --- JEDNOTLIVEC ---
        const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (!dbUser || !dbUser.stripeCustomerId) {
            return res.status(404).json({ error: 'Nemáte aktivní fakturační účet. Nejdříve si zakupte tarif.' });
        }
        customerId = dbUser.stripeCustomerId;
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    })

    res.json({ url: session.url })

  } catch (err) {
    console.error('Portal session error:', err)
    return res.status(500).json({ error: err.message })
  }
})

/* -------------------------------------------------------
   UPDATE SUBSCRIPTION QUANTITY (POUZE PRO ŠKOLY)
   POST /api/billing/update-quantity
-------------------------------------------------------- */
router.post('/update-quantity', requireAuth, async (req, res) => {
  try {
    const { quantity } = req.body; 
    const user = req.user;

    // Tuto funkci mohou volat jen školy
    if (!user.schoolId || user.role !== 'SCHOOL_ADMIN') {
        return res.status(403).json({ error: 'Navýšení licencí je dostupné pouze pro školní týmy.' });
    }

    if (quantity < 1) return res.status(400).json({ error: 'Množství musí být alespoň 1.' });

    // 1. Validace: Nemůžeme snížit pod počet aktivních členů
    const activeUsersCount = await prisma.user.count({
        where: { schoolId: user.schoolId }
    });

    if (quantity < activeUsersCount) {
        return res.status(400).json({ 
            error: `Nelze snížit licence na ${quantity}, protože ve škole je momentálně ${activeUsersCount} učitelů. Nejdříve někoho odeberte.` 
        });
    }

    const school = await prisma.school.findUnique({ where: { id: user.schoolId } });
    if (!school || !school.stripeCustomerId) {
        return res.status(404).json({ error: 'Škola nemá aktivní Stripe účet.' });
    }

    // 2. Stripe Logika
    const subscriptions = await stripe.subscriptions.list({
      customer: school.stripeCustomerId,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
        return res.status(400).json({ error: 'Nemáte aktivní předplatné k úpravě.' });
    }

    const subscription = subscriptions.data[0];
    const itemId = subscription.items.data[0].id; 

    // 3. Aktualizace ve Stripe
    await stripe.subscriptions.update(subscription.id, {
      items: [{
        id: itemId,
        quantity: parseInt(quantity),
      }],
      proration_behavior: 'always_invoice', 
    });

    res.json({ ok: true, newQuantity: quantity });

  } catch (err) {
    console.error('Update quantity error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router