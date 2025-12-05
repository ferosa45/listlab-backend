// api/routes/billing.js
import express from 'express'
import Stripe from 'stripe'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

const router = express.Router()
const prisma = new PrismaClient()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

/* -------------------------------------------------------
   SIMPLE AUTH (stejný jako v server.js)
-------------------------------------------------------- */
function requireAuth(req, res, next) {
  try {
    const token =
      req.cookies?.token || req.headers.authorization?.split(" ")[1]

    const data = jwt.verify(token, process.env.JWT_SECRET)
    req.user = data
    next()
  } catch {
    return res.status(401).json({ error: "Unauthorized" })
  }
}

/* -------------------------------------------------------
   CREATE CHECKOUT SESSION
-------------------------------------------------------- */
router.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const { priceId, planCode, billingPeriod } = req.body

    if (!priceId || !planCode || !billingPeriod) {
      return res.status(400).json({ error: 'Missing billing parameters' })
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })

    /* -------------------------------------------------------
       1) Ensure Stripe customer exists
    -------------------------------------------------------- */
    let customerId = user.stripeCustomerId

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          userId: user.id
        }
      })

      customerId = customer.id

      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId }
      })
    }

    /* -------------------------------------------------------
       2) Create checkout session
    -------------------------------------------------------- */
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer: customerId,

      line_items: [
        {
          price: priceId,
          quantity: 1,
        }
      ],

      /* FRONTEND REDIRECT */
      success_url: `${process.env.FRONTEND_ORIGIN}/billing/success`,
      cancel_url: `${process.env.FRONTEND_ORIGIN}/billing/cancel`,

      /* ❗ Checkout metadata – NEPROPISUJE SE do subscription */
      metadata: {
        planCode
      },

      /* ✔ Subscription metadata – přenáší se do webhooku */
      subscription_data: {
        metadata: {
          ownerType: "USER",
          ownerId: user.id,
          planCode,
          billingPeriod
        }
      }
    })

    res.json({ url: session.url })

  } catch (err) {
    console.error('Checkout error:', err)
    res.status(500).json({ error: 'Checkout session failed' })
  }
})

export default router
