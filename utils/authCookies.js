// api/utils/authCookies.js

function isHttps(req) {
  // 🛡️ obrana proti undefined req
  if (!req) return false;

  // Express secure flag
  if (req.secure === true) return true;

  // Reverse proxy (Railway)
  if (req.headers && req.headers["x-forwarded-proto"] === "https") {
    return true;
  }

  return false;
}

export function setAuthCookie(req, res, token) {
  const secure = isHttps(req);

  res.cookie("token", token, {
    httpOnly: true,
    secure,                       // HTTPS only, pokud je
    sameSite: secure ? "None" : "Lax",
    path: "/",
  });
}

export function clearAuthCookie(res) {
  res.clearCookie("token", {
    path: "/",
  });
}
