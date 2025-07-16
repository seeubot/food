// index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const path = require('path');
const fs = require('fs'); // Required for session management

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 8080; // Koyeb uses PORT environment variable

// Serve static files (optional, but good for a basic web interface)
app.use(express.static(path.join(__dirname, 'public')));

// Basic route for health check or status
app.get('/', (req, res) => {
    res.send('WhatsApp Bot Server is running! Check console for QR code if not connected.');
});

// Path to store the session data
const SESSION_FILE_PATH = './session.json';

// Load the session data if it exists
let sessionCfg;
if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionCfg = require(SESSION_FILE_PATH);
}

// Initialize WhatsApp Client
// Using LocalAuth for session management, which saves session data to a file.
// Puppeteer arguments are crucial for running in a headless environment like Koyeb.
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth' // Directory to store session files
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
            '--single-process' // Use a single process instead of multiple
        ]
    }
});

// Event: QR Code Generated
// This event emits a QR code string that needs to be scanned by your WhatsApp mobile app.
client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true }); // Generate and display QR code in terminal
    console.log('Please scan the QR code above with your WhatsApp app to connect the bot.');
    console.log('If you are deploying on Koyeb, you will see this QR code in your deployment logs.');
});

// Event: Client Ready
// This event fires when the client is successfully authenticated and ready to send/receive messages.
client.on('ready', () => {
    console.log('Client is ready!');
    console.log('WhatsApp bot is connected and operational.');
});

// Event: Authenticated
// This event fires after successful authentication. You can save session data here.
client.on('authenticated', (session) => {
    console.log('AUTHENTICATED', session);
    // You can uncomment the following line if you want to manually save the session
    // However, LocalAuth strategy handles this automatically.
    // fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function (err) {
    //     if (err) {
    //         console.error('Error saving session:', err);
    //     }
    // });
});

// Event: Authentication Failure
// This event fires if authentication fails (e.g., session invalid).
client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    console.log('Attempting to re-authenticate. You might need to scan QR again.');
    // Optionally, delete session file to force a new QR scan
    if (fs.existsSync(SESSION_FILE_PATH)) {
        fs.unlinkSync(SESSION_FILE_PATH);
        console.log('Deleted old session file. Please restart the bot to get a new QR code.');
    }
});

// Event: Disconnected
// This event fires when the client is disconnected.
client.on('disconnected', (reason) => {
    console.log('Client disconnected', reason);
    console.log('Attempting to re-initialize...');
    client.initialize(); // Attempt to re-initialize the client
});

// Event: Message Received
// This is the core logic for your bot to respond to messages.
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

// Start the Express server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('Waiting for WhatsApp client to be ready...');
});


