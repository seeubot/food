// index.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const MongoStore = require('connect-mongo');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '918897350151'; // Admin WhatsApp number for notifications (without +)
const SESSION_SECRET = process.env.SESSION_SECRET || 'supersecretkeyforfoodbot'; // CHANGE THIS IN PRODUCTION!
const SESSION_DIR_PATH = './.wwebjs_auth'; // Directory for whatsapp-web.js session files

// Admin Credentials from Environment Variables or Default
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adminpassword';

// New: Reconnection and QR expiry settings
const RECONNECT_DELAY_MS = 5000; // 5 seconds delay before trying to re-initialize
const QR_EXPIRY_MS = 60000; // QR code considered expired after 60 seconds if not scanned
const WEEKLY_NOTIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // Check for notifications every 24 hours

// --- Express App Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGODB_URI,
        collectionName: 'sessions',
        ttl: 14 * 24 * 60 * 60
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7,
        secure: process.env.NODE_ENV === 'production'
    }
}));

// Serve static files (e.g., CSS, images for frontend if you have them)
app.use(express.static(path.join(__dirname, 'public')));

// --- MongoDB Connection ---
mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('MongoDB connected successfully');
        // Initialize admin and settings ONLY after DB connection is established
        initializeAdminAndSettings();
    })
    .catch(err => console.error('MongoDB connection error:', err));

// --- Mongoose Schemas ---

// User Schema (for admin and potentially future customer profiles)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isAdmin: { type: Boolean, default: false }
});

userSchema.pre('save', async function(next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
        console.log(`Password for user ${this.username} hashed.`);
    }
    next();
});

userSchema.methods.comparePassword = function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

// Product (Menu Item) Schema
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    price: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, default: 'https://placehold.co/300x200/cccccc/333333?text=Food+Item' },
    category: { type: String, default: 'Main Course' },
    isAvailable: { type: Boolean, default: true },
    isTrending: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.model('Product', productSchema);

// Order Schema
const orderSchema = new mongoose.Schema({
    items: [{
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        name: String,
        price: Number,
        quantity: { type: Number, required: true, min: 1 }
    }],
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    deliveryAddress: { type: String, required: true },
    customerLocation: {
        latitude: { type: Number },
        longitude: { type: Number }
    },
    // NEW: Store shop location at time of order for tracking
    deliveryFromLocation: {
        latitude: { type: Number },
        longitude: { type: Number }
    },
    subtotal: { type: Number, required: true },
    transportTax: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    status: { type: String, enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'], default: 'Pending' },
    orderDate: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// Admin Settings Schema (for shop location and delivery rates)
const adminSettingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'My Food Business' },
    shopLocation: {
        latitude: { type: Number, default: 0 },
        longitude: { type: Number, default: 0 }
    },
    deliveryRates: [{
        kms: { type: Number, required: true, min: 0 },
        amount: { type: Number, required: true, min: 0 }
    }]
});
const AdminSettings = mongoose.model('AdminSettings', adminSettingsSchema);

// NEW: Customer Notification Schema for weekly reminders
const customerNotificationSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true },
    lastNotifiedDate: { type: Date, default: Date.now }
});
const CustomerNotification = mongoose.model('CustomerNotification', customerNotificationSchema);


