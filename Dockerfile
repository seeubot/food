# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Install necessary system dependencies for Chromium
# These packages are required for Puppeteer to run headless Chrome
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    udev \
    # Add other common dependencies that might be missing
    git \
    openssh-client \
    python3 \
    make \
    g++ \
    dumb-init # A small init system to properly handle signals for Node.js process

# Set dumb-init as the entrypoint to handle signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Install app dependencies
# A wildcard is used to ensure both package.json and package-lock.json are copied
COPY package*.json ./

# Install dependencies
# Set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true because we are installing chromium system-wide
# Set PUPPETEER_EXECUTABLE_PATH to use the system-installed chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Run the application
CMD [ "npm", "start" ]

