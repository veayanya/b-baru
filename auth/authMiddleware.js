// ============================================================
// Auth Middleware — RBAC untuk RKA AI Bapperida
// (Admin, Moderator, User) dengan dukungan Dual-Token (Cookie + Bearer Header)
// ============================================================
import jwt from 'jsonwebtoken';

export const JWT_SECRET = process.env.JWT_SECRET || 'bapperida-rka-jwt-secret-2026-permanen-key-v1';

/**
 * Ekstrak token dari Cookie httpOnly atau Header Authorization: Bearer <token>
 */
export function extractToken(req) {
 if (req.cookies?.authToken) {
 return req.cookies.authToken;
 }
 const authHeader = req.headers.authorization || req.headers.Authorization;
 if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
 return authHeader.slice(7).trim();
 }
 return null;
}

/**
 * Middleware: Wajib sudah login (token valid di cookie atau header)
 */
export function requireAuth(req, res, next) {
 try {
 const token = extractToken(req);
 if (!token) {
 return res.status(401).json({ error: 'Sesi tidak ditemukan. Silakan login terlebih dahulu.' });
 }
 const decoded = jwt.verify(token, JWT_SECRET);
 req.user = decoded; // { id, username, role, name }
 next();
 } catch (err) {
 return res.status(401).json({ error: 'Sesi tidak valid atau sudah kedaluwarsa. Silakan login kembali.' });
 }
}

/**
 * Middleware: Opsional login (jika ada token, pasang req.user; jika tidak, tetap lanjut)
 */
export function optionalAuth(req, res, next) {
 try {
 const token = extractToken(req);
 if (token) {
 const decoded = jwt.verify(token, JWT_SECRET);
 req.user = decoded;
 }
 } catch {}
 next();
}

/**
 * Middleware Factory: Wajib memiliki role tertentu
 * @param {...string} roles - 'admin' | 'moderator' | 'user'
 */
export function requireRole(...roles) {
 return (req, res, next) => {
 if (!req.user) {
 return res.status(401).json({ error: 'Belum terautentikasi.' });
 }
 // Admin selalu memiliki akses ke semua resource yang diizinkan untuk moderator/user
 if (req.user.role === 'admin' || roles.includes(req.user.role)) {
 return next();
 }
 return res.status(403).json({ error: 'Akses ditolak. Anda tidak memiliki izin untuk fitur ini.' });
 };
}

/**
 * Generate JWT token (berlaku 7 hari permanen)
 */
export function generateToken(user) {
 return jwt.sign(
 { id: user.id, username: user.username, role: user.role, name: user.name },
 JWT_SECRET,
 { expiresIn: '7d' }
 );
}

/**
 * Set auth cookie (httpOnly — berlaku 7 hari)
 */
export function setAuthCookie(res, token) {
 const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
 res.cookie('authToken', token, {
 httpOnly: true,
 secure: isProduction,
 sameSite: isProduction ? 'none' : 'lax',
 maxAge: 7 * 24 * 60 * 60 * 1000 // 7 hari
 });
}

/**
 * Clear auth cookie
 */
export function clearAuthCookie(res) {
 const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
 res.clearCookie('authToken', {
 httpOnly: true,
 secure: isProduction,
 sameSite: isProduction ? 'none' : 'lax'
 });
}

