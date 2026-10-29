import { PrismaClient, type Role } from '@prisma/client';
import type { Request } from 'express';

export const prisma = new PrismaClient();

export type AuthContext = {
  userId: string;
  name: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: Role;
};

declare global {
  namespace Express {
    interface Request {  auth: AuthContext }
  }
}

export type AuthenticatedRequest = Request & {  auth: AuthContext };
