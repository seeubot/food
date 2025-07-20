require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

// --- New Puppeteer Imports ---
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
// --- End New Puppeteer Imports ---


const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI) // Removed useNewUrlParser and useUnifiedTopology
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas and Models
const OrderSchema = new mongoose.Schema({
    items: [{
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
        name: String,
        price: Number,
        quantity: Number,
    }],
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true }, // E.g., 918897350151
    deliveryAddress: { type: String, required: true },
    customerLocation: { // Store customer's last known coordinates
        latitude: Number,
        longitude: Number
    },
    subtotal: { type: Number, required: true },
    transportTax: { type: Number, default: 0 },
    totalAmount: { type : Number, required: true },
    paymentMethod: { type: String, default: 'COD' },
    status: { type: String, default: 'Pending' }, // Pending, Confirmed, Preparing, Out for Delivery, Delivered, Cancelled
    orderDate: { type: Date, default: Date.now },
});

const MenuItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    imageUrl: String,
    category: String,
    isAvailable: { type: Boolean, default: true },
    isTrending: { type: Boolean, default: false },
});

const SettingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'Delicious Bites' },
    shopLocation: { // Shop's coordinates
        latitude: { type: Number, default: 0 },
        longitude: { type: Number, default: 0 }
    },
    deliveryRates: [{ // { kms: Number, amount: Number }
        kms: Number,
        amount: Number
    }],
    adminUsername: { type: String, required: true, unique: true },
    adminPassword: { type: String, required: true },
});

const CustomerSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true },
    customerName: { type: String },
    lastKnownLocation: { // Last known coordinates of the customer
        latitude: Number,
        longitude: Number
    },
    totalOrders: { type: Number, default: 0 },
    lastOrderDate: { type: Date }
});

// New Session Schema
const WhatsappSessionSchema = new mongoose.Schema({
    sessionData: Object, // The session object from whatsapp-web.js
    lastAuthenticatedAt: { type: Date, default: Date.now }, // Timestamp of last successful authentication
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

const Order = mongoose.model('Order', OrderSchema);
const MenuItem = mongoose.model('MenuItem', MenuItemSchema);
const Setting = mongoose.model('Setting', SettingsSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const WhatsappSession = mongoose.model('WhatsappSession', WhatsappSessionSchema);


// Admin User setup
async function setupAdminUser() {
    // --- IMPORTANT: Hardcoded Credentials as requested ---
    // In a production environment, it's highly recommended to use environment variables
    // or a more secure configuration management system for credentials.
    const DEFAULT_ADMIN_USERNAME = "admin";
    const DEFAULT_ADMIN_PASSWORD = "adminpassword"; // Consider using a stronger password in production

    // --- New Default Delivery Rates ---
    const DEFAULT_DELIVERY_RATES = [
        { kms: 1, amount: 50 },    // Up to 1 km: 50 Rs
        { kms: 3, amount: 60 },    // Up to 3 km: 60 Rs
        { kms: 5, amount: 80 },    // Up to 5 km: 80 Rs
        { kms: 10, amount: 100 },  // Up to 10 km: 100 Rs
        { kms: 9999, amount: 150 } // Over 10 km (large number for "infinity"): 150 Rs
    ];

    try {
        let settings = await Setting.findOne();
        if (!settings) {
            console.log('No settings found, creating default admin user and delivery rates...');
            const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
            settings = new Setting({
                shopName: 'Delicious Bites',
                shopLocation: { latitude: 0, longitude: 0 }, // Default shop location
                deliveryRates: DEFAULT_DELIVERY_RATES, // Set new default rates
                adminUsername: DEFAULT_ADMIN_USERNAME,
                adminPassword: hashedPassword,
            });
            await settings.save();
            console.log('Default admin user and delivery rates created with hardcoded credentials.');
        } else {
            // Optional: If you want to update the password or delivery rates if they change
            if (!bcrypt.getRounds(settings.adminPassword) || settings.adminUsername !== DEFAULT_ADMIN_USERNAME) {
                 const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
                 settings.adminPassword = hashedPassword;
                 settings.adminUsername = DEFAULT_ADMIN_USERNAME; // Ensure username matches
                 console.log('Admin credentials updated/re-hashed based on hardcoded values.');
            }
            // Update delivery rates if they are different from default (optional, for existing installations)
            // This ensures that if you modify DEFAULT_DELIVERY_RATES in code, it propagates on restart
            // You might want more sophisticated logic for managing settings in production
            const currentRatesJson = JSON.stringify(settings.deliveryRates.map(r => ({ kms: r.kms, amount: r.amount })));
            const defaultRatesJson = JSON.stringify(DEFAULT_DELIVERY_RATES);
            if (currentRatesJson !== defaultRatesJson) {
                settings.deliveryRates = DEFAULT_DELIVERY_RATES;
                console.log('Default delivery rates updated in settings.');
            }
            await settings.save();
        }
    } catch (err) {
        console.error('Error setting up admin user:', err);
    }
}
setupAdminUser(); // Call on startup

// Express Session Middleware
const store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60, // 14 days
    autoRemove: 'interval',
    autoRemoveInterval: 10, // In minutes. Every 10 minutes, the database is scanned for expired sessions.
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true,
    }
}));

