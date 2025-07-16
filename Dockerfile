# Use a Node.js base image
FROM node:18-slim

# Install Chromium and other necessary dependencies for Puppeteer
# These packages are crucial for whatsapp-web.js to run headless Chrome
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
    libnss3 \
    libxrandr2 \
    libxcomposite1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgdk-pixbuf2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libasound2 \
    libnss3 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json (if you have one)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on
EXPOSE 8080

# Command to run the application
CMD ["npm", "start"]

