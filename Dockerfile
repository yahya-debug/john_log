# --- build stage ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
# installs EVERYTHING, including devDependencies
RUN npm ci                    
COPY . .
# produces dist/ — this stage's whole reason to exist
RUN npm run build             

# --- production stage ---
# <-- a completely FRESH image, nothing carried over automatically
FROM node:20-slim AS production
WORKDIR /app
COPY package*.json ./
# installs ONLY real dependencies, no devDependencies at all
RUN npm ci --omit=dev
# manually pull ONLY the compiled output from the other stage
COPY --from=build /app/dist ./dist
# tsc only compiles .ts files, so the raw .sql migrations and meta/_journal.json
# aren't part of dist/ — migrate.ts expects them alongside the compiled db/ output
COPY --from=build /app/src/db/migrations ./dist/db/migrations
EXPOSE 8080
CMD ["node", "dist/index.js"]