// Authentication Middleware
const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.status(401).send('Unauthorized');
    }
};


app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// WhatsApp Client Initialization
let client;
let botStatus = 'initializing';
let lastAuthenticatedAt = null; // To store the timestamp of last successful authentication

async function initializeBot() {
    console.log('Initializing WhatsApp bot...');
    io.emit('status', 'initializing');
    botStatus = 'initializing';

    let loadedSession;
    try {
        const latestSession = await WhatsappSession.findOne().sort({ updatedAt: -1 });
        if (latestSession && latestSession.sessionData) {
            loadedSession = latestSession.sessionData;
            console.log('Loaded session from database.');
        } else {
            console.log('No saved session found in database. Starting fresh.');
        }
    } catch (dbErr) {
        console.error('Error loading session from DB:', dbErr);
        console.warn('Proceeding without loading a saved session.');
    }

    // Initialize client with loaded session if available
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-client", // LocalAuth persists session to disk, but we also save to DB
            dataPath: './.wwebjs_auth/' // Path to store local session files
        }),
        // --- Use puppeteer-extra here ---
        puppeteer: {
            executablePath: process.env.CHROME_BIN || null, // Use CHROME_BIN if available (for some hosting envs)
            // For Koyeb, often executablePath is not needed if Chromium is pre-installed or handled by buildpack
            // If you still face issues, you might need to specify the path to Chromium
            // on your specific hosting environment, e.g., '/usr/bin/chromium-browser'
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-infobars',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-features=site-per-process',
                '--disable-hang-monitor',
                '--disable-ipc-flooding-protection',
                '--disable-notifications',
                '--disable-offer-store-unmasked-wallet-cards',
                '--disable-popup-blocking',
                '--disable-print-preview',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                // '--disable-web-security', // Keep commented unless absolutely necessary for specific issues
                '--hide-scrollbars',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-default-browser-check',
                '--no-experiments',
                '--no-first-run',
                '--no-pings',
                '--no-sandbox',
                '--no-zygote',
                '--password-store=basic',
                '--use-gl=swiftshader',
                '--window-size=1920,1080'
            ],
            // headless: false, // Uncomment for debugging browser UI, but keep true for production
        },
        session: loadedSession // Pass the loaded session object if available
    });

    client.on('qr', async (qrString) => { // Renamed 'qr' to 'qrString' for clarity
        console.log('QR STRING RECEIVED:', qrString);
        try {
            // Generate data URL from QR string
            const qrDataURL = await qrcode.toDataURL(qrString);
            console.log('QR DATA URL GENERATED.');
            io.emit('qrCode', qrDataURL); // Emit the data URL to the frontend
            io.emit('status', 'qr_received');
            botStatus = 'qr_received';
            lastAuthenticatedAt = null; // Reset on new QR
        } catch (err) {
            console.error('Error generating QR code data URL:', err);
            io.emit('status', 'qr_error');
            botStatus = 'qr_error';
        }
    });

    client.on('authenticated', async (session) => {
        console.log('AUTHENTICATED', session);
        io.emit('status', 'authenticated');
        botStatus = 'authenticated';
        lastAuthenticatedAt = new Date(); // Set timestamp on authentication

        // Save/Update session data in MongoDB
        try {
            await WhatsappSession.findOneAndUpdate(
                {}, // Find any existing session (assuming one bot instance)
                { sessionData: session, lastAuthenticatedAt: lastAuthenticatedAt, updatedAt: new Date() },
                { upsert: true, new: true } // Create if not exists, return new doc
            );
            console.log('Session data saved to MongoDB.');
        } catch (dbErr) {
            console.error('Error saving session to MongoDB:', dbErr);
        }
    });

    client.on('auth_failure', async msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        io.emit('status', 'auth_failure');
        botStatus = 'auth_failure';
        lastAuthenticatedAt = null; // Reset on failure
        // Optionally, delete the stored session if it's permanently invalid
        try {
            await WhatsappSession.deleteMany({}); // Or find and delete specific one
            console.log('Authentication failed, cleared session data from MongoDB.');
        } catch (dbErr) {
            console.error('Error clearing session from MongoDB on auth failure:', dbErr);
        }
    });

    client.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        io.emit('status', 'ready');
        botStatus = 'ready';
        lastAuthenticatedAt = new Date(); // Update timestamp on ready

        // Update lastUsedAt in DB for the active session
        WhatsappSession.findOneAndUpdate(
            { sessionData: { $ne: null } }, // Find an existing session
            { lastAuthenticatedAt: lastAuthenticatedAt, updatedAt: new Date() },
            { new: true }
        ).catch(dbErr => console.error('Error updating session lastUsedAt:', dbErr));

        // Initial fetch of settings to get shopLocation for distance calculation
        Setting.findOne().then(settings => {
            if (settings && settings.shopLocation) {
                shopLocationData = settings.shopLocation;
            }
        }).catch(err => console.error('Error fetching settings on bot ready:', err));
    });

    client.on('disconnected', async (reason) => {
        console.log('WhatsApp Client was disconnected:', reason);
        io.emit('status', 'disconnected');
        botStatus = 'disconnected';
        lastAuthenticatedAt = null; // Reset on disconnect
        // Optionally, handle specific reasons to clear session or attempt reconnect
        // For now, if disconnected, client will try to initialize again on next request or server restart
        // client.destroy(); // Destroy current client instance
        // initializeBot(); // Attempt to re-initialize
    });

    client.on('message', async msg => {
        console.log('MESSAGE RECEIVED', msg.body);

        const senderNumber = msg.from.split('@')[0]; // Extract just the number

        // Base URL for web links
        const baseUrl = process.env.YOUR_KOYEB_URL || 'http://localhost:8080';

        // --- Helper function to send messages with readiness check ---
        const safeSendMessage = async (to, messageContent) => {
            if (client.isReady) { // Check if the client is truly ready
                try {
                    await client.sendMessage(to, messageContent);
                    console.log(`Successfully sent message to ${to}.`);
                } catch (error) {
                    console.error(`Error sending message to ${to}:`, error);
                    // Log the full error for more context
                    if (error.stack) console.error(error.stack);
                }
            } else {
                console.warn(`Attempted to send message to ${to} but client was not ready. Status: ${botStatus}`);
            }
        };

        // Handle specific commands (case-insensitive and number-based)
        const lowerCaseBody = msg.body.toLowerCase().trim();

        switch (lowerCaseBody) {
            case '1':
            case '!profile':
            case 'profile':
                await safeSendMessage(msg.from, `Your registered WhatsApp number is: ${senderNumber}.`);
                break;
            case '2':
            case '!orders':
            case 'orders':
                try {
                    // Fetch only active orders (not Delivered or Cancelled)
                    const customerOrders = await Order.find({
                        customerPhone: senderNumber,
                        status: { $nin: ['Delivered', 'Cancelled'] }
                    }).sort({ orderDate: -1 }).limit(5);

                    if (customerOrders.length > 0) {
                        let orderList = 'Your active orders:\n';
                        customerOrders.forEach((order, index) => {
                            const orderLink = `${baseUrl}/menu?orderId=${order._id}`;
                            orderList += `${index + 1}. Order ID: ${order._id.toString().substring(0, 6)}... - Total: ₹${order.totalAmount.toFixed(2)} - Status: ${order.status} - Track: ${orderLink}\n`;
                        });
                        await safeSendMessage(msg.from, orderList + '\nFor more details or to view past orders, visit our web menu.');
                    } else {
                        await safeSendMessage(msg.from, 'You have no active orders. To place a new order, type "Menu" or click the link: ' + `${baseUrl}/menu`);
                    }
                } catch (error) {
                    console.error('Error fetching orders for bot:', error);
                    await safeSendMessage(msg.from, 'Sorry, I could not fetch your orders at the moment. Please try again later.');
                }
                break;
            case '3':
            case '!help':
            case 'help':
            case '!support':
            case 'support':
                await safeSendMessage(msg.from, 'For any assistance, please contact our support team at +91-XXXX-XXXXXX or visit our website.');
                break;
            case 'menu': // Explicitly handle 'menu' as a direct link request
            case '!menu':
                await safeSendMessage(msg.from, `Check out our delicious menu here: ${baseUrl}/menu`);
                break;
            default:
                // Simplified default welcome message
                const welcomeMessage = `Welcome to Delicious Bites! 😋
                \nHere are your options:
                \n1. My Profile
                \n2. My Active Orders
                \n3. Help & Support
                \n\nTo view our full menu, type "Menu" or click here: ${baseUrl}/menu`;
                await safeSendMessage(msg.from, welcomeMessage);
                break;
        }
    });

    client.initialize()
        .catch(err => console.error('Client initialization failed:', err));
}