// --- Initial Data Setup ---
async function initializeAdminAndSettings() {
    try {
        // Ensure the admin user exists and has isAdmin: true
        const adminUser = await User.findOneAndUpdate(
            { username: DEFAULT_ADMIN_USERNAME },
            {
                $setOnInsert: { password: await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10) }, // Only hash and set password on insert
                $set: { isAdmin: true } // Always ensure isAdmin is true
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        console.log(`Admin user '${DEFAULT_ADMIN_USERNAME}' ensured. Details:`, adminUser);

        let settings = await AdminSettings.findOne();
        if (!settings) {
            settings = new AdminSettings({
                shopName: 'Delicious Bites',
                shopLocation: { latitude: 17.4375, longitude: 78.4482 }, // Example: Hyderabad coordinates
                deliveryRates: [
                    { kms: 5, amount: 30 },
                    { kms: 10, amount: 60 },
                    { kms: 20, amount: 100 }
                ]
            });
            await settings.save();
            console.log('Default admin settings created.');
        }

        // Start the Express server ONLY after admin and settings are initialized
        server.listen(PORT, () => {
            console.log(`Server listening on port ${PORT}`);
            console.log('Initializing WhatsApp client...');
            console.log('Visit the root URL of your deployment to check status and scan the QR.');
            console.log(`Admin login: ${process.env.YOUR_KOYEB_URL || 'http://localhost:8080'}/admin/login`);
            console.log(`Public menu: ${process.env.YOUR_KOYEB_URL || 'http://localhost:8080'}/menu`);
        });

        // Initial client initialization on server startup
        client.initialize();

    } catch (error) {
        console.error('Error initializing admin and settings:', error);
        // Exit process if initial setup fails critically
        process.exit(1);
    }
}

// --- WhatsApp Bot Setup ---
let qrCodeDataURL = null;
let clientReady = false;
let qrExpiryTimer = null; // To track QR code validity
let botCurrentStatus = 'initializing'; // Initial status: bot is initializing

// Update bot status and emit via Socket.IO
function updateBotStatus(status, qrData = null) {
    botCurrentStatus = status;
    io.emit('status', status);
    if (qrData) {
        qrCodeDataURL = qrData;
        io.emit('qrCode', qrData); // Emit QR code data for the public panel
    } else if (status === 'ready' || status === 'authenticated' || status === 'initializing' || status === 'reconnecting') {
        // Do not clear QR if bot is ready, authenticated, initializing, or reconnecting
        // This allows the QR to persist if it's still valid or if a new one is coming
    } else {
        // Clear QR for other statuses (disconnected, auth_failure, qr_error, qr_expired)
        qrCodeDataURL = null;
        io.emit('qrCode', null); // Clear QR code data for the public panel
    }
}


// Ensure session directory exists
(async () => {
    try {
        await fs.mkdir(SESSION_DIR_PATH, { recursive: true });
        console.log('Session directory ensured:', SESSION_DIR_PATH);
    } catch (err) {
        console.error('Error ensuring session directory:', err);
    }
})();

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: SESSION_DIR_PATH
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-video-decode',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--single-process'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

    qrcode.toDataURL(qr, { small: false }, (err, url) => {
        if (err) {
            console.error('Error generating QR code data URL:', err);
            updateBotStatus('qr_error');
        } else {
            updateBotStatus('qr_received', url);

            qrExpiryTimer = setTimeout(() => {
                updateBotStatus('qr_expired');
                console.log('QR code expired. Please request a new QR.');
            }, QR_EXPIRY_MS);
        }
    });
});

client.on('ready', () => {
    console.log('Client is ready!');
    clientReady = true;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    console.log('WhatsApp bot is connected and operational.');
    updateBotStatus('ready');
    // Start weekly notification scheduler only when client is ready
    // Check if the interval is already set to prevent multiple intervals
    if (!global.weeklyNotificationInterval) {
        global.weeklyNotificationInterval = setInterval(sendWeeklyNotifications, WEEKLY_NOTIFICATION_INTERVAL_MS);
        console.log('Weekly notification scheduler started.');
    }
});

client.on('authenticated', (session) => {
    console.log('AUTHENTICATED', session);
    updateBotStatus('authenticated');
});

client.on('auth_failure', async msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    console.log('Authentication failed. Clearing session files and re-initializing...');
    clientReady = false;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    updateBotStatus('auth_failure'); // Indicate auth failure

    try {
        await fs.rm(SESSION_DIR_PATH, { recursive: true, force: true });
        console.log('Deleted old session directory. Re-initializing client...');
    } catch (err) {
        console.error('Error deleting old session directory:', err);
    } finally {
        // Re-initialize automatically after a short delay
        setTimeout(() => {
            client.initialize();
            updateBotStatus('reconnecting');
        }, RECONNECT_DELAY_MS);
    }
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected', reason);
    clientReady = false;
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    updateBotStatus('disconnected'); // Indicate disconnected
    console.log('WhatsApp client disconnected. Re-initializing...');
    // Clear any existing weekly notification interval
    if (global.weeklyNotificationInterval) {
        clearInterval(global.weeklyNotificationInterval);
        global.weeklyNotificationInterval = null;
        console.log('Weekly notification scheduler stopped due to disconnection.');
    }
    // Re-initialize automatically after a short delay
    setTimeout(() => {
        client.initialize();
        updateBotStatus('reconnecting');
    }, RECONNECT_DELAY_MS);
});

// Initial Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('A user connected to Socket.IO');
    // Emit current status and QR code to newly connected clients
    socket.emit('status', botCurrentStatus); // Emit current status
    if (qrCodeDataURL) {
        socket.emit('qrCode', qrCodeDataURL); // Emit QR code data if available
    }
});

