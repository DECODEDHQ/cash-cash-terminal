FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["npm", "start"]
