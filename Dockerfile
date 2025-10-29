# --- Build stage: compile frontend ---
FROM node:20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY frontend ./frontend
COPY server ./server
RUN npm run build

# --- Runtime stage: serve via Express ---
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/server /app/server
RUN npm ci --omit=dev --workspace server
WORKDIR /app/server
EXPOSE 8080
CMD ["npm", "start"]