// Global variable to store shop location data for distance calculation
let shopLocationData = null;

// Periodically fetch settings to keep shopLocationData updated
setInterval(async () => {
    try {
        const settings = await Setting.findOne();
        if (settings && settings.shopLocation) {
            shopLocationData = settings.shopLocation;
        }
    } catch (err) {
        console.error('Error fetching settings periodically:', err);
    }
}, 60000); // Every 1 minute

// Public Routes (Accessible by customers)
app.get('/menu', (req, res) => {
    // --- IMPORTANT: Ensure public/menu.html exists ---
    // If you see "ENOENT: no such file or directory" errors for menu.html,
    // please verify that the 'public' folder exists in your project root,
    // and 'menu.html' is inside it.
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// New route for order tracking links
app.get('/track', (req, res) => {
    // Redirect to the menu page, passing the orderId as a query parameter
    // The menu.html JavaScript will then read this parameter and open the tracking modal
    const orderId = req.query.orderId;
    if (orderId) {
        res.redirect(`/menu?orderId=${orderId}`);
    } else {
        res.redirect('/menu'); // Redirect to menu if no orderId provided
    }
});

// Serve the bot status page at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bot_status.html'));
});

// API for menu items (public)
app.get('/api/menu', async (req, res) => {
    try {
        const menuItems = await MenuItem.find({ isAvailable: true });
        res.json(menuItems);
    } catch (err) {
        console.error('Error fetching public menu items:', err);
        res.status(500).json({ message: 'Failed to fetch menu items.' });
    }
});

