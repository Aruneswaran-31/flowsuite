import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './db.js';

const port = Number(process.env.PORT ?? 4000);
const server = app.listen(port, () => console.log(`FlowSuite API listening on port ${port}`));

async function shutdown() { server.close(async () => { await prisma.$disconnect(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
