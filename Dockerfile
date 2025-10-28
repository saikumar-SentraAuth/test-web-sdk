# --- Build stage: compile frontend ---
FROM node:20 AS build
WORKDIR /app
COPY package.json ./
COPY frontend/package.json frontend/package.json
COPY server/package.json server/package.json
RUN npm install
COPY frontend ./frontend
RUN npm run build

# --- Runtime stage: serve via Express ---
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/server /app/server
COPY package.json ./
RUN npm install --omit=dev --workspace server
WORKDIR /app/server
EXPOSE 8080
CMD ["npm", "start"]
