const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
let db;

// Connect to MongoDB
async function connectToMongoDB() {
    try {
        const client = await MongoClient.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');
        db = client.db('foodiebot');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Set the base URL for Koyeb deployment
const BASE_URL = 'https://random-tiena-school1660440-c68d25b7.koyeb.app';

// Bot state
let botState = {
    qrCode: null,
    isAuthenticated: false,
    connectedSessions: 0,
    status: 'initializing',
    lastActivity: new Date(),
    webhookUrl: process.env.WEBHOOK_URL
};

// User session management
const userSessions = new Map();

// WhatsApp Client with enhanced configuration for production
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.WHATSAPP_SESSION_PATH || './whatsapp-session'
    }),
    puppeteer: { 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
        ]
    }
});

// Webhook function to notify external services
async function sendWebhook(event, data) {
    if (!process.env.WEBHOOK_URL) return;
    
    try {
        const webhookPayload = {
            event,
            timestamp: new Date().toISOString(),
            data,
            bot_id: 'foodiebot-' + (process.env.NODE_ENV || 'development')
        };

        const response = await fetch(process.env.WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
                'User-Agent': 'FoodieBot-Webhook/1.0'
            },
            body: JSON.stringify(webhookPayload)
        });

        if (response.ok) {
            console.log(`📡 Webhook sent successfully: ${event}`);
        } else {
            console.warn(`⚠️ Webhook failed: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
    }
}

// Enhanced WhatsApp Event Handlers with Webhook Support
client.on('qr', async (qr) => {
    console.log('\n🔄 Generating QR Code...');
    
    try {
        botState.qrCode = await qrcode.toDataURL(qr);
        botState.isAuthenticated = false;
        botState.status = 'waiting_for_scan';
        botState.lastActivity = new Date();
        
        console.log('✅ QR Code generated successfully!');
        console.log('🌐 QR Code available at:', `${BASE_URL}/qr`);
        
        // Send webhook notification
        await sendWebhook('qr_generated', {
            status: botState.status,
            qr_available: true
        });
        
    } catch (error) {
        console.error('❌ Error generating QR code:', error);
    }
});

client.on('ready', async () => {
    console.log('\n🎉 SUCCESS! WhatsApp bot is ready and connected!');
    console.log('✅ Bot is now active and can receive messages');
    
    botState.isAuthenticated = true;
    botState.connectedSessions = 1;
    botState.qrCode = null;
    botState.status = 'connected';
    botState.lastActivity = new Date();
    
    // Send webhook notification
    await sendWebhook('bot_ready', {
        status: 'connected',
        phone: client.info?.wid?.user || 'unknown',
        name: client.info?.pushname || 'unknown'
    });
});

client.on('authenticated', async () => {
    console.log('🔐 WhatsApp authenticated successfully');
    botState.isAuthenticated = true;
    botState.status = 'authenticated';
    botState.lastActivity = new Date();
    
    await sendWebhook('authenticated', { status: 'authenticated' });
});

client.on('auth_failure', async (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    botState.isAuthenticated = false;
    botState.qrCode = null;
    botState.status = 'auth_failed';
    
    await sendWebhook('auth_failure', { error: msg });
});

client.on('disconnected', async (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
    botState.isAuthenticated = false;
    botState.connectedSessions = 0;
    botState.status = 'disconnected';
    
    await sendWebhook('disconnected', { reason });
});

// QR Code endpoint - Fixed and enhanced
app.get('/qr', (req, res) => {
    if (!botState.qrCode) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>FoodieBot - QR Code</title>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        min-height: 100vh;
                        margin: 0;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        color: white;
                    }
                    .container {
                        text-align: center;
                        background: rgba(255, 255, 255, 0.1);
                        padding: 2rem;
                        border-radius: 15px;
                        backdrop-filter: blur(10px);
                        box-shadow: 0 8px 32px rgba(31, 38, 135, 0.37);
                    }
                    .status {
                        font-size: 1.2rem;
                        margin-bottom: 1rem;
                    }
                    .refresh-btn {
                        background: #4CAF50;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        border-radius: 5px;
                        cursor: pointer;
                        font-size: 1rem;
                        margin-top: 1rem;
                    }
                    .refresh-btn:hover {
                        background: #45a049;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🤖 FoodieBot</h1>
                    <div class="status">
                        Status: ${botState.status === 'connected' ? '✅ Connected' : '⏳ ' + botState.status}
                    </div>
                    ${botState.status === 'connected' 
                        ? '<p>✅ Bot is already connected and ready!</p>' 
                        : '<p>⏳ QR Code not available yet. Please wait...</p>'
                    }
                    <button class="refresh-btn" onclick="window.location.reload()">🔄 Refresh</button>
                    <script>
                        // Auto-refresh every 3 seconds if not connected
                        if ('${botState.status}' !== 'connected') {
                            setTimeout(() => window.location.reload(), 3000);
                        }
                    </script>
                </div>
            </body>
            </html>
        `);
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>FoodieBot - Scan QR Code</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                }
                .container {
                    text-align: center;
                    background: rgba(255, 255, 255, 0.1);
                    padding: 2rem;
                    border-radius: 15px;
                    backdrop-filter: blur(10px);
                    box-shadow: 0 8px 32px rgba(31, 38, 135, 0.37);
                }
                .qr-code {
                    background: white;
                    padding: 20px;
                    border-radius: 10px;
                    display: inline-block;
                    margin: 20px 0;
                }
                .qr-code img {
                    max-width: 300px;
                    height: auto;
                }
                .instructions {
                    max-width: 400px;
                    margin: 0 auto;
                    line-height: 1.6;
                }
                .refresh-btn {
                    background: #4CAF50;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 1rem;
                    margin-top: 1rem;
                }
                .refresh-btn:hover {
                    background: #45a049;
                }
                .status {
                    font-size: 1.1rem;
                    margin-bottom: 1rem;
                    color: #ffeb3b;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 FoodieBot Setup</h1>
                <div class="status">📱 Ready to Connect</div>
                
                <div class="qr-code">
                    <img src="${botState.qrCode}" alt="WhatsApp QR Code" />
                </div>
                
                <div class="instructions">
                    <h3>📋 How to Connect:</h3>
                    <ol style="text-align: left; display: inline-block;">
                        <li>Open WhatsApp on your phone</li>
                        <li>Go to Settings → Linked Devices</li>
                        <li>Tap "Link a Device"</li>
                        <li>Scan this QR code</li>
                        <li>Wait for connection confirmation</li>
                    </ol>
                </div>
                
                <button class="refresh-btn" onclick="window.location.reload()">🔄 Refresh QR Code</button>
                
                <script>
                    // Auto-refresh every 30 seconds
                    setTimeout(() => window.location.reload(), 30000);
                    
                    // Check connection status periodically
                    setInterval(async () => {
                        try {
                            const response = await fetch('/api/status');
                            const status = await response.json();
                            if (status.isAuthenticated) {
                                window.location.reload();
                            }
                        } catch (error) {
                            console.log('Status check failed:', error);
                        }
                    }, 5000);
                </script>
            </div>
        </body>
        </html>
    `);
});

// Health check endpoint
app.get('/health', (req, res) => {
    const health = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        bot_status: botState.status,
        bot_authenticated: botState.isAuthenticated,
        mongodb_connected: !!db,
        base_url: BASE_URL
    };
    
    res.status(200).json(health);
});

// Webhook endpoint for receiving external notifications
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const signature = req.headers['x-webhook-signature'];
    const payload = req.body;
    
    // Verify webhook signature if secret is provided
    if (process.env.WEBHOOK_SECRET && signature) {
        const crypto = require('crypto');
        const expectedSignature = crypto
            .createHmac('sha256', process.env.WEBHOOK_SECRET)
            .update(payload)
            .digest('hex');
        
        if (signature !== `sha256=${expectedSignature}`) {
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }
    
    try {
        const data = JSON.parse(payload);
        console.log('📡 Webhook received:', data);
        
        // Process webhook data here
        // You can trigger bot actions based on external events
        
        res.status(200).json({ success: true, received: true });
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.status(400).json({ error: 'Invalid JSON payload' });
    }
});

// Enhanced API Routes with better error handling
app.get('/api/status', (req, res) => {
    res.json({
        ...botState,
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        version: '1.0.0',
        base_url: BASE_URL
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>FoodieBot - Admin Panel</title>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 0;
                    padding: 2rem;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    min-height: 100vh;
                }
                .container {
                    max-width: 800px;
                    margin: 0 auto;
                    background: rgba(255, 255, 255, 0.1);
                    padding: 2rem;
                    border-radius: 15px;
                    backdrop-filter: blur(10px);
                    box-shadow: 0 8px 32px rgba(31, 38, 135, 0.37);
                }
                .status {
                    background: ${botState.isAuthenticated ? '#4CAF50' : '#f44336'};
                    color: white;
                    padding: 1rem;
                    border-radius: 8px;
                    margin: 1rem 0;
                    text-align: center;
                }
                .links {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 1rem;
                    margin-top: 2rem;
                }
                .link-card {
                    background: rgba(255, 255, 255, 0.2);
                    padding: 1.5rem;
                    border-radius: 10px;
                    text-decoration: none;
                    color: white;
                    text-align: center;
                    transition: transform 0.3s;
                }
                .link-card:hover {
                    transform: translateY(-5px);
                    background: rgba(255, 255, 255, 0.3);
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 FoodieBot Admin Panel</h1>
                
                <div class="status">
                    Status: ${botState.isAuthenticated ? '✅ Connected & Ready' : '❌ Not Connected'}
                </div>
                
                <div class="links">
                    <a href="/qr" class="link-card">
                        <h3>📱 QR Code</h3>
                        <p>Connect WhatsApp</p>
                    </a>
                    <a href="/health" class="link-card">
                        <h3>💚 Health Check</h3>
                        <p>System Status</p>
                    </a>
                    <a href="/api/status" class="link-card">
                        <h3>📊 API Status</h3>
                        <p>Bot Status JSON</p>
                    </a>
                </div>
                
                <div style="margin-top: 2rem; text-align: center; opacity: 0.8;">
                    <p>🌐 Server: ${BASE_URL}</p>
                    <p>⏰ Uptime: ${Math.floor(process.uptime())} seconds</p>
                    <p>🔄 Last Activity: ${botState.lastActivity.toLocaleString()}</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// [Include all other existing routes from your original code here]
// ... (menu routes, order routes, user routes, etc.)

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File size too large' });
        }
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Initialize the application
async function initializeApp() {
    try {
        console.log('🚀 Starting FoodieBot for Koyeb deployment...');
        
        // Connect to MongoDB first
        await connectToMongoDB();
        
        // Start the Express server
        const PORT = process.env.PORT || 8000;
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(60));
            console.log('🎉 FoodieBot Server Started Successfully!');
            console.log('='.repeat(60));
            console.log(`🌐 Server running on: http://0.0.0.0:${PORT}`);
            console.log(`🌍 Public URL: ${BASE_URL}`);
            console.log(`📋 Admin Panel: ${BASE_URL}`);
            console.log(`🛒 Order Interface: ${BASE_URL}/order`);
            console.log(`📱 QR Code Page: ${BASE_URL}/qr`);
            console.log(`💚 Health Check: ${BASE_URL}/health`);
            console.log('='.repeat(60));
            console.log('\n⏳ Initializing WhatsApp client...');
        });
        
        // Graceful shutdown handler
        process.on('SIGTERM', () => {
            console.log('📱 Received SIGTERM, shutting down gracefully...');
            server.close(async () => {
                try {
                    await client.destroy();
                    console.log('✅ Server closed successfully');
                    process.exit(0);
                } catch (error) {
                    console.error('❌ Error during shutdown:', error);
                    process.exit(1);
                }
            });
        });
        
        // Initialize WhatsApp client
        console.log('🔄 Starting WhatsApp client initialization...');
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        process.exit(1);
    }
}

// Start the application
initializeApp();