// Helper function to upsert customer notification entry
async function updateCustomerNotification(customerPhone) {
    try {
        await CustomerNotification.findOneAndUpdate(
            { customerPhone: customerPhone },
            { $set: { lastNotifiedDate: new Date() } },
            { upsert: true, new: true }
        );
        console.log(`Updated last notified date for ${customerPhone}`);
    } catch (error) {
        console.error(`Error updating customer notification for ${customerPhone}:`, error);
    }
}

client.on('message', async msg => {
    console.log('MESSAGE RECEIVED from:', msg.from, 'Body:', msg.body); // Log message reception

    // Ensure the bot is ready before processing messages
    if (!clientReady) {
        console.log(`Bot not ready, ignoring message from ${msg.from}.`);
        return;
    }

    const senderNumber = msg.from.split('@')[0];
    // Direct menu URL as requested
    const menuUrl = "https://jolly-phebe-seeutech-5259d95c.koyeb.app/menu_panel";

    try {
        // Update customer notification date on any message received
        await updateCustomerNotification(senderNumber);

        // Welcome message content with numbered options and Indian dialogues
        const welcomeMessage = `Namaste! Craving something delicious? 😋 Welcome to Delicious Bites, where every bite is a delight!
                \nKya chahiye aapko? (What do you need?) Just reply with the number:
                \n1. My Profile (Dekho apni jaankari!)
                \n2. My Recent Orders (Pichle orders dekho!)
                \n3. Support (Madad chahiye? Hum hain na!)
                \n\nTo view our full menu, simply type 'Menu' or click here: ${menuUrl}`;

        // Handle specific commands (case-insensitive and number-based)
        const lowerCaseBody = msg.body.toLowerCase().trim();

        switch (lowerCaseBody) {
            case '1':
            case '!profile':
            case 'profile':
                await msg.reply(`Aapka profile yahaan hai! (Your profile is here!) Your registered WhatsApp number is: ${senderNumber}. We're working on adding more personalized profile features soon. Stay tuned!`);
                console.log(`Replied to ${senderNumber} with profile info.`);
                break;
            case '2':
            case '!orders':
            case 'orders':
                try {
                    const customerOrders = await Order.find({ customerPhone: senderNumber }).sort({ orderDate: -1 }).limit(5);
                    if (customerOrders.length > 0) {
                        let orderList = 'Your recent orders:\n';
                        customerOrders.forEach((order, index) => {
                            orderList += `${index + 1}. Order ID: ${order._id.toString().substring(0, 6)}... - Total: ₹${order.totalAmount.toFixed(2)} - Status: ${order.status}\n`;
                        });
                        await msg.reply(orderList + '\nFor more details, visit the web menu or contact support.');
                        console.log(`Replied to ${senderNumber} with recent orders.`);
                    } else {
                        await msg.reply('You have no recent orders. Why not place one now? Reply with *1* for menu.');
                        console.log(`Replied to ${senderNumber} with no recent orders message.`);
                    }
                } catch (error) {
                    console.error('Error fetching orders for bot:', error);
                    await msg.reply('Sorry, I could not fetch your orders at the moment. Please try again later.');
                }
                break;
            case '3':
            case '!help':
            case 'help':
            case '!support':
            case 'support':
                await msg.reply('For any assistance, please contact our support team at +91-XXXX-XXXXXX or visit our website.');
                console.log(`Replied to ${senderNumber} with help message.`);
                break;
            case 'menu': // Explicitly handle 'menu' as a direct link request
                await msg.reply(`Check out our delicious menu here: ${menuUrl}`);
                console.log(`Replied to ${senderNumber} with direct menu link.`);
                break;
            default:
                // Default response: send the welcome message for any other input
                await msg.reply(welcomeMessage);
                console.log(`Replied to ${senderNumber} with welcome message (default).`);
                break;
        }
    } catch (error) {
        console.error(`Error processing message from ${msg.from}:`, error);
        // Attempt to send a generic error message back to the user
        try {
            await msg.reply('Sorry, something went wrong while processing your request. Please try again or contact support.');
        } catch (replyError) {
            console.error(`Failed to send error reply to ${msg.from}:`, replyError);
        }
    }
});

