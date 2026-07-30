FROM node:20-alpine

# Install openssl for HTTPS certificate generation
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8084

CMD ["node", "server.js"]
