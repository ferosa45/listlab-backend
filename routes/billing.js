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
    // 👇 OPRAVA: Přidáno čtení quantity z požadavku (defaultně 1)
    const { priceId, planCode, billingPeriod, quantity = 1 } = req.body
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
                ownerType: 'SCHOOL'
            }
        })
        customerId = customer.id
        
        await prisma.school.update({
            where: { id: school.id },
            data: { stripeCustomerId: customerId }
        })
    }

    // 3. Vytvoření Checkout Session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      
      line_items: [
        {
          price: priceId,
          // 👇 OPRAVA: Zde použijeme dynamické množství (např. 10)
          quantity: quantity 
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
    console.error('Stripe Checkout Error:', err)
    return res.status(500).json({ error: err.message })
  }
})

/* -------------------------------------------------------
   CREATE PORTAL SESSION (SPRÁVA TARIFU)
-------------------------------------------------------- */
router.post('/create-portal-session', requireAuth, async (req, res) => {
  try {
    const user = req.user

    if (!user.schoolId) {
        return res.status(400).json({ error: 'Uživatel nemá školu.' })
    }

    const school = await prisma.school.findUnique({
        where: { id: user.schoolId }
    })

    if (!school || !school.stripeCustomerId) {
        return res.status(404).json({ error: 'Škola nemá aktivní Stripe účet.' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: school.stripeCustomerId,
      return_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/school-admin`,
    })

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
    const { quantity } = req.body; 
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
    const itemId = subscription.items.data[0].id; 

    // 2. Aktualizujeme množství
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