// server.js
const express = require('express');
const mongoose = require('mongoose');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // Add this dependency for QR generation
const path = require('path');
const dotenv = require('dotenv');
const cron = require('node-cron');
const bcrypt = require('bcrypt'); // Although not used for ADMIN_CREDENTIALS, keeping it as it was in original
const session = require('express-session');
const rateLimit = require('express-rate-limit');

// Load environment variables from .env file
dotenv.config();

// Hardcoded admin credentials (consider using environment variables for production)
const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: 'admin123'
};

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || 'YOUR_ADMIN_PHONE_NUMBER_HERE'; // Replace with actual admin number
const WEB_MENU_URL = process.env.WEB_MENU_URL || `http://localhost:${PORT}/order`; // Default to local order page
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}/dashboard`; // Default to local dashboard

// QR Code storage and management
let whatsappQRData = null;
let qrCodeGeneratedAt = null;
let qrCodeAccessToken = null;
const QR_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes

// MongoDB Models
// Ensure these paths are correct relative to server.js
const Product = require('./models/Product');
const Order = require('./models/Order');

// Rate limiting for QR endpoints
const qrRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: 'Too many QR requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware for basic authentication
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretkey', // Use a strong, random secret in production
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production (HTTPS)
        httpOnly: true, // Prevent client-side JS from accessing cookie
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Basic Authentication Middleware
const isAuthenticated = (req, res, next) => {
    console.log('Checking authentication for:', req.path);
    console.log('Session isAuthenticated:', req.session.isAuthenticated);
    if (req.session.isAuthenticated) {
        return next();
    }
    console.log('User not authenticated, redirecting to login.');
    res.redirect('/admin/login');
};

// QR Access Token Middleware
const validateQRAccess = (req, res, next) => {
    const { token } = req.query;
    
    if (!token || token !== qrCodeAccessToken) {
        console.warn('Invalid or missing QR access token attempt:', token);
        return res.status(401).json({ 
            success: false, 
            message: 'Invalid or expired QR access token' 
        });
    }
    
    // Check if QR code is still valid
    if (!qrCodeGeneratedAt || Date.now() - qrCodeGeneratedAt > QR_EXPIRY_TIME) {
        console.warn('Expired QR access token attempt.');
        return res.status(410).json({ 
            success: false, 
            message: 'QR code has expired' 
        });
    }
    
    next();
};

// Generate secure access token for QR
const generateQRAccessToken = () => {
    return require('crypto').randomBytes(32).toString('hex');
};

// --- MongoDB Connection ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- WhatsApp Bot Initialization ---
let whatsappClient;
let qrCodeData = 'Loading QR Code...'; // Initial status message

const initializeWhatsAppClient = async () => {
    console.log('Attempting to initialize WhatsApp Client...');
    if (whatsappClient && whatsappClient.isReady) {
        console.log('WhatsApp Client already ready, skipping re-initialization.');
        return;
    }

    // Destroy existing client if it exists but is not ready
    if (whatsappClient) {
        try {
            console.log('Destroying existing WhatsApp client instance...');
            await whatsappClient.destroy();
        } catch (destroyErr) {
            console.error('Error destroying existing client:', destroyErr);
        }
        whatsappClient = null; // Clear the client instance
    }

    whatsappClient = new Client({
        authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }), // Use a specific client ID
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage', // Recommended for Docker/headless environments
                '--disable-extensions',
                '--disable-plugins',
                // '--disable-images', // Keep images enabled if needed for web.whatsapp.com
                // '--disable-javascript', // Do NOT disable JS for web.whatsapp.com
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--disable-web-security', // Can be risky, use with caution
                '--disable-features=site-per-process',
                '--disable-site-isolation-trials',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
                '--no-zygote',
                '--single-process', // Often helps in limited environments
                '--memory-pressure-off',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--metrics-recording-only',
                '--no-crash-upload',
                '--disable-component-update',
                '--disable-software-rasterizer', // May help with GPU issues
                '--disable-client-side-phishing-detection',
                '--disable-cloud-import',
                '--disable-speech-api',
                '--disable-sync-preferences',
                '--disable-zero-copy',
                '--enable-features=NetworkService,NetworkServiceInProcess',
                '--mute-audio'
            ],
            timeout: 120000, // 2 minutes
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, // Use env var for path
            ignoreDefaultArgs: ['--disable-extensions'],
            defaultViewport: null, // Important for responsive pages
            ignoreHTTPSErrors: true
        }
    });

    whatsappClient.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        qrCodeData = qr; // Store raw QR data
        whatsappQRData = qr; // Store for API endpoint
        qrCodeGeneratedAt = Date.now();
        qrCodeAccessToken = generateQRAccessToken();
        console.log('WhatsApp QR RECEIVED:', qr);
        console.log('QR Access Token generated (valid for 5 mins):', qrCodeAccessToken);
    });

    whatsappClient.on('ready', () => {
        console.log('WhatsApp Client is ready and connected!');
        qrCodeData = 'WhatsApp Client is ready!';
        whatsappQRData = null; // Clear QR data when connected
        qrCodeAccessToken = null; // Invalidate token when connected
    });

    whatsappClient.on('message', async msg => {
        console.log(`MESSAGE from ${msg.from}: ${msg.body}`);
        const userMessage = msg.body.toLowerCase();

        if (userMessage === '!ping') {
            msg.reply('pong');
        } else if (userMessage.includes('hi') || userMessage.includes('hello')) {
            msg.reply('👋 Hello there! How can I assist you today? You can view our menu or place an order.');
        } else if (userMessage.includes('menu')) {
            msg.reply(`Here's our delicious menu: ${WEB_MENU_URL} 🍽️`);
        } else if (userMessage.includes('order')) {
            msg.reply(`Ready to order? Visit our web menu here: ${WEB_MENU_URL} 🛒`);
        } else if (userMessage.includes('help')) {
            msg.reply('I can help you with placing an order! Just say "menu" to see what\'s available, or visit our website directly.');
        }
    });

    whatsappClient.on('disconnected', (reason) => {
        console.warn('WhatsApp Client was disconnected:', reason);
        qrCodeData = `Disconnected: ${reason}. Please refresh to get new QR.`;
        whatsappQRData = null;
        qrCodeAccessToken = null;
        console.log('Attempting to restart WhatsApp client in 10 seconds due to disconnection...');
        setTimeout(() => {
            initializeWhatsAppClient(); // Attempt to reinitialize on disconnection
        }, 10000);
    });

    whatsappClient.on('auth_failure', (msg) => {
        console.error('WhatsApp Authentication Failure:', msg);
        qrCodeData = `Authentication failed: ${msg}. Please refresh QR.`;
        whatsappQRData = null;
        qrCodeAccessToken = null;
        console.log('Attempting to restart WhatsApp client in 10 seconds due to auth failure...');
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 10000);
    });

    whatsappClient.on('change_state', state => {
        console.log('WhatsApp Client State Changed:', state);
        // You can update qrCodeData based on state if needed
    });

    whatsappClient.on('loading_screen', (percent, message) => {
        console.log('WhatsApp Loading Screen:', percent, message);
        qrCodeData = `Loading WhatsApp: ${percent}% - ${message}`;
    });

    try {
        console.log('Calling whatsappClient.initialize()...');
        // Add a small delay before initialization to allow resources to settle
        await new Promise(resolve => setTimeout(resolve, 5000)); 
        await whatsappClient.initialize();
        console.log('whatsappClient.initialize() finished.');
    } catch (error) {
        console.error('CRITICAL: Failed to initialize WhatsApp Client:', error.message);
        console.error(error.stack); // Log full stack trace for debugging
        qrCodeData = `Initialization failed: ${error.message}. Check Docker logs for details.`;
        whatsappQRData = null;
        qrCodeAccessToken = null;
        
        console.log('Attempting to restart WhatsApp client in 10 seconds after initialization failure...');
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 10000);
    }
};

