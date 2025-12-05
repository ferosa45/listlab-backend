// routes/stripeWebhook.js
import express from 'express'
import Stripe from 'stripe'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const router = express.Router()

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    console.error('Webhook error:', err.message)
    return res.status(400).send()
  }

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object
      await processCheckoutSession(session)
      break
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      await syncSubscription(subscription)
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object
      if (invoice.subscription) {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription)
        await syncSubscription(subscription)
      }
      break
    }

    default:
      console.log('Ignored event:', event.type)
  }

  res.json({ received: true })
})

/* ---------------- CORE FUNCTIONS ---------------- */

async function processCheckoutSession(session) {
  const subscriptionId = session.subscription

  if (!subscriptionId) {
    console.error("⚠️ checkout.session.completed WITHOUT subscriptionId!")
    return
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  await syncSubscription(subscription)
}

async function syncSubscription(subscription) {
  const item = subscription.items.data[0]
  const meta = subscription.metadata || {}

  const ownerType = meta.ownerType || "USER"
  const ownerId = meta.ownerId || null

  if (!ownerId) {
    console.error("❌ ERROR: Missing ownerId in Stripe metadata")
    return
  }

  const data = {
    ownerType,
    ownerId,
    planCode: meta.planCode || null,
    billingPeriod: item.price.recurring.interval,
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    stripePriceId: item.price.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,

    currentPeriodStart: subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000)
      : null,

    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,

    seatLimit: meta.seatLimit ? Number(meta.seatLimit) : null
  }

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    update: data,
    create: data,
  })

  await updateOwnerStatus(data)
}

/* ---------------- OWNER LOGIC ---------------- */

async function updateOwnerStatus(data) {
  const updates = {
    subscriptionStatus: data.status,
    subscriptionPlan: data.planCode,
    subscriptionUntil: data.currentPeriodEnd,
    stripeCustomerId: data.stripeCustomerId,   // ← DŮLEŽITÉ FIX
  }

  if (data.ownerType === 'USER') {
    await prisma.user.update({
      where: { id: data.ownerId },
      data: updates
    })
  }

  if (data.ownerType === 'SCHOOL') {
    await prisma.school.update({
      where: { id: data.ownerId },
      data: updates
    })
  }
}

export default router
