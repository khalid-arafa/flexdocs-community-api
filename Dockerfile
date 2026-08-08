# Use official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

COPY . .
RUN npm ci

# Start the app
CMD ["npm", "run", "dev"]
# CMD ["npm", "run", "start"]
