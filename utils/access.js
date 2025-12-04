// utils/access.js

export function hasPremiumAccess(entity) {
  if (!entity) return false

  return (
    entity.subscriptionStatus === 'active' ||
    entity.subscriptionStatus === 'trialing'
  )
}
