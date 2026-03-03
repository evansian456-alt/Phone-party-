/**
 * Authentication Middleware and Utilities (Server-side)
 * Handles JWT tokens, password hashing, and auth middleware
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { isValidEmail, isValidPassword } = require('./auth-utils');

if (!process.env.JWT_SECRET) {
  throw new Error('[Auth] JWT_SECRET environment variable is required');
}
const JWT_SECRET = process.env.JWT_SECRET;

if (process.env.NODE_ENV !== 'production') {
  console.warn('[Auth] WARNING: Using JWT secret - development mode');
}

const JWT_EXPIRES_IN = '7d'; // JWT token expires in 7 days
const SALT_ROUNDS = 10;

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Express middleware to check authentication
 * Reads JWT from cookie and adds user info to req.user
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  req.user = decoded;
  next();
}

/**
 * Optional auth middleware - adds user to req if authenticated, but doesn't require it
 */
function optionalAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = decoded;
    }
  }
  
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  isValidEmail,
  isValidPassword
};
