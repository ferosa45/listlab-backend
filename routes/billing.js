import express from 'express'
import Stripe from 'stripe'
import { prisma } from '../src/lib/prisma.js'
import { requireAuth } from '../src/middleware/authMiddleware.js'

const router = express.Router()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

/* -------------------------------------------------------
   CREATE CHECKOUT SESSION (PRO ŠKOLY)
-------------------------------------------------------- */
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const { priceId, planCode, billingPeriod } = req.body
    const user = req.user

    if (!priceId || !planCode) {
      return res.status(400).json({ error: 'Chybí parametry platby.' })
    }

    // 1. Získáme školu
    if (!user.schoolId) {
        return res.status(400).json({ error: 'Uživatel není přiřazen k žádné škole.' })
    }

    const school = await prisma.school.findUnique({
        where: { id: user.schoolId }
    })

    if (!school) {
        return res.status(404).json({ error: 'Škola nenalezena.' })
    }

    // 2. Stripe Customer Logic
    let customerId = school.stripeCustomerId

    // Vytvoření zákazníka, pokud neexistuje
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, 
        name: school.billingName || school.name, 
        metadata: { 
            schoolId: school.id,
            entityType: "SCHOOL" 
        }
      })
      customerId = customer.id

      await prisma.school.update({
        where: { id: school.id },
        data: { stripeCustomerId: customerId }
      })
    } 
    // Pokud už existuje, pro jistotu aktualizujeme údaje (kdyby si je uživatel změnil v adminu)
    else {
        try {
            await stripe.customers.update(customerId, {
                name: school.billingName || school.name,
                 // Pokud bys chtěl posílat i adresu do Stripe (volitelné):
                 /* address: school.billingStreet ? {
                    line1: school.billingStreet,
                    city: school.billingCity,
                    postal_code: school.billingZip,
                    country: school.billingCountry || 'CZ',
                } : undefined */
            });
        } catch (e) {
            console.warn("Nepodařilo se aktualizovat Stripe zákazníka, pokračuji...", e.message);
        }
    }

    // 3. Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      
      // ❌ SMAZÁNO: tax_id_collection: { enabled: true }, 
      // Tímto se zbavíme té chyby. Stripe už nebude řešit daně, jen platbu.

      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],

      success_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/school-admin?success=true`,
      cancel_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/school-admin?canceled=true`,

      subscription_data: {
        metadata: {
          ownerType: "SCHOOL",
          ownerId: school.id,
          planCode: planCode,
          billingPeriod: billingPeriod
        }
      }
    })

    return res.json({ url: session.url })

  } catch (err) {
    console.error('Billing error:', err)
    return res.status(500).json({ error: err.message })
  }
})

// ... (předchozí kód create-checkout-session) ...

/* -------------------------------------------------------
   CREATE PORTAL SESSION (SPRÁVA TARIFU)
-------------------------------------------------------- */
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const user = req.user

    // 1. Zjistíme školu
    if (!user.schoolId) {
        return res.status(400).json({ error: 'Uživatel nemá školu.' })
    }

    const school = await prisma.school.findUnique({
        where: { id: user.schoolId }
    })

    if (!school || !school.stripeCustomerId) {
        return res.status(404).json({ error: 'Škola nemá aktivní Stripe účet.' })
    }

    // 2. Vytvoříme session pro portál
    const session = await stripe.billingPortal.sessions.create({
      customer: school.stripeCustomerId,
      return_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/school-admin`,
    })

    // 3. Pošleme URL zpět na frontend
    res.json({ url: session.url })

  } catch (err) {
    console.error('Portal session error:', err)
    return res.status(500).json({ error: err.message })
  }
})

/* -------------------------------------------------------
   UPDATE SUBSCRIPTION QUANTITY (NAVÝŠENÍ LICENCÍ)
   POST /api/billing/update-quantity
-------------------------------------------------------- */
router.post('/update-quantity', requireAuth, async (req, res) => {
  try {
    const { quantity } = req.body; // Nový celkový počet (např. 11)
    const user = req.user;

    if (!user.schoolId) return res.status(400).json({ error: 'Chybí škola.' });
    if (quantity < 1) return res.status(400).json({ error: 'Množství musí být alespoň 1.' });

    const school = await prisma.school.findUnique({ where: { id: user.schoolId } });
    if (!school || !school.stripeCustomerId) {
        return res.status(404).json({ error: 'Škola nemá aktivní Stripe účet.' });
    }

    // 1. Najdeme aktivní předplatné ve Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: school.stripeCustomerId,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
        return res.status(400).json({ error: 'Nemáte aktivní předplatné k úpravě.' });
    }

    const subscription = subscriptions.data[0];
    const itemId = subscription.items.data[0].id; // ID položky, kterou měníme

    // 2. Aktualizujeme množství
    // proration_behavior: 'always_invoice' znamená, že pokud doplácí, 
    // Stripe hned vystaví a zkusí zaplatit fakturu za rozdíl.
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