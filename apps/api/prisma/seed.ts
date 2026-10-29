import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const plans = [
  { code: 'FREE', name: 'Free', monthlyPrice: 0, seatLimit: 3, projectLimit: 2, apiRequestLimit: 1000, entitlements: { advancedAnalytics: false, auditExport: false, customRoles: false } },
  { code: 'STARTER', name: 'Starter', monthlyPrice: 49900, seatLimit: 10, projectLimit: 20, apiRequestLimit: 10000, entitlements: { advancedAnalytics: false, auditExport: false, customRoles: false } },
  { code: 'PROFESSIONAL', name: 'Professional', monthlyPrice: 99900, seatLimit: 50, projectLimit: -1, apiRequestLimit: 100000, entitlements: { advancedAnalytics: true, auditExport: true, customRoles: true } },
];

async function main() {
  for (const plan of plans) {
    await prisma.plan.upsert({ where: { code: plan.code }, update: plan, create: plan });
  }
}

main().finally(() => prisma.$disconnect());
