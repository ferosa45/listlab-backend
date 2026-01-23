const isProd = process.env.NODE_ENV === "production";

export function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: isProd,                 // 🔥 jen v produkci
    sameSite: isProd ? "None" : "Lax",
    path: "/",
  });
}