// Call the async initialization function
initializeWhatsAppClient();

// --- Routes ---

// Health check endpoint for deployment platforms
app.get('/health', (req, res) => {
    // Return 200 OK if the server is running.
    // For a more robust check, you might verify DB connection or WhatsApp client status.
    res.status(200).send('OK');
});

// Admin Login Page
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Admin Login POST
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        req.session.isAuthenticated = true;
        console.log('Admin login successful. Session set.');
        req.session.save(err => { // Explicitly save session
            if (err) {
                console.error('Error saving session:', err);
                return res.status(500).send('Session error');
            }
            res.redirect('/dashboard');
        });
    } else {
        console.warn('Admin login failed for username:', username);
        res.status(401).send('Invalid credentials');
    }
});

// Admin Logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        } else {
            console.log('Admin session destroyed.');
        }
        res.redirect('/admin/login');
    });
});

// Admin Dashboard (protected)
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// QR Panel Page (protected)
app.get('/qr-panel', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qr-panel.html'));
});

// API to get QR Code status and access token (protected)
app.get('/api/qr-status', isAuthenticated, (req, res) => {
    const now = Date.now();
    const isExpired = qrCodeGeneratedAt && (now - qrCodeGeneratedAt > QR_EXPIRY_TIME);
    
    res.json({
        success: true,
        hasQR: !!whatsappQRData && !isExpired,
        isConnected: whatsappClient && whatsappClient.isReady,
        accessToken: qrCodeAccessToken,
        expiresAt: qrCodeGeneratedAt ? qrCodeGeneratedAt + QR_EXPIRY_TIME : null,
        timeRemaining: qrCodeGeneratedAt && !isExpired ? QR_EXPIRY_TIME - (now - qrCodeGeneratedAt) : 0
    });
});