// NEW: Function to send weekly notifications to users
async function sendWeeklyNotifications() {
    if (!clientReady) {
        console.log('WhatsApp client not ready for sending weekly notifications. Skipping.');
        return;
    }

    console.log('Checking for weekly notifications to send...');
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        // Find customers whose last notified date is older than 7 days
        const customersToNotify = await CustomerNotification.find({
            lastNotifiedDate: { $lte: sevenDaysAgo }
        });

        const products = await Product.find({ isAvailable: true });
        if (products.length === 0) {
            console.log('No products available to suggest in weekly notification. Skipping.');
            return;
        }

        // Direct menu URL for notifications
        const menuUrl = "https://jolly-phebe-seeutech-5259d95c.koyeb.app/menu_panel";

        for (const customer of customersToNotify) {
            // Pick a random product to suggest
            const randomProduct = products[Math.floor(Math.random() * products.length)];

            const message = `👋 Hey there! It's been a while since your last order. How about trying our delicious *${randomProduct.name}* today? It's only ₹${randomProduct.price.toFixed(2)}!\n\nCheck out our full menu here: ${menuUrl}\n\nWe hope to serve you soon! 😊`;

            try {
                // Send message to customer
                await client.sendMessage(customer.customerPhone + '@c.us', message);
                // Update last notified date for this customer
                await CustomerNotification.findByIdAndUpdate(customer._id, { lastNotifiedDate: new Date() });
                console.log(`Sent weekly notification to ${customer.customerPhone}`);
            } catch (msgError) {
                console.error(`Error sending weekly notification to ${customer.customerPhone}:`, msgError);
            }
        }
    } catch (error) {
        console.error('Error in sendWeeklyNotifications:', error);
    }
}


// --- Helper for Haversine Distance Calculation ---
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

// --- Express Routes ---

// Admin Authentication Middleware
function isAuthenticated(req, res, next) {
    console.log('isAuthenticated check:', {
        sessionId: req.session.id,
        userId: req.session.userId,
        isAdmin: req.session.isAdmin,
        path: req.path
    });

    if (req.session.userId && req.session.isAdmin) {
        return next();
    }

    // For API requests, send a 401 JSON response
    if (req.path.startsWith('/api/admin/')) {
        console.warn(`Unauthorized API access attempt to ${req.path}. Session invalid.`);
        return res.status(401).json({ message: 'Unauthorized: Session expired or not logged in.' });
    }

    // For regular page requests, redirect to login
    console.log('Redirecting to admin login due to unauthorized access.');
    res.redirect('/admin/login');
}

// Root route for bot status and QR display (Public Panel) - now serves bot_status.html
app.get('/', async (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'bot_status.html'));
    } catch (error) {
        console.error('Error serving bot_status.html:', error);
        res.status(500).send('<h1>Error loading bot status page.</h1><p>Please check server logs.</p>');
    }
});

