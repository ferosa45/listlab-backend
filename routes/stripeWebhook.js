import express from 'express'
import Stripe from 'stripe'
import prisma from '../prisma.js'

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
  const subscription = await stripe.subscriptions.retrieve(subscriptionId)

  await syncSubscription(subscription)
}

async function syncSubscription(subscription) {
  const item = subscription.items.data[0]
  const meta = subscription.metadata

  const data = {
    ownerType: meta.ownerType,
    ownerId: meta.ownerId,
    planCode: meta.planCode,
    billingPeriod: item.price.recurring.interval,
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    stripePriceId: item.price.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: new Date(subscription.current_period_start * 1000),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
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
  const isActive = ['active', 'trialing'].includes(data.status)

  if (data.ownerType === 'USER') {
    await prisma.user.update({
      where: { id: data.ownerId },
      data: {
        subscriptionStatus: data.status,
        subscriptionPlan: data.planCode,
        subscriptionUntil: data.currentPeriodEnd,
      }
    })
  }

  if (data.ownerType === 'SCHOOL') {
    await prisma.school.update({
      where: { id: data.ownerId },
      data: {
        subscriptionStatus: data.status,
        subscriptionPlan: data.planCode,
        subscriptionUntil: data.currentPeriodEnd,
      }
    })
  }
}

export default router