// API for public settings (e.g., shop location, delivery rates)
app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await Setting.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found.' });
        }
        res.json({
            shopName: settings.shopName,
            shopLocation: settings.shopLocation,
            deliveryRates: settings.deliveryRates,
        });
    } catch (err) {
        console.error('Error fetching public settings:', err);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
});

// API for placing an order (public)
app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount, paymentMethod } = req.body;

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        // Validate items and retrieve full product details for storing
        const itemDetails = [];
        for (const item of items) {
            const product = await MenuItem.findById(item.productId);
            if (!product || !product.isAvailable) {
                return res.status(400).json({ message: `Item ${item.name || item.productId} is not available.` });
            }
            itemDetails.push({
                productId: product._id,
                name: product.name,
                price: product.price,
                quantity: item.quantity,
            });
        }

        const newOrder = new Order({
            items: itemDetails,
            customerName,
            customerPhone,
            deliveryAddress,
            customerLocation, // Save customer's location
            subtotal,
            transportTax,
            totalAmount,
            paymentMethod,
            status: 'Pending',
        });

        await newOrder.save();

        // Update/Create Customer record
        await Customer.findOneAndUpdate(
            { customerPhone: customerPhone },
            {
                $set: {
                    customerName: customerName,
                    lastKnownLocation: customerLocation,
                    lastOrderDate: new Date()
                },
                $inc: { totalOrders: 1 }
            },
            { upsert: true, new: true } // Create if not exists, return new doc
        );

        const baseUrl = process.env.YOUR_KOYEB_URL || 'http://localhost:8080';
        const orderTrackingLink = `${baseUrl}/track?orderId=${newOrder._id}`;

        // Notify Admin via WhatsApp (if bot is ready)
        if (botStatus === 'ready' && process.env.ADMIN_NUMBER) {
            const adminNumber = process.env.ADMIN_NUMBER; // Ensure this is a valid WhatsApp number
            let adminOrderSummary = `*New Order Received!* 🎉\n\n` +
                                 `*Order ID:* ${newOrder._id.toString().substring(0, 8)}\n` +
                                 `*Customer:* ${customerName}\n` +
                                 `*Phone:* ${customerPhone}\n` +
                                 `*Address:* ${deliveryAddress}\n`;
            if (customerLocation && customerLocation.latitude && customerLocation.longitude) {
                adminOrderSummary += `*Location:* http://www.google.com/maps/place/${customerLocation.latitude},${customerLocation.longitude}\n`;
            }
            adminOrderSummary += `*Payment:* ${paymentMethod}\n\n*Items:*\n`;
            itemDetails.forEach(item => {
                adminOrderSummary += `- ${item.name} x ${item.quantity} (₹${item.price.toFixed(2)} each)\n`;
            });
            adminOrderSummary += `\n*Subtotal:* ₹${subtotal.toFixed(2)}\n*Transport Tax:* ₹${transportTax.toFixed(2)}\n*Total:* ₹${totalAmount.toFixed(2)}\n\n`;
            adminOrderSummary += `Manage this order: ${baseUrl}/admin/dashboard`;

            // Use safeSendMessage helper
            await safeSendMessage(`${adminNumber}@c.us`, adminOrderSummary);
        } else {
            console.warn('WhatsApp bot not ready or ADMIN_NUMBER not set. Admin not notified via WhatsApp.');
        }

        // Notify Customer via WhatsApp (Order Confirmation)
        if (botStatus === 'ready') {
            const customerConfirmationMessage = `Namaste ${customerName}!\n\nAapka order *${newOrder._id.toString().substring(0, 8)}* successfully place ho gaya hai! 🎉\n\n` +
                                                `*Total Amount:* ₹${totalAmount.toFixed(2)}\n` +
                                                `*Payment Method:* ${paymentMethod}\n\n` +
                                                `Hum aapko jaldi hi update denge. Apne order ka status yahaan track karein: ${orderTrackingLink}\n\n` +
                                                `Dhanyawad, Delicious Bites! 😊`; // Hindi translation
            // Use safeSendMessage helper
            await safeSendMessage(`${customerPhone}@c.us`, customerConfirmationMessage);
        } else {
            console.warn('WhatsApp bot not ready. Customer not notified of order confirmation.');
        }

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder._id, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        res.status(500).json({ message: 'Failed to place order.' });
    }
});