// Admin Login Page
app.get('/admin/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Login</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Inter', sans-serif; }
                /* Apply black and white theme overrides */
                body {
                    background-color: #000000 !important; /* Pure black background */
                    color: #ffffff !important; /* Pure white text */
                }
                .bg-gray-100 {
                    background-color: #000000 !important;
                }
                .bg-white, .bg-gray-800 {
                    background-color: #1a1a1a !important; /* Very dark gray */
                }
                .text-gray-800 {
                    color: #ffffff !important;
                }
                .text-gray-700, .text-gray-300 {
                    color: #dddddd !important;
                }
                input {
                    background-color: #222222 !important;
                    border-color: #444444 !important;
                    color: #ffffff !important;
                }
                input::placeholder {
                    color: #888888 !important;
                }
                button {
                    background-color: #ffffff !important; /* White background */
                    color: #000000 !important; /* Black text */
                    box-shadow: 0 4px 6px -1px rgba(255, 255, 255, 0.2), 0 2px 4px -1px rgba(255, 255, 255, 0.1) !important;
                }
                button:hover {
                    background-color: #e0e0e0 !important;
                }
                .text-red-500 {
                    color: #ff6666 !important; /* Slightly brighter red for error messages */
                }
            </style>
        </head>
        <body class="bg-gray-100 flex items-center justify-center min-h-screen">
            <div class="bg-white p-8 rounded-lg shadow-xl max-w-md w-full">
                <h2 class="text-3xl font-bold text-gray-800 mb-6 text-center">Admin Login</h2>
                <form action="/admin/login" method="POST" class="space-y-4">
                    <div>
                        <label for="username" class="block text-gray-700 text-sm font-bold mb-2">Username:</label>
                        <input type="text" id="username" name="username" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline" required>
                    </div>
                    <div>
                        <label for="password" class="block text-gray-700 text-sm font-bold mb-2">Password:</label>
                        <input type="password" id="password" name="password" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 mb-3 leading-tight focus:outline-none focus:shadow-outline" required>
                    </div>
                    <button type="submit" class="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline w-full transition duration-300 ease-in-out">Login</button>
                </form>
                ${req.session.message ? `<p class="text-red-500 text-center mt-4">${req.session.message}</p>` : ''}
            </div>
        </body>
        </html>
    `);
    delete req.session.message;
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (user) {
            console.log(`Login attempt for user: ${username}, isAdmin: ${user.isAdmin}`);
            if (await user.comparePassword(password)) {
                req.session.userId = user._id;
                req.session.isAdmin = user.isAdmin;
                console.log(`Session established for ${username}: userId=${req.session.userId}, isAdmin=${req.session.isAdmin}`);

                if (user.isAdmin) {
                    return res.redirect('/admin/dashboard');
                } else {
                    req.session.message = 'You are not authorized to access the admin panel.';
                    console.log(`User ${username} is not an admin. Redirecting to login.`);
                    return res.redirect('/admin/login');
                }
            } else {
                req.session.message = 'Invalid username or password.';
                console.log(`Invalid password for user: ${username}`);
                return res.redirect('/admin/login');
            }
        } else {
            req.session.message = 'Invalid username or password.';
            console.log(`User not found: ${username}`);
            return res.redirect('/admin/login');
        }
    } catch (error) {
        console.error('Login error:', error);
        req.session.message = 'An error occurred during login.';
        res.redirect('/admin/login');
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) console.error('Error destroying session:', err);
        console.log('Session destroyed. Redirecting to login.');
        res.redirect('/admin/login');
    });
});

// Admin Dashboard (Protected) - now serves admin_dashboard.html
app.get('/admin/dashboard', isAuthenticated, async (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
    } catch (error) {
        console.error('Error serving admin_dashboard.html:', error);
        res.status(500).send('<h1>Error loading Admin Dashboard.</h1><p>Please check server logs.</p>');
    }
});

// API: Get bot status for admin dashboard (NO QR data here)
app.get('/api/admin/bot-status', isAuthenticated, (req, res) => {
    console.log('API: /api/admin/bot-status hit.');
    res.json({
        status: botCurrentStatus,
        // Removed qrCodeDataURL from here, it's only for the public panel
    });
});

// NEW PUBLIC API: Request a new QR code for WhatsApp bot (accessible from public panel)
app.post('/api/public/request-qr', async (req, res) => {
    console.log('API: /api/public/request-qr hit.');
    if (clientReady) {
        return res.status(400).json({ message: 'Bot is already connected. Disconnect it first if you need a new QR for re-authentication.' });
    }
    console.log('Public QR request received. Clearing session files and re-initializing client...');
    // Clear any existing QR expiry timer if a new request comes in
    if (qrExpiryTimer) {
        clearTimeout(qrExpiryTimer);
        qrExpiryTimer = null;
    }
    // Clear any existing weekly notification interval
    if (global.weeklyNotificationInterval) {
        clearInterval(global.weeklyNotificationInterval);
        global.weeklyNotificationInterval = null;
        console.log('Weekly notification scheduler stopped due to new QR request.');
    }
    try {
        // Force delete session files for a fresh QR
        await fs.rm(SESSION_DIR_PATH, { recursive: true, force: true });
        console.log('Deleted old session directory for new QR request.');
    } catch (err) {
        console.error('Error deleting old session directory during manual QR request:', err);
        // Continue even if deletion fails, client.initialize might still work
    } finally {
        // Set status to initializing and clear current QR data immediately
        updateBotStatus('initializing'); // This will clear qrCodeDataURL and emit
        // Initialize the client; this will trigger 'qr' or 'ready' event
        client.initialize();
        res.json({ message: 'Attempting to generate new QR code. Check the public bot status page for updates.' });
    }
});


// --- API for Admin Dashboard Orders ---
app.get('/api/admin/orders', isAuthenticated, async (req, res) => {
    console.log('API: /api/admin/orders hit.');
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        console.log(`Fetched ${orders.length} admin orders.`);
        res.json(orders);
    }
    catch (error) {
        console.error('Error fetching admin orders:', error.message);
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

app.get('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    console.log(`API: /api/admin/orders/${req.params.id} hit.`);
    try {
        // Ensure that subtotal, transportTax, and totalAmount are always numbers.
        // This is a safety measure for potentially inconsistent old data,
        // as the schema already marks them as required numbers for new data.
        const order = await Order.findById(req.params.id).lean(); // Use .lean() for plain JS objects for modification
        if (!order) {
            console.log(`Order ${req.params.id} not found.`);
            return res.status(404).json({ message: 'Order not found' });
        }

        // Ensure numeric fields are actually numbers, default to 0 if null/undefined
        order.subtotal = typeof order.subtotal === 'number' ? order.subtotal : 0;
        order.transportTax = typeof order.transportTax === 'number' ? order.transportTax : 0;
        order.totalAmount = typeof order.totalAmount === 'number' ? order.totalAmount : 0;

        console.log(`Fetched order ${req.params.id} details.`);
        res.json(order);
    } catch (error) {
        console.error('Error fetching single order:', error.message);
        res.status(500).json({ message: 'Error fetching order' });
    }
});


app.put('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    console.log(`API: /api/admin/orders/${req.params.id} PUT hit.`);
    try {
        const { id } = req.params;
        const { status } = req.body;
        console.log(`Updating order ${id} to status: ${status}`); // Log update attempt
        const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
        if (!order) {
            console.warn(`Order ${id} not found for status update.`);
            return res.status(404).json({ message: 'Order not found' });
        }
        console.log(`Order ${id} updated successfully to status: ${order.status}`);
        // Optional: Notify customer via WhatsApp about status update
        // client.sendMessage(order.customerPhone + '@c.us', `Your order #${order._id.toString().substring(0,6)} has been updated to: ${order.status}`);
        res.json(order);
    } catch (error) {
        console.error('Error updating order status:', error.message); // Log specific error
        res.status(500).json({ message: 'Error updating order status' });
    }
});

