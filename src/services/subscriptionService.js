// server/services/subscriptionService.js
import db from '../db.js'; 
// db je tvůj pool/klient, podle toho jak to máš v projektu. Pokud ne, upravíme.


/**
 * Vrátí aktivní subscription podle toho,
 * jestli je user samostatný, nebo člen školy.
 * 
 * @param {Object} user - objekt přihlášeného uživatele
 * @returns {Promise<Object|null>}
 */
export async function getActiveSubscriptionForUserOrSchool(user) {
  let ownerType, ownerId;

  // pokud má user.school_id → patří do školního plánu
  if (user.school_id) {
    ownerType = 'school';
    ownerId = user.school_id;
  } else {
    ownerType = 'user';
    ownerId = user.id;
  }

  const result = await db.query(
    `
    SELECT *
    FROM subscriptions
    WHERE owner_type = $1
      AND owner_id = $2
      AND is_active = TRUE
      AND (valid_to IS NULL OR valid_to > NOW())
    ORDER BY valid_from DESC
    LIMIT 1
    `,
    [ownerType, ownerId]
  );

  return result.rows[0] || null;
}
