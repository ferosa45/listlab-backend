// api/utils/authCookies.js

/**
 * Zjistí, jestli request běží přes HTTPS
 * (Railway / reverse proxy posílá x-forwarded-proto)
 */
function isHttps(req) {
  return (
    req.secure === true ||
    req.headers["x-forwarded-proto"] === "https"
  );
}

/**
 * Nastaví auth cookie s JWT tak,
 * aby fungovala:
 * - lokálně (localhost + HTTP)
 * - v produkci (HTTPS + cross-site)
 */
export function setAuthCookie(req, res, token) {
  const secure = isHttps(req);

  res.cookie("token", token, {
    httpOnly: true,
    secure,                       // 🔥 jen pokud HTTPS
    sameSite: secure ? "None" : "Lax",
    path: "/",
  });
}

/**
 * (volitelné) Smazání auth cookie – logout
 */
export function clearAuthCookie(res) {
  res.clearCookie("token", {
    path: "/",
  });
}
