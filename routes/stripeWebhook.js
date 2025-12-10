// routes/stripeWebhook.js
import express from 'express'
import Stripe from 'stripe'
import { prisma } from "../src/lib/prisma.js"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const router = express.Router()

// IMPORTANT: RAW BODY
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
    console.error('❌ Webhook signature error:', err.message)
    return res.status(400).send()
  }

  console.log("➡️ Webhook received:", event.type)

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object
      await processCheckoutSession(session)
      break
    }

    case 'customer.subscription.created': {
      const subscription = event.data.object
      await syncSubscription(subscription)
      break
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object
      await syncSubscription(subscription)
      break
    }

    /* ------------------------------------------------------
       🔥 FIX: invoice.payment_succeeded → použít periodu z invoice
    ------------------------------------------------------ */
    case 'invoice.payment_failed':
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object

      if (invoice.subscription) {

        // 1) Načti subscription objekt
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription)

        // 2) Najdi invoice line item
        const line = invoice?.lines?.data?.[0]

        const periodStart = line?.period?.start
          ? new Date(line.period.start * 1000)
          : null

        const periodEnd = line?.period?.end
          ? new Date(line.period.end * 1000)
          : null

        // 3) Předáme override s periodou
        await syncSubscription(subscription, {
          periodStart,
          periodEnd
        })
      }
      break
    }

    default:
      console.log('ℹ️ Ignored event:', event.type)
  }

  res.json({ received: true })
})


/* -------------------------------------------------------
   Process Checkout → load subscription → sync
-------------------------------------------------------- */
async function processCheckoutSession(session) {
  const subscriptionId = session.subscription

  if (!subscriptionId) {
    console.error("⚠️ checkout.session.completed WITHOUT subscriptionId!")
    return
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId)
  await syncSubscription(subscription)
}


/* -------------------------------------------------------
   Sync Subscription → DB
   (nově: přijímá overrides s periodStart / periodEnd)
-------------------------------------------------------- */
async function syncSubscription(subscription, overrides = {}) {
  console.log("🔄 Syncing subscription", subscription.id)

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
    planCode: meta.planCode || "UNKNOWN",
    billingPeriod: item.price.recurring.interval,
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    stripePriceId: item.price.id,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,

    // 🔥 New: preferujeme INVOICE period (overrides)
    currentPeriodStart:
      overrides.periodStart ??
      (subscription.current_period_start
        ? new Date(subscription.current_period_start * 1000)
        : null),

    currentPeriodEnd:
      overrides.periodEnd ??
      (subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null),

    seatLimit: meta.seatLimit ? Number(meta.seatLimit) : null
  }

  await prisma.subscription.upsert({
    where: { stripeSubscriptionId: subscription.id },
    update: data,
    create: data,
  })

  await updateOwnerStatus(data)

  console.log("✅ Subscription synced:", subscription.id)
}


/* -------------------------------------------------------
   Update USER or SCHOOL
-------------------------------------------------------- */
async function updateOwnerStatus(data) {
  const updates = {
    subscriptionStatus: data.status,
    subscriptionPlan: data.planCode,
    subscriptionUntil: data.currentPeriodEnd,
    stripeCustomerId: data.stripeCustomerId,
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