// --- API for Admin Menu Management (CRUD) ---
app.get('/api/admin/menu', isAuthenticated, async (req, res) => {
    console.log('API: /api/admin/menu hit.');
    try {
        const products = await Product.find().sort({ name: 1 });
        console.log(`Fetched ${products.length} admin menu items.`);
        res.json(products);
    } catch (error) {
        console.error('Error fetching admin menu:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching menu items' });
    }
});

app.get('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    console.log(`API: /api/admin/menu/${req.params.id} hit.`);
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            console.log(`Product ${req.params.id} not found.`);
            return res.status(404).json({ message: 'Product not found' });
        }
        console.log(`Fetched product ${product.name} for edit.`);
        res.json(product);
    }
    catch (error) {
        console.error('Error fetching single product:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching product' });
    }
});

app.post('/api/admin/menu', isAuthenticated, async (req, res) => {
    console.log('API: /api/admin/menu POST hit.');
    try {
        console.log('Attempting to add new menu item. Received body:', req.body); // Log received body
        const newProduct = new Product(req.body);
        await newProduct.save();
        console.log('New menu item added successfully:', newProduct.name);
        res.status(201).json(newProduct);
    } catch (error) {
        console.error('Error adding menu item:', error.message); // Log specific error
        res.status(500).json({ message: 'Error adding menu item', details: error.message }); // Send details to frontend for debugging
    }
});

app.put('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    console.log(`API: /api/admin/menu/${req.params.id} PUT hit.`);
    try {
        console.log(`Attempting to update menu item ${req.params.id}. Received body:`, req.body); // Log received body
        const updatedProduct = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }); // runValidators ensures schema validation on update
        if (!updatedProduct) {
            console.warn(`Menu item ${req.params.id} not found for update.`);
            return res.status(404).json({ message: 'Product not found' });
        }
        console.log('Menu item updated successfully:', updatedProduct.name);
        res.json(updatedProduct);
    } catch (error) {
        console.error('Error updating menu item:', error.message); // Log specific error
        res.status(500).json({ message: 'Error updating menu item', details: error.message }); // Send details to frontend for debugging
    }
});

app.delete('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    console.log(`API: /api/admin/menu/${req.params.id} DELETE hit.`);
    try {
        console.log(`Attempting to delete menu item ${req.params.id}.`);
        const deletedProduct = await Product.findByIdAndDelete(req.params.id);
        if (!deletedProduct) {
            console.warn(`Menu item ${req.params.id} not found for deletion.`);
            return res.status(404).json({ message: 'Product not found' });
        }
        console.log('Menu item deleted successfully:', deletedProduct.name);
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting menu item:', error.message); // Log specific error
        res.status(500).json({ message: 'Error deleting menu item' });
    }
});

