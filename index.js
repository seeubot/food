// index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // Use 'qrcode' for generating image data URLs
const express = require('express');
const path = require('path');
const fs = require('fs').promises; // Use promises version of fs for async/await

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 8080; // Koyeb uses PORT environment variable

// Serve static files (optional, but good for a basic web interface)
app.use(express.static(path.join(__dirname, 'public')));

// Variables to store the QR code data URL and client status
let qrCodeDataURL = null;
let clientReady = false;

// Path to store the session data
const SESSION_DIR_PATH = './.wwebjs_auth'; // Directory for session files

// Ensure session directory exists
(async () => {
    try {
        await fs.mkdir(SESSION_DIR_PATH, { recursive: true });
        console.log('Session directory ensured:', SESSION_DIR_PATH);
    } catch (err) {
        console.error('Error ensuring session directory:', err);
    }
})();

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: SESSION_DIR_PATH // Directory to store session files
    }),
    puppeteer: {
        headless: true, // Run Chrome in headless mode (no GUI)
        args: [
            '--no-sandbox', // Required for Docker/containerized environments
            '--disable-setuid-sandbox', // Required for Docker/containerized environments
            '--disable-dev-shm-usage', // Overcomes limited resource problems
            '--disable-accelerated-video-decode',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu', // Disable GPU hardware acceleration
            '--single-process' // Use a single single process instead of multiple
        ]
    }
});

// Event: QR Code Generated
client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    // Generate data URL for the QR code
    qrcode.toDataURL(qr, { small: false }, (err, url) => { // Using small: false for better resolution on web
        if (err) {
            console.error('Error generating QR code data URL:', err);
            qrCodeDataURL = null;
        } else {
            qrCodeDataURL = url;
            console.log('QR code available at / endpoint');
        }
    });
});

// Event: Client Ready
client.on('ready', () => {
    console.log('Client is ready!');
    clientReady = true;
    qrCodeDataURL = null; // Clear QR code once connected
    console.log('WhatsApp bot is connected and operational.');
});

// Event: Authenticated
client.on('authenticated', (session) => {
    console.log('AUTHENTICATED', session);
    // LocalAuth strategy handles saving the session automatically.
});

// Event: Authentication Failure
client.on('auth_failure', async msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    console.log('Attempting to re-authenticate. You might need to scan QR again.');
    clientReady = false; // Reset ready state
    qrCodeDataURL = null; // Clear old QR code

    // Attempt to delete session files to force a new QR scan
    try {
        const files = await fs.readdir(SESSION_DIR_PATH);
        for (const file of files) {
            if (file.startsWith('session-')) { // LocalAuth creates files like session-data.json
                await fs.unlink(path.join(SESSION_DIR_PATH, file));
                console.log(`Deleted old session file: ${file}`);
            }
        }
        console.log('Deleted old session files. Please restart the bot to get a new QR code.');
    } catch (err) {
        console.error('Error deleting old session files:', err);
    }
    // Re-initialize to get a new QR code
    client.initialize();
});

// Event: Disconnected
client.on('disconnected', (reason) => {
    console.log('Client disconnected', reason);
    clientReady = false; // Reset ready state
    qrCodeDataURL = null; // Clear old QR code
    console.log('Attempting to re-initialize...');
    client.initialize(); // Attempt to re-initialize the client
});

// Event: Message Received
client.on('message', msg => {
    console.log('MESSAGE RECEIVED', msg.body);

    // Simple echo bot: replies with the same message
    if (msg.body) {
        msg.reply(`You said: "${msg.body}"`);
    }

    // Example of a command-based response
    if (msg.body === '!ping') {
        msg.reply('Pong!');
    } else if (msg.body === '!status') {
        msg.reply('I am online and ready to chat!');
    }
});

// Initialize the WhatsApp client
client.initialize();

// --- Express Routes ---

// Main endpoint to display bot status and QR code
app.get('/', async (req, res) => {
    try {
        let htmlContent = await fs.readFile(path.join(__dirname, 'bot_status.html'), 'utf8');

        // Hide all status sections initially
        htmlContent = htmlContent.replace(/<div id="(loading-state|qr-code-state|connected-state)" class="status-section/g, '<div id="$1" class="status-section hidden');

        if (clientReady) {
            // Show connected state
            htmlContent = htmlContent.replace('<div id="connected-state" class="status-section hidden', '<div id="connected-state" class="status-section');
        } else if (qrCodeDataURL) {
            // Show QR code state and inject QR code data URL
            htmlContent = htmlContent.replace('<div id="qr-code-state" class="status-section hidden', '<div id="qr-code-state" class="status-section');
            htmlContent = htmlContent.replace('src="" alt="WhatsApp QR Code"', `src="${qrCodeDataURL}" alt="WhatsApp QR Code"`);
        } else {
            // Show loading state
            htmlContent = htmlContent.replace('<div id="loading-state" class="status-section hidden', '<div id="loading-state" class="status-section');
        }

        res.send(htmlContent);

    } catch (error) {
        console.error('Error serving bot_status.html:', error);
        res.status(500).send('<h1>Error loading bot status page.</h1><p>Please check server logs.</p>');
    }
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('Waiting for WhatsApp client to be ready...');
    console.log('Visit the root URL of your deployment to check status and scan the QR.');
});