// API to get single order status (public for tracking)
app.get('/api/order/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({
            orderId: order._id,
            status: order.status,
            orderDate: order.orderDate,
            totalAmount: order.totalAmount,
            // Include other details necessary for public tracking if desired
        });
    } catch (err) {
        console.error('Error fetching order status:', err);
        res.status(500).json({ message: 'Failed to fetch order status.' });
    }
});

// Admin Routes
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const settings = await Setting.findOne();
        if (!settings) {
            return res.status(500).json({ message: 'Admin settings not configured.' });
        }

        // --- Use hardcoded admin credentials for validation ---
        const DEFAULT_ADMIN_USERNAME = "admin";
        const DEFAULT_ADMIN_PASSWORD = "adminpassword"; // This will be hashed in DB after first run

        const isPasswordValid = await bcrypt.compare(password, settings.adminPassword);

        if (username === DEFAULT_ADMIN_USERNAME && isPasswordValid) {
            req.session.isAuthenticated = true;
            return res.json({ success: true, message: 'Login successful!' });
        } else {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'An error occurred during login.' });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out.' });
        }
        res.redirect('/admin/login');
    });
});

app.get('/admin/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
});

// Admin API for bot status (emits to Socket.IO, frontend consumes)
app.get('/api/admin/bot-status', isAuthenticated, (req, res) => {
    // This endpoint primarily serves to allow the frontend to trigger a status update fetch,
    // though the real-time updates happen via socket.io.
    io.emit('status', botStatus); // Emit current status to all connected clients
    if (botStatus === 'qr_received' && client && client.qr) {
        // Note: client.qr here is the raw QR string, not the data URL.
        // The client.on('qr') event handles the conversion and emission.
        // This line is mostly for initial connection handshake.
        console.log("Admin bot-status endpoint emitting raw QR string (if available).");
    }
    io.emit('sessionInfo', { lastAuthenticatedAt: lastAuthenticatedAt }); // Emit session timestamp
    res.json({ status: botStatus, lastAuthenticatedAt: lastAuthenticatedAt });
});