// --- API for Admin Shop Settings ---
app.get('/api/admin/settings', isAuthenticated, async (req, res) => {
    console.log('API: /api/admin/settings hit.');
    try {
        const settings = await AdminSettings.findOne();
        if (!settings) {
            console.warn('Admin settings not found in DB. Returning default structure.');
            return res.json({ shopName: 'My Food Business', shopLocation: { latitude: 0, longitude: 0 }, deliveryRates: [] });
        }
        console.log('Fetched admin settings:', settings);
        res.json(settings);
    } catch (error) {
        console.error('Error fetching admin settings:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching settings' });
    }
});

app.put('/api/admin/settings', isAuthenticated, async (req, res) => {
    console.log('API: /api/admin/settings PUT hit.');
    try {
        console.log('Attempting to update admin settings. Received body:', req.body); // Log received body
        const updatedSettings = await AdminSettings.findOneAndUpdate({}, req.body, { new: true, upsert: true, runValidators: true }); // runValidators ensures schema validation
        console.log('Admin settings updated successfully:', updatedSettings);
        res.json(updatedSettings);
    } catch (error) {
        console.error('Error updating admin settings:', error.message); // Log specific error
        res.status(500).json({ message: 'Error updating settings', details: error.message }); // Send details to frontend for debugging
    }
});

// NEW API: Get all customers with their last known location from orders
app.get('/api/admin/customers', isAuthenticated, async (req, res) => {
    console.log('API: /api/admin/customers hit.');
    try {
        const customerNotifications = await CustomerNotification.find({});
        const customersData = [];
        const settings = await AdminSettings.findOne({}, 'shopLocation'); // Get shop location for tracking

        for (const customerNotif of customerNotifications) {
            const latestOrder = await Order.findOne({ customerPhone: customerNotif.customerPhone })
                                            .sort({ orderDate: -1 })
                                            .select('customerName customerPhone customerLocation') // Select only needed fields
                                            .lean(); // Return plain JavaScript objects

            if (latestOrder) {
                customersData.push({
                    customerName: latestOrder.customerName,
                    customerPhone: latestOrder.customerPhone, // Corrected typo here
                    lastKnownLocation: latestOrder.customerLocation || null, // Can be null if order didn't have location
                    shopLocation: settings ? settings.shopLocation : null // Include shop location
                });
            } else {
                // If no order found, still list the customer from notifications but without location
                customersData.push({
                    customerName: 'N/A', // Or try to infer from other data if available
                    customerPhone: customerNotif.customerPhone,
                    lastKnownLocation: null,
                    shopLocation: settings ? settings.shopLocation : null
                });
            }
        }
        console.log(`Fetched ${customersData.length} customer records.`);
        res.json(customersData);
    } catch (error) {
        console.error('Error fetching customer data:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching customer data' });
    }
});


// Public Web Menu Panel - now serves menu_panel.html
app.get('/menu', async (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'menu_panel.html'));
    } catch (error) {
        console.error('Error serving menu_panel.html:', error);
        res.status(500).send('<h1>Error loading Menu Panel.</h1><p>Please check server logs.</p>');
    }
});

// API for Public Menu
app.get('/api/menu', async (req, res) => {
    console.log('API: /api/menu hit.');
    try {
        const products = await Product.find({ isAvailable: true }).sort({ category: 1, name: 1 });
        console.log(`Fetched ${products.length} public menu items.`);
        res.json(products);
    } catch (error) {
        console.error('Error fetching public menu:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching menu items' });
    }
});

// API for Public Shop Settings (only what's needed for delivery calculation)
app.get('/api/public/settings', async (req, res) => {
    console.log('API: /api/public/settings hit.');
    try {
        const settings = await AdminSettings.findOne({}, 'shopLocation deliveryRates shopName'); // Fetch shopName as well
        console.log('Fetched public settings:', settings);
        res.json(settings);
    }
    catch (error) {
        console.error('Error fetching public settings:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching settings' });
    }
});


