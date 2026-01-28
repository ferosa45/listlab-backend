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

    // 1. Získáme školu uživatele
    if (!user.schoolId) {
        return res.status(400).json({ error: 'Uživatel nemá školu.' })
    }

    const school = await prisma.school.findUnique({
        where: { id: user.schoolId }
    })

    if (!school) return res.status(404).json({ error: 'Škola nenalezena.' })

    /* -------------------------------------------------------
       2) Stripe Customer Logic (PRO ŠKOLU)
    -------------------------------------------------------- */
    let customerId = school.stripeCustomerId

    // Pokud škola ještě nemá Stripe ID, vytvoříme ho
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, // Email admina
        name: school.billingName || school.name, // Název školy na faktuře
        metadata: { 
            schoolId: school.id,
            entityType: "SCHOOL" 
        }
      })
      customerId = customer.id

      // Uložíme ID zákazníka do DB školy
      await prisma.school.update({
        where: { id: school.id },
        data: { stripeCustomerId: customerId }
      })
    }

    /* -------------------------------------------------------
       3) Create Checkout Session
    -------------------------------------------------------- */
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,
      tax_id_collection: { enabled: true }, // Povolit zadání DIČ

      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],

      success_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/school-admin?success=true`,
      cancel_url: `${process.env.FRONTEND_ORIGIN || 'http://localhost:5173'}/app/school?canceled=true`,

      // 🔥 KLÍČOVÉ: TATO METADATA SI PŘEČTE WEBHOOK
      subscription_data: {
        metadata: {
          ownerType: "SCHOOL",    // Říkáme webhooku: Platí škola
          ownerId: school.id,     // ID školy
          planCode: planCode,     // TEAM_YEARLY atd.
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

export default router