FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /data

ENV PORT=9292
ENV NODE_ENV=production

EXPOSE 9292

CMD ["node", "server.js"]