// Protected QR Code endpoint with rate limiting
app.get('/api/qr-code', qrRateLimit, validateQRAccess, async (req, res) => {
    try {
        if (!whatsappQRData) {
            console.log('QR code not available for /api/qr-code request.');
            return res.status(404).json({ 
                success: false, 
                message: 'QR code not available' 
            });
        }

        const format = req.query.format || 'png';
        const size = parseInt(req.query.size) || 256;

        if (format === 'svg') {
            const qrSvg = await QRCode.toString(whatsappQRData, { 
                type: 'svg',
                width: size,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            });
            res.setHeader('Content-Type', 'image/svg+xml');
            res.send(qrSvg);
        } else {
            const qrBuffer = await QRCode.toBuffer(whatsappQRData, {
                type: 'png',
                width: size,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            });
            res.setHeader('Content-Type', 'image/png');
            res.send(qrBuffer);
        }
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error generating QR code' 
        });
    }
});

// Force QR refresh endpoint (protected)
app.post('/api/qr-refresh', isAuthenticated, async (req, res) => {
    try {
        console.log('QR refresh requested.');
        if (whatsappClient) {
            console.log('Destroying WhatsApp client for refresh...');
            await whatsappClient.destroy();
        }
        
        // Reset QR data
        whatsappQRData = null;
        qrCodeGeneratedAt = null;
        qrCodeAccessToken = null;
        qrCodeData = 'Refreshing QR Code...';
        
        // Reinitialize client after a short delay
        setTimeout(() => {
            console.log('Reinitializing WhatsApp client after refresh request...');
            initializeWhatsAppClient();
        }, 2000); // Give some time for resources to clear

        res.json({ 
            success: true, 
            message: 'QR refresh initiated' 
        });
    } catch (error) {
        console.error('Error refreshing QR:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error refreshing QR code' 
        });
    }
});

// Original dashboard QR endpoint (for backward compatibility)
app.get('/api/whatsapp-qr', isAuthenticated, (req, res) => {
    res.json({ qrCode: qrCodeData });
});

// API to get orders for dashboard
app.get('/api/orders', isAuthenticated, async (req, res) => {
    try {
        const orders = await Order.find().populate('items.product').sort({ createdAt: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

// API to update order status
app.post('/api/orders/:id/status', isAuthenticated, async (req, res) => {
    try {
        const { status } = req.body;
        const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (order) {
            if (whatsappClient && whatsappClient.isReady) {
                const userNumber = order.userWhatsAppNumber;
                // Ensure the number is in the correct format (e.g., 91XXXXXXXXXX@c.us)
                const formattedUserNumber = userNumber ? `${userNumber.replace(/\D/g, '')}@c.us` : null;
                if (formattedUserNumber) {
                    whatsappClient.sendMessage(formattedUserNumber, `Your order #${order._id} status has been updated to: *${status}*`);
                    console.log(`Sent order status update to ${formattedUserNumber} for order #${order._id}`);
                } else {
                    console.warn(`Could not send WhatsApp message for order #${order._id}: Invalid user number ${userNumber}`);
                }
            } else {
                console.warn('WhatsApp client not ready to send order status update.');
            }
            res.json(order);
        } else {
            res.status(404).json({ message: 'Order not found' });
        }
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ message: 'Error updating order status' });
    }
});

// API to get menu items for dashboard (and for public order page)
app.get('/api/menu', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (error) {
        console.error('Error fetching menu:', error);
        res.status(500).json({ message: 'Error fetching menu' });
    }
});

// API to add/update menu item (admin only)
app.post('/api/menu', isAuthenticated, async (req, res) => {
    try {
        const { name, description, price, imageUrl } = req.body;
        const product = new Product({ name, description, price, imageUrl });
        await product.save();
        res.status(201).json(product);
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ message: 'Error adding product' });
    }
});