// API for Delivery Cost Calculation
app.post('/api/calculate-delivery-cost', async (req, res) => {
    console.log('API: /api/calculate-delivery-cost hit.');
    const { customerLocation } = req.body;
    if (!customerLocation || typeof customerLocation.latitude === 'undefined' || typeof customerLocation.longitude === 'undefined') {
        console.warn('Missing customer location for delivery cost calculation.');
        return res.status(400).json({ message: 'Customer location (latitude, longitude) is required.' });
    }

    try {
        const settings = await AdminSettings.findOne();
        if (!settings || !settings.shopLocation || !settings.deliveryRates || settings.deliveryRates.length === 0) {
            console.warn('Shop location or delivery rates not configured by admin for delivery cost calculation.');
            return res.status(500).json({ message: 'Shop location or delivery rates not configured by admin.' });
        }

        const distance = haversineDistance(
            settings.shopLocation.latitude,
            settings.shopLocation.longitude,
            customerLocation.latitude,
            customerLocation.longitude
        );

        let transportTax = 0;
        // Find the appropriate tax rate based on distance
        const sortedRates = settings.deliveryRates.sort((a, b) => a.kms - b.kms);
        for (let i = 0; i < sortedRates.length; i++) {
            if (distance <= sortedRates[i].kms) {
                transportTax = sortedRates[i].amount;
                break;
            }
            // If it's the last rate and distance is greater, use this rate
            if (i === sortedRates.length - 1 && distance > sortedRates[i].kms) { // Corrected logic: only apply if distance exceeds this last rate's KMS
                transportTax = sortedRates[i].amount;
            }
        }
        console.log(`Calculated distance: ${distance.toFixed(2)}km, transport tax: ₹${transportTax.toFixed(2)}`);
        res.json({ distance, transportTax });

    } catch (error) {
        console.error('Error calculating delivery cost:', error.message); // Log specific error
        res.status(500).json({ message: 'Error calculating delivery cost' });
    }
});

// API for Placing Orders
app.post('/api/order', async (req, res) => {
    console.log('API: /api/order POST hit.');
    const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount } = req.body;

    if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || typeof subtotal === 'undefined' || typeof totalAmount === 'undefined') {
        console.warn('Missing required order details in POST /api/order.');
        return res.status(400).json({ message: 'Missing required order details.' });
    }

    try {
        // Fetch shop location at the time of order
        const settings = await AdminSettings.findOne();
        const deliveryFromLocation = settings ? settings.shopLocation : { latitude: 0, longitude: 0 }; // Default if not found

        const newOrder = new Order({
            items,
            customerName,
            customerPhone,
            deliveryAddress,
            customerLocation,
            deliveryFromLocation, // Save shop location for tracking
            subtotal,
            transportTax,
            totalAmount,
            status: 'Pending'
        });
        await newOrder.save();
        console.log('New order placed successfully:', newOrder._id);

        // Update customer notification date to reset weekly reminder timer
        await updateCustomerNotification(customerPhone);

        // Notify Admin via WhatsApp
        if (clientReady) {
            // Use YOUR_KOYEB_URL if set, otherwise fallback to localhost for development
            const baseUrl = process.env.YOUR_KOYEB_URL || 'http://localhost:8080';
            const adminMessage = `🔔 NEW ORDER PLACED! 🔔\n\n` +
                                 `Order ID: ${newOrder._id.toString().substring(0, 6)}...\n` +
                                 `Customer: ${newOrder.customerName}\n` +
                                 `Phone: ${newOrder.customerPhone}\n` +
                                 `Total: ₹${newOrder.totalAmount.toFixed(2)}\n` +
                                 `Address: ${newOrder.deliveryAddress}\n\n` +
                                 `View on Dashboard: ${baseUrl}/admin/dashboard`;
            client.sendMessage(ADMIN_NUMBER + '@c.us', adminMessage)
                .then(() => console.log('Admin notified via WhatsApp for new order'))
                .catch(err => console.error('Error sending WhatsApp notification to admin:', err));
        } else {
            console.warn('WhatsApp client not ready, cannot send admin notification.');
        }

        // Notify Admin Dashboard via Socket.IO
        io.emit('newOrder', newOrder);

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder, orderId: newOrder._id }); // Return orderId for tracking
    } catch (error) {
        console.error('Error placing order:', error.message); // Log specific error
        res.status(500).json({ message: 'Error placing order.' });
    }
});

// API for fetching a single order by ID (for tracking)
app.get('/api/order/:id', async (req, res) => {
    console.log(`API: /api/order/${req.params.id} hit.`);
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            console.log(`Order ${req.params.id} not found for tracking.`);
            return res.status(404).json({ message: 'Order not found' });
        }
        console.log(`Fetched order ${req.params.id} for tracking.`);
        res.json(order);
    } catch (error) {
        console.error('Error fetching order for tracking:', error.message); // Log specific error
        res.status(500).json({ message: 'Error fetching order details.' });
    }
});

