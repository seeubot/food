# Use a Node.js base image
FROM node:18-slim

# Install Chromium and other necessary dependencies for Puppeteer / whatsapp-web.js
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm-dev \
    libxkbcommon-dev \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm-dev \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libgconf-2-4 \
    libxi6 \
    libxss1 \
    libxtst6 \
    libappindicator1 \
    fonts-liberation \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy only package.json and package-lock.json to install dependencies early
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the application port
EXPOSE 8080

# Run the application
CMD ["npm", "start"]
