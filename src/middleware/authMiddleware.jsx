import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

export function requireAuth(req, res, next) {
  try {
    const token =
      req.cookies?.token ||
      req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    // 🔥 NORMALIZACE PAYLOADU
    req.user = {
      id: decoded.id || decoded.userId,
      email: decoded.email,
      role: decoded.role,
      schoolId: decoded.schoolId ?? null,
    };

    if (!req.user.id) {
      return res.status(401).json({
        ok: false,
        error: "Invalid token payload",
      });
    }

    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}
