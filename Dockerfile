# --- build stage ---
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
# installs EVERYTHING, including devDependencies
RUN npm ci             
COPY . .
# produces dist/ — this stage's whole reason to exist
RUN npm run build
# dashboard/ is a separate npm project (its own package.json/node_modules) —
# building it here too, in the same stage, so its dist/ can be pulled into
# the production image the same way ./dist is below
RUN npm ci --prefix dashboard
RUN npm run build --prefix dashboard

# --- production stage ---
# <-- a completely FRESH image, nothing carried over automatically
FROM node:20-slim AS production
WORKDIR /app
COPY package*.json ./
# installs ONLY real dependencies, no devDependencies at all
RUN npm ci --omit=dev
# manually pull ONLY the compiled output from the other stage
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
# tsc only compiles .ts files, so the raw .sql migrations and meta/_journal.json
# aren't part of dist/ — migrate.ts expects them alongside the compiled db/ output
COPY --from=build /app/src/db/migrations ./dist/db/migrations
EXPOSE 8080

# Node auto-sizes its old-space heap ceiling from the cgroup memory limit,
# leaving it almost exactly at 256M under the brief's app-container limit —
# zero headroom for RSS outside the heap (buffers, native memory, thread
# stacks), risking OOM kills / heavy GC thrashing under sustained load.
# Cap it explicitly, leaving real headroom.
CMD ["node", "--max-old-space-size=176", "dist/index.js"]