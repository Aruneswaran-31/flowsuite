import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { AuthContext } from '../db.js';
import { prisma } from '../db.js';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be configured in production');
}
const secret = jwtSecret ?? 'local-development-only-change-before-deploy';
const hashOpaqueToken = (value: string) => createHash('sha256').update(value).digest('hex');

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
export const accessTokenFor = (user: AuthContext) => jwt.sign(user, secret, { expiresIn: '15m', issuer: 'flowsuite' });
export const verifyAccessToken = (token: string) => jwt.verify(token, secret, { issuer: 'flowsuite' }) as AuthContext;

export async function issueRefreshToken(userId: string) {
  const token = randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({ data: { userId, tokenHash: hashOpaqueToken(token), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
  return token;
}

export { hashOpaqueToken };
