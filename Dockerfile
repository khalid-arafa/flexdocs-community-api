# Use official Node.js image
FROM node:18-alpine

# Set working directory
WORKDIR /app

COPY . .
RUN npm install

# Start the app
CMD ["npm", "run", "dev"]
# CMD ["npm", "run", "start"]