// Admin API to request new QR (via backend trigger)
app.post('/api/public/request-qr', async (req, res) => {
    try {
        if (client) {
            await client.destroy(); // Destroy existing session
            console.log('Client destroyed. Requesting new QR.');
        }
        initializeBot(); // Re-initialize to get a new QR
        res.json({ message: 'New QR request initiated. Check status panel for QR.' });
    } catch (error) {
        console.error('Error requesting new QR:', error);
        res.status(500).json({ message: 'Failed to request new QR.' });
    }
});

// Admin API to load saved session
app.post('/api/admin/load-session', isAuthenticated, async (req, res) => {
    try {
        if (client) {
            await client.destroy(); // Destroy current client to allow new session load
        }
        await initializeBot(); // Re-initialize, which will attempt to load from DB
        res.json({ message: 'Attempting to load saved session. Check status panel.' });
    } catch (error) {
        console.error('Error loading saved session:', error);
        res.status(500).json({ message: 'Failed to load saved session.' });
    }
});


// Admin API for Orders
app.get('/api/admin/orders', isAuthenticated, async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ message: 'Failed to fetch orders.' });
    }
});

app.get('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json(order);
    } catch (err) {
        console.error('Error fetching single order:', err);
        res.status(500).json({ message: 'Failed to fetch order.' });
    }
});

app.put('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const { status } = req.body;
        const updatedOrder = await Order.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true }
        );
        if (!updatedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const baseUrl = process.env.YOUR_KOYEB_URL || 'http://localhost:8080';
        const orderTrackingLink = `${baseUrl}/track?orderId=${updatedOrder._id}`;

        // Notify customer (if bot is ready and order status changes significantly)
        if (botStatus === 'ready' && updatedOrder.customerPhone) {
            let customerMessage = `Namaste ${updatedOrder.customerName || 'customer'}!\n\n`;

            switch (updatedOrder.status) {
                case 'Confirmed':
                    customerMessage += `Aapka order *${updatedOrder._id.toString().substring(0, 8)}* confirm ho gaya hai! Humne ise taiyaar karna shuru kar diya hai.`; // Your order is confirmed! We've started preparing it.
                    break;
                case 'Preparing':
                    customerMessage += `Aapka order *${updatedOrder._id.toString().substring(0, 8)}* abhi taiyaar ho raha hai. Jaldi hi aapke paas hoga!`; // Your order is currently being prepared. It will be with you soon!
                    break;
                case 'Out for Delivery':
                    customerMessage += `Khushkhabri! Aapka order *${updatedOrder._id.toString().substring(0, 8)}* delivery ke liye nikal chuka hai! 🛵💨\n\n`; // Good news! Your order is out for delivery!
                    customerMessage += `Apne order ko yahaan track karein: ${orderTrackingLink}`; // Track your order here
                    break;
                case 'Delivered':
                    customerMessage += `Aapka order *${updatedOrder._id.toString().substring(0, 8)}* deliver ho gaya hai! Apne bhojan ka anand lein. 😊`; // Your order has been delivered! Enjoy your meal.
                    break;
                case 'Cancelled':
                    customerMessage += `Maaf kijiye, aapka order *${updatedOrder._id.toString().substring(0, 8)}* cancel kar diya gaya hai. Kripya adhik jaankari ke liye humse sampark karein.`; // Sorry, your order has been cancelled. Please contact us for more details.
                    break;
                default:
                    customerMessage += `Aapke order *${updatedOrder._id.toString().substring(0, 8)}* ka status update ho gaya hai: *${updatedOrder.status}*`; // Your order status has been updated to:
            }

            // Use safeSendMessage helper
            await safeSendMessage(`${updatedOrder.customerPhone}@c.us`, customerMessage);
        }
        res.json(updatedOrder);
    } catch (err) {
        console.error('Error updating order status:', err);
        res.status(500).json({ message: 'Failed to update order status.' });
    }
});

app.delete('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({ message: 'Order deleted successfully.' });
    } catch (err) {
        console.error('Error deleting order:', err);
        res.status(500).json({ message: 'Failed to delete order.' });
    }
});

// Admin API for Menu Items
app.get('/api/admin/menu', isAuthenticated, async (req, res) => {
    try {
        const menuItems = await MenuItem.find();
        res.json(menuItems);
    } catch (err) {
        console.error('Error fetching menu items:', err);
        res.status(500).json({ message: 'Failed to fetch menu items.' });
    }
});