// API to delete menu item (admin only)
app.delete('/api/menu/:id', isAuthenticated, async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ message: 'Error deleting product' });
    }
});

// Public Order Page
app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// API to place a new order
app.post('/api/order', async (req, res) => {
    try {
        const { items, userWhatsAppNumber, userName, userAddress, paymentMethod } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'Order must contain items.' });
        }

        let totalAmount = 0;
        const orderItems = [];
        for (const item of items) {
            const product = await Product.findById(item.productId);
            if (!product) {
                return res.status(400).json({ message: `Product with ID ${item.productId} not found.` });
            }
            orderItems.push({
                product: product._id,
                quantity: item.quantity,
                price: product.price
            });
            totalAmount += product.price * item.quantity;
        }

        const newOrder = new Order({
            items: orderItems,
            userWhatsAppNumber,
            userName,
            userAddress,
            totalAmount,
            paymentMethod,
            status: 'Pending'
        });

        await newOrder.save();
        await newOrder.populate('items.product');

        if (whatsappClient && whatsappClient.isReady && ADMIN_PHONE_NUMBER) {
            const formattedAdminNumber = ADMIN_PHONE_NUMBER.replace(/\D/g, '') + '@c.us'; // Format admin number
            let orderSummary = `*New Order Received!* 🛍️\nOrder ID: #${newOrder._id}\nCustomer: ${userName || 'N/A'}\nWhatsApp: ${userWhatsAppNumber || 'N/A'}\nAddress: ${userAddress || 'N/A'}\nTotal: ₹${totalAmount.toFixed(2)}\nPayment: ${paymentMethod}\n\nItems:\n`;
            newOrder.items.forEach(item => {
                orderSummary += `- ${item.quantity} x ${item.product ? item.product.name : 'Unknown Product'} (₹${item.price.toFixed(2)} each)\n`;
            });
            orderSummary += `\nView dashboard for details: ${DASHBOARD_URL}`;
            whatsappClient.sendMessage(formattedAdminNumber, orderSummary);
            console.log(`Sent new order notification to admin: ${formattedAdminNumber}`);
        } else {
            console.warn('WhatsApp client not ready or ADMIN_PHONE_NUMBER not set for new order notification.');
        }

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });

    } catch (error) {
        console.error('Error placing order:', error);
        res.status(500).json({ message: 'Error placing order' });
    }
});

// --- Scheduled Task ---
cron.schedule('0 2 * * *', async () => { // Runs daily at 2 AM
    console.log('Running daily cron job to notify users about old orders...');
    try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const ordersToNotify = await Order.find({
            status: 'Completed', // Only notify for completed orders
            createdAt: { $lte: sevenDaysAgo }
        });

        if (whatsappClient && whatsappClient.isReady) {
            for (const order of ordersToNotify) {
                const userNumber = order.userWhatsAppNumber;
                const formattedUserNumber = userNumber ? `${userNumber.replace(/\D/g, '')}@c.us` : null;
                if (formattedUserNumber) {
                    const message = `👋 Hi there! It's been a while since your last order #${order._id} on ${order.createdAt.toDateString()}. We hope you enjoyed your items! Check out our latest menu: ${WEB_MENU_URL}`;
                    whatsappClient.sendMessage(formattedUserNumber, message);
                    console.log(`Notified user ${formattedUserNumber} about old order #${order._id}`);
                }
            }
        } else {
            console.log('WhatsApp client not ready for cron job notifications.');
        }
    } catch (error) {
        console.error('Error in cron job:', error);
    }
});

// Redirect root to order page
app.get('/', (req, res) => {
    res.redirect('/order');
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Order page: http://localhost:${PORT}/order`);
    console.log(`Admin dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`QR Panel: http://localhost:${PORT}/qr-panel`);
    console.log(`Admin credentials: Username: ${ADMIN_CREDENTIALS.username}, Password: ${ADMIN_CREDENTIALS.password}`);
    console.log(`Ensure WEB_MENU_URL and DASHBOARD_URL environment variables are set for production deployment.`);
});

