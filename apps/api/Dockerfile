FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/api apps/api
RUN npm run db:generate --workspace @flowsuite/api && npm run build --workspace @flowsuite/api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "run", "start", "--workspace", "@flowsuite/api"]