app.get('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const menuItem = await MenuItem.findById(req.params.id);
        if (!menuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json(menuItem);
    } catch (err) {
        console.error('Error fetching single menu item:', err);
        res.status(500).json({ message: 'Failed to fetch menu item.' });
    }
});

app.post('/api/admin/menu', isAuthenticated, async (req, res) => {
    try {
        const newMenuItem = new MenuItem(req.body);
        await newMenuItem.save();
        res.status(201).json(newMenuItem);
    } catch (err) {
        console.error('Error creating menu item:', err);
        res.status(500).json({ message: 'Failed to create menu item.' });
    }
});

app.put('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const updatedMenuItem = await MenuItem.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        if (!updatedMenuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json(updatedMenuItem);
    } catch (err) {
        console.error('Error updating menu item:', err);
        res.status(500).json({ message: 'Failed to update menu item.' });
    }
});

app.delete('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedMenuItem = await MenuItem.findByIdAndDelete(req.params.id);
        if (!deletedMenuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item deleted successfully.' });
    }
    catch (err) {
        console.error('Error deleting menu item:', err);
        res.status(500).json({ message: 'Failed to delete menu item.' });
    }
});

// Admin API for Shop Settings
app.get('/api/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const settings = await Setting.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found.' });
        }
        // Exclude password hash from response
        const { adminPassword, ...safeSettings } = settings.toObject();
        res.json(safeSettings);
    } catch (err) {
        console.error('Error fetching settings:', err);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
});

app.put('/api/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const { shopName, shopLocation, deliveryRates, adminUsername, adminPassword } = req.body;

        let settings = await Setting.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found. Please create defaults first.' });
        }

        settings.shopName = shopName || settings.shopName;
        settings.shopLocation = shopLocation || settings.shopLocation;
        settings.deliveryRates = deliveryRates || settings.deliveryRates;

        // If adminUsername or adminPassword are provided in the request body, update them.
        // For this specific request, we are hardcoding, so this part might be less relevant
        // if the frontend doesn't send these fields.
        if (adminUsername && adminUsername !== settings.adminUsername) {
            settings.adminUsername = adminUsername;
        }
        if (adminPassword) { // Only update password if provided
            settings.adminPassword = await bcrypt.hash(adminPassword, 10);
        }

        await settings.save();
        // Update the global shopLocationData immediately
        shopLocationData = settings.shopLocation;
        const { adminPassword: _, ...safeSettings } = settings.toObject(); // Exclude password hash
        res.json({ message: 'Settings updated successfully!', ...safeSettings });
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ message: 'Failed to update settings.' });
    }
});


// Admin API for Customers (including last known location)
app.get('/api/admin/customers', isAuthenticated, async (req, res) => {
    try {
        const customers = await Customer.find().sort({ lastOrderDate: -1 });
        res.json(customers);
    } catch (err) {
        console.error('Error fetching customers:', err);
        res.status(500).json({ message: 'Failed to fetch customer data.' });
    }
});

app.delete('/api/admin/customers/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);
        if (!deletedCustomer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }
        res.json({ message: 'Customer deleted successfully.' });
    } catch (err) {
        console.error('Error deleting customer:', err);
        res.status(500).json({ message: 'Failed to delete customer.' });
    }
});


// Socket.IO connection
io.on('connection', (socket) => {
    console.log('A user connected via Socket.IO');
    // Send current status to newly connected client
    socket.emit('status', botStatus);
    if (botStatus === 'qr_received' && client && client.qr) {
        // Note: client.qr here is the raw QR string, not the data URL.
        // The client.on('qr') event handles the conversion and emission.
        // This line is mostly for initial connection handshake.
        console.log("Admin bot-status endpoint emitting raw QR string (if available).");
    }
    socket.emit('sessionInfo', { lastAuthenticatedAt: lastAuthenticatedAt });

    socket.on('disconnect', () => {
        console.log('User disconnected from Socket.IO');
    });
});

// Start the bot client on server start
initializeBot();

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access Admin Dashboard: ${process.env.YOUR_KOYEB_URL}/admin/dashboard`);
    console.log(`View Public Menu: ${process.env.YOUR_KOYEB_URL}/menu`);
    console.log(`View Bot Status: ${process.env.YOUR_KOYEB_URL}/`);
});

