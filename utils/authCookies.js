export function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    secure: true,     // Railway / HTTPS
    sameSite: "None",
    path: "/",
  });
}
