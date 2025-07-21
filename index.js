const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const cron = require('node-cron');
const speakeasy = require('speakeasy');
const fs = require('fs');
const crypto = require('crypto'); // For Razorpay signature verification
const Razorpay = require('razorpay'); // Import Razorpay

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware for parsing JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT Secret (ensure this is in your .env file in production)
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

// --- WARNING: HARDCODED ADMIN CREDENTIALS ---
// This is for testing purposes ONLY as per user request.
// NEVER use hardcoded credentials in a production environment.
// For production, use the /admin/create-initial-admin endpoint and store credentials securely.
const DEFAULT_ADMIN_USERNAME = 'dashboard_admin';
const DEFAULT_ADMIN_PASSWORD = 'password123';
// --- END WARNING ---

// Razorpay Initialization
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas
const ItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    imageUrl: String,
    category: String,
    isAvailable: { type: Boolean, default: true },
    isTrending: { type: Boolean, default: false }
});

const OrderSchema = new mongoose.Schema({
    customOrderId: { type: String, unique: true, sparse: true }, // Custom user-facing order ID
    pinId: { type: String, unique: true, sparse: true }, // 10-digit PIN for lookup
    customerPhone: { type: String, required: true },
    customerName: String,
    customerLocation: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    items: [{
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
        name: String,
        price: Number,
        quantity: { type: Number, required: true }
    }],
    totalAmount: { type: Number, required: true },
    subtotal: { type: Number, default: 0 },
    transportTax: { type: Number, default: 0 },
    orderDate: { type: Date, default: Date.now, index: true }, // Indexed for faster sorting
    status: { type: String, default: 'Pending', enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'] },
    paymentMethod: { type: String, default: 'Cash on Delivery', enum: ['Cash on Delivery', 'Online Payment'] },
    deliveryAddress: String,
    lastMessageTimestamp: { type: Date, default: Date.now },
    razorpayOrderId: { type: String, unique: true, sparse: true }, // Store Razorpay Order ID
    razorpayPaymentId: { type: String, unique: true, sparse: true }, // Store Razorpay Payment ID
});

const CustomerSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true },
    customerName: String,
    totalOrders: { type: Number, default: 0 },
    lastOrderDate: Date,
    lastKnownLocation: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    lastNotificationSent: { type: Date }
});

const AdminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    totpSecret: { type: String, default: null }
});

const SettingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'Delicious Bites' },
    shopLocation: {
        latitude: { type: Number, default: 17.4399 },
        longitude: { type: Number, default: 78.4983 }
    },
    deliveryRates: [{
        kms: { type: Number, required: true },
        amount: { type: Number, required: true }
    }],
    whatsappStatus: { type: String, default: 'disconnected', enum: ['disconnected', 'qr_received', 'authenticated', 'ready', 'auth_failure', 'initializing', 'qr_error'] },
    lastAuthenticatedAt: Date
});

const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Admin = mongoose.model('Admin', AdminSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// --- Utility Functions for Custom IDs ---
function generateCustomOrderId() {
    const timestampPart = Date.now().toString().slice(-6); // Last 6 digits of timestamp
    const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 random chars
    return `JAR${timestampPart}${randomPart}`;
}

async function generateUniquePinId() {
    let pin;
    let isUnique = false;
    while (!isUnique) {
        // Generate a random 10-digit number as a string
        pin = Math.floor(1000000000 + Math.random() * 9000000000).toString();
        const existingOrder = await Order.findOne({ pinId: pin });
        if (!existingOrder) {
            isUnique = true;
        }
    }
    return pin;
}


// --- WhatsApp Client Initialization & State Management ---
let client = null;
let whatsappReady = false; // True when client.on('ready') fires
let qrCodeData = null; // Stores the base64 QR image
let qrExpiryTimer = null; // Timer for QR code expiry
let isInitializing = false; // Flag to prevent multiple concurrent initializations
let currentInitializationAttempt = 0; // Tracks attempts for current client.initialize() call
const MAX_INITIALIZATION_ATTEMPTS = 3; // Max retries for client.initialize()
const RETRY_DELAY_MS = 5000; // Delay before retrying initialization

const SESSION_PATH = path.join(__dirname, '.wwebjs_auth');

/**
 * Deletes WhatsApp session files.
 */
const deleteSessionFiles = async () => {
    console.log('[WhatsApp] Attempting to delete WhatsApp session files...');
    try {
        if (fs.existsSync(SESSION_PATH)) {
            await fs.promises.rm(SESSION_PATH, { recursive: true, force: true });
            console.log('[WhatsApp] WhatsApp session files deleted successfully.');
        } else {
            console.log('[WhatsApp] No WhatsApp session files found to delete.');
        }
    } catch (err) {
        console.error('[WhatsApp] Error deleting WhatsApp session files:', err);
    }
};

/**
 * Initializes the WhatsApp client.
 * @param {boolean} forceNewSession - If true, deletes existing session files and forces a new QR.
 */
const initializeWhatsappClient = async (forceNewSession = false) => {
    if (isInitializing) {
        console.log('[WhatsApp] Initialization already in progress. Skipping call.');
        return;
    }

    isInitializing = true;
    currentInitializationAttempt++;
    console.log(`[WhatsApp] Starting initialization (Force new session: ${forceNewSession}). Attempt ${currentInitializationAttempt}/${MAX_INITIALIZATION_ATTEMPTS}`);

    // Update status in DB and emit to dashboard
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');

    // If client instance exists, destroy it first to ensure a clean slate
    if (client) {
        try {
            console.log('[WhatsApp] Destroying previous client instance...');
            await client.destroy();
            client = null;
            whatsappReady = false; // Reset ready state
        } catch (e) {
            console.error('[WhatsApp] Error destroying old client:', e);
            client = null;
            whatsappReady = false;
        }
    }

    // Delete session files if forcing a new session
    if (forceNewSession) {
        await deleteSessionFiles();
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'admin',
            dataPath: SESSION_PATH
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true,
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    // --- WhatsApp Client Event Listeners ---
    client.on('qr', async (qr) => {
        console.log('[WhatsApp] QR RECEIVED');
        qrCodeData = await qrcode.toDataURL(qr);
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_received', lastAuthenticatedAt: null }, { upsert: true });
        io.emit('status', 'qr_received');
        io.emit('qrCode', qrCodeData); // Emit QR code immediately

        // Clear any existing QR expiry timer
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        qrExpiryTimer = setTimeout(async () => {
            // Only reinitialize if QR is still active and client is not ready/authenticated
            if (!whatsappReady && qrCodeData !== null) {
                console.log('[WhatsApp] QR code expired. Reinitializing with new session...');
                qrCodeData = null;
                io.emit('qrCode', null);
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
                io.emit('status', 'qr_error');
                isInitializing = false; // Allow re-initialization
                initializeWhatsappClient(true); // Force a new session
            }
        }, 60000); // 60 seconds expiry
        currentInitializationAttempt = 0; // Reset retry count upon successful QR generation
    });

    client.on('authenticated', async (session) => {
        console.log('[WhatsApp] AUTHENTICATED');
        whatsappReady = false; // Not yet ready, but authenticated
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'authenticated', lastAuthenticatedAt: new Date() }, { upsert: true });
        io.emit('status', 'authenticated');
        io.emit('sessionInfo', { lastAuthenticatedAt: new Date() });
        qrCodeData = null; // Clear QR data
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer); // Clear QR expiry timer
        currentInitializationAttempt = 0; // Reset retry count upon authentication
    });

    client.on('ready', async () => {
        console.log('[WhatsApp] Client is ready!');
        whatsappReady = true;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'ready' }, { upsert: true });
        io.emit('status', 'ready');
        // Ensure lastAuthenticatedAt is up-to-date, fetch from DB if needed
        const settings = await Settings.findOne({});
        io.emit('sessionInfo', { lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null });
        isInitializing = false; // Initialization complete
        currentInitializationAttempt = 0; // Reset retry count when ready
    });

    client.on('auth_failure', async msg => {
        console.error('[WhatsApp] AUTHENTICATION FAILURE', msg);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
        io.emit('status', 'auth_failure');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        console.log('[WhatsApp] Reinitializing client due to auth_failure (forcing new session)...');
        isInitializing = false; // Allow re-initialization
        initializeWhatsappClient(true); // Force a new session after auth failure
    });

    client.on('disconnected', async (reason) => {
        console.log('[WhatsApp] Client was disconnected', reason);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
        io.emit('status', 'disconnected');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

        isInitializing = false; // Allow re-initialization

        // Decide whether to force a new session or try to reconnect with existing one
        if (reason === 'LOGOUT' || reason === 'PRIMARY_UNAVAILABLE' || reason === 'UNEXPECTED_LOGOUT') {
             console.log('[WhatsApp] Reinitializing client due to critical disconnection (forcing new session)...');
             initializeWhatsappClient(true); // Force a new session
        } else {
            console.log(`[WhatsApp] Client disconnected for reason: ${reason}. Attempting to reconnect with existing session...`);
            // Only retry if we haven't reached max attempts for this specific client.initialize() call
            if (currentInitializationAttempt < MAX_INITIALIZATION_ATTEMPTS) {
                setTimeout(() => initializeWhatsappClient(false), RETRY_DELAY_MS);
            } else {
                console.error('[WhatsApp] Max reconnection attempts reached after disconnection. Manual intervention might be needed.');
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
                io.emit('status', 'disconnected');
                currentInitializationAttempt = 0; // Reset for next manual attempt
            }
        }
    });

    // --- Message Listener (MOVED HERE) ---
    client.on('message', async msg => {
        const chatId = msg.from;
        const text = msg.body.toLowerCase().trim();
        const customerPhone = chatId.includes('@c.us') ? chatId.split('@')[0] : chatId;
        const customerName = msg._data.notifyName;

        if (msg.hasMedia && msg.type === 'location' && msg.location) {
            const { latitude, longitude, address } = msg.location;
            await Customer.findOneAndUpdate(
                { customerPhone: customerPhone },
                {
                    $set: {
                        lastKnownLocation: {
                            latitude: latitude,
                            longitude: longitude,
                            address: address || 'Location shared via WhatsApp'
                        }
                    }
                },
                { upsert: true, new: true }
            );
            await client.sendMessage(chatId, 'Your location has been updated. Thank you!');
            return;
        }

        let customer = await Customer.findOne({ customerPhone: customerPhone });
        if (!customer) {
            customer = new Customer({ customerPhone: customerPhone, customerName: customerName });
            await customer.save();
        } else {
            if (customer.customerName !== customerName) {
                customer.customerName = customerName;
                await customer.save();
            }
        }

        switch (text) {
            case 'hi':
            case 'hello':
            case 'namaste':
            case 'menu':
                await sendWelcomeMessage(chatId, customerName);
                break;
            case '1':
            case 'view menu':
                await sendMenu(chatId);
                break;
            case '2':
            case 'shop location':
                await sendShopLocation(chatId);
                break;
            case '4':
            case 'my orders':
                await sendCustomerOrders(chatId, customerPhone);
                break;
            case '5':
            case 'help':
                await sendHelpMessage(chatId);
                break;
            case 'cod':
            case 'cash on delivery':
                const pendingOrderCod = await Order.findOneAndUpdate(
                    { customerPhone: customerPhone, status: 'Pending' },
                    { $set: { paymentMethod: 'Cash on Delivery', status: 'Confirmed' } },
                    { new: true, sort: { orderDate: -1 } }
                );
                if (pendingOrderCod) {
                    await client.sendMessage(chatId, 'Your order has been confirmed for Cash on Delivery. Thank you! Your order will be processed shortly. 😊');
                    io.emit('new_order', pendingOrderCod);
                } else {
                    await client.sendMessage(chatId, 'You have no pending orders. Please place an order first.');
                }
                break;
            case 'op':
            case 'online payment':
                // This case is primarily handled by the web menu now.
                // If a user types 'op', they should be redirected to the web menu.
                await client.sendMessage(chatId, 'To complete an online payment, please place your order through our web menu: ' + process.env.WEB_MENU_URL);
                break;
            default:
                // Check if the message is a PIN for order tracking
                if (text.length === 10 && !isNaN(text) && !text.startsWith('0')) { // Simple check for 10-digit number
                    const orderToTrack = await Order.findOne({ pinId: text });
                    if (orderToTrack) {
                        await client.sendMessage(chatId, `Order ID: ${orderToTrack.customOrderId}\nStatus: ${orderToTrack.status}\nTotal: ₹${orderToTrack.totalAmount.toFixed(2)}\nItems: ${orderToTrack.items.map(item => `${item.name} x ${item.quantity}`).join(', ')}`);
                        return;
                    }
                }

                const lastOrderInteraction = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });

                if (lastOrderInteraction && moment().diff(moment(lastOrderInteraction.orderDate), 'minutes') < 5 && lastOrderInteraction.status === 'Pending') {
                    if (!lastOrderInteraction.deliveryAddress || lastOrderInteraction.deliveryAddress === 'Address not yet provided.') {
                        await Order.findOneAndUpdate(
                            { _id: lastOrderInteraction._id },
                            { $set: { deliveryAddress: msg.body } },
                            { new: true }
                        );
                        await client.sendMessage(chatId, 'Your delivery address has been saved. Please choose your payment method: ' +
                                                  "'Cash on Delivery' (COD) or 'Online Payment' (OP).");
                    } else {
                        await client.sendMessage(chatId, 'I did not understand your request. To place an order, please visit our web menu: ' + process.env.WEB_MENU_URL + '. You can also type "Hi" to return to the main menu or ask for "Help".');
                    }
                } else {
                    await client.sendMessage(chatId, 'I did not understand your request. To place an order, please visit our web menu: ' + process.env.WEB_MENU_URL + '. You can also type "Hi" to return to the main menu or ask for "Help".');
                }
                break;
        }
    });

    // --- Attempt to initialize the client ---
    try {
        await client.initialize();
        console.log('[WhatsApp] client.initialize() called successfully.');
        // The 'ready' event will set isInitializing to false and reset currentInitializationAttempt
    } catch (err) {
        console.error(`[WhatsApp] client.initialize() error: ${err.message}`);
        whatsappReady = false;
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

        // If initialization fails, retry if max attempts not reached
        if (currentInitializationAttempt < MAX_INITIALIZATION_ATTEMPTS) {
            console.log(`[WhatsApp] Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            isInitializing = false; // Allow retry
            setTimeout(() => initializeWhatsappClient(forceNewSession), RETRY_DELAY_MS);
        } else {
            console.error('[WhatsApp] Max initialization attempts reached. WhatsApp client failed to initialize.');
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
            io.emit('status', 'qr_error');
            isInitializing = false; // Allow future manual initialization
            currentInitializationAttempt = 0; // Reset for next manual attempt
        }
    }
};

// Initial call to start WhatsApp client on server startup
(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected') {
        // If no settings or explicitly disconnected, start fresh
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
        initializeWhatsappClient(true); // Force new session on initial startup if disconnected
    } else {
        // Otherwise, try to load existing session
        initializeWhatsappClient(false);
    }
})();


// --- Bot Logic Functions (kept separate for clarity, but called from message listener) ---
const sendWelcomeMessage = async (chatId, customerName) => {
    const menuOptions = [
        "1. 🍕 View Menu",
        "2. 📍 Shop Location",
        "4. 📝 My Orders",
        "5. ℹ️ Help"
    ];
    const welcomeText = `👋 Hello ${customerName || 'customer'}! Welcome to Delicious Bites! 🌟\n\nTo place an order, please visit our web menu: ${process.env.WEB_MENU_URL}\n\nHow can I help you otherwise?\n\n${menuOptions.join('\n')}\n\nChoose an option above.`;
    await client.sendMessage(chatId, welcomeText);
};

const sendShopLocation = async (chatId) => {
    const settings = await Settings.findOne({});
    if (settings && settings.shopLocation && settings.shopLocation.latitude && settings.shopLocation.longitude) {
        const { latitude, longitude } = settings.shopLocation;
        const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        await client.sendMessage(chatId, `📍 Our shop location is here:\n${googleMapsLink}\n\nWe hope to see you soon!`);
    } else {
        await client.sendMessage(chatId, 'Sorry, shop location is currently unavailable. Please contact the admin.');
    }
};

const sendMenu = async (chatId) => {
    const items = await Item.find({ isAvailable: true });
    if (items.length === 0) {
        await client.sendMessage(chatId, 'There are currently no items on the menu. Please try again later.');
        return;
    }

    let menuMessage = "📜 Our Menu:\n\n";
    const categories = {};
    items.forEach(item => {
        const category = item.category || 'Other';
        if (!categories[category]) {
            categories[category] = [];
        }
        categories[category].push(item);
    });

    for (const category in categories) {
        menuMessage += `*${category}*\n`;
        categories[category].forEach((item, index) => {
            menuMessage += `${index + 1}. ${item.name} - ₹${item.price.toFixed(2)}${item.isTrending ? ' ✨' : ''}\n`;
            if (item.description) {
                menuMessage += `   _(${item.description})_\n`;
            }
        });
        menuMessage += '\n';
    }
    menuMessage += "To place an order, please visit our web menu: " + process.env.WEB_MENU_URL + "\n\nYou can also type 'Hi' to return to the main menu.";
    await client.sendMessage(chatId, menuMessage);
};

const sendCustomerOrders = async (chatId, customerPhone) => {
    // Fetch orders using customOrderId or pinId if available, otherwise use _id
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(5);

    if (orders.length === 0) {
        await client.sendMessage(chatId, 'You have not placed any orders yet.');
        return;
    }

    let orderListMessage = 'Your Past Orders:\n\n';
    orders.forEach((order, index) => {
        const displayId = order.customOrderId || order._id.substring(0, 6) + '...';
        orderListMessage += `*Order ${index + 1} (ID: ${displayId})*\n`;
        if (order.pinId) {
            orderListMessage += `  PIN: ${order.pinId}\n`;
        }
        order.items.forEach(item => {
            orderListMessage += `  - ${item.name} x ${item.quantity}\n`;
        });
        orderListMessage += `  Total: ₹${order.totalAmount.toFixed(2)}\n`;
        orderListMessage += `  Status: ${order.status}\n`;
        orderListMessage += `  Date: ${new Date(order.orderDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
    });
    await client.sendMessage(chatId, orderListMessage);
};

const sendHelpMessage = async (chatId) => {
    const helpMessage = `How can I help you? You can try the following:\n
*Hi* - To return to the main menu
*View Menu* - To see our available items
*My Orders* - To view your past orders
*Shop Location* - To get our shop's location
*Help* - To see this help message again\n\nTo place an order, please visit our web menu: ${process.env.WEB_MENU_URL}`;
    await client.sendMessage(chatId, helpMessage);
};

// --- Fleeting Lines for Re-Order Notifications ---
const reOrderNotificationMessagesTelugu = [
    "Feeling hungry again? 😋 New flavors await on our menu! Order now! 🚀",
    "Missing our delicious dishes? 💖 Order your next meal now!🍽️",
    "7 days have passed! ⏳ It's the perfect time to re-order. Your favorite dishes are ready! ✨",
    "Special offer! 🎉 Get a discount on your next order this week. Check out the menu! 📜",
    "It's been 7 days since your last order from us. Re-order your favorites! 🧡",
    "Hungry? 🤤 Order your favorite meal from Delicious Bites now! 💨",
    "Want to see what's new on our menu? 👀 Order now and try it out! 🌟",
    "Have you forgotten our taste? 😋 It's the perfect time to re-order! 🥳",
    "Thinking of ordering? 🤔 This is the right hint! Order now! 👇",
    "Your last order was great, right? 😉 Get that experience again! 💯"
];

// --- Scheduled Notification Function ---
const sendReorderNotification = async () => {
    if (!whatsappReady) {
        console.log('[Scheduler] WhatsApp client not ready for scheduled notifications. Skipping job.');
        return;
    }

    console.log('[Scheduler] Running 7-day re-order notification job...');
    const sevenDaysAgo = moment().subtract(7, 'days').toDate();
    const twoDaysAgo = moment().subtract(2, 'days').toDate();

    try {
        const customersToNotify = await Customer.find({
            totalOrders: { $gt: 0 },
            $or: [
                { lastNotificationSent: { $exists: false } },
                { lastNotificationSent: { $lt: sevenDaysAgo } }
            ],
            lastOrderDate: { $lt: twoDaysAgo }
        });

        console.log(`[Scheduler] Found ${customersToNotify.length} customers to notify.`);

        for (const customer of customersToNotify) {
            const chatId = customer.customerPhone + '@c.us';
            const randomIndex = Math.floor(Math.random() * reOrderNotificationMessagesTelugu.length);
            const message = reOrderNotificationMessagesTelugu[randomIndex];

            try {
                const notificationMessage = `${message}\n\nVisit our web menu to order: ${process.env.WEB_MENU_URL}`;
                await client.sendMessage(chatId, notificationMessage);
                await Customer.findByIdAndUpdate(customer._id, { lastNotificationSent: new Date() });
                console.log(`[Scheduler] Sent re-order notification to ${customer.customerPhone}`);
            } catch (msgSendError) {
                console.error(`[Scheduler] Failed to send re-order notification to ${customer.customerPhone}:`, msgSendError);
            }
        }
        console.log('[Scheduler] 7-day re-order notification job finished.');

    } catch (dbError) {
        console.error('[Scheduler] Error in 7-day re-order notification job (DB query):', dbError);
    }
};

cron.schedule('0 9 * * *', () => {
    sendReorderNotification();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
console.log('7-day re-order notification job scheduled to run daily at 9:00 AM IST.');


// --- Admin API Routes ---
app.post('/admin/login', async (req, res) => {
    const { username, password, totpCode } = req.body;

    const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });

    if (!admin) {
        return res.status(500).json({ message: 'Admin user not found in database. Please restart server.' });
    }

    // Verify password first
    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
        return res.status(401).json({ message: 'Invalid username or password.' });
    }

    if (!admin.totpSecret) {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token, twoFactorEnabled: false });
    }

    if (!totpCode) {
        return res.status(401).json({ message: 'Two-Factor Authentication code required.' });
    }

    const verified = speakeasy.totp.verify({
        secret: admin.totpSecret,
        encoding: 'base32',
        token: totpCode,
        window: 1
    });

    if (!verified) {
        return res.status(401).json({ message: 'Invalid Two-Factor Authentication code.' });
    }

    const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, twoFactorEnabled: true });
});

app.get('/admin/logout', (req, res) => {
    res.send('Logged out successfully');
});

// Authentication Middleware for Admin APIs
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) {
        console.log('Unauthorized: No token provided. (Request to ' + req.path + ')');
        return res.status(401).json({ message: 'Unauthorized: No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message, '(Token received for ' + req.path + ')');
            // Check if token is expired
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Unauthorized: Session expired. Please log in again.' });
            }
            return res.status(403).json({ message: 'Forbidden: Invalid token.' });
        }
        req.user = user;
        next();
    });
};

// --- 2FA Specific Endpoints (operate on DEFAULT_ADMIN_USERNAME) ---
app.get('/api/admin/2fa/status', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }
        res.json({ twoFactorEnabled: !!admin.totpSecret });
    } catch (error) {
        console.error('Error fetching 2FA status:', error);
        res.status(500).json({ message: 'Error fetching 2FA status.' });
    }
});

app.post('/api/admin/2fa/generate', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        const secret = speakeasy.generateSecret({
            name: `DeliciousBites Admin (${admin.username})`,
            length: 20
        });
        // Do NOT save the secret to DB here. Only save after successful verification.
        // This prevents generating a new secret every time the modal is opened.
        // Instead, we'll return the secret and QR, and the client will verify it.
        // The secret will be temporarily stored on the client side or derived from the QR.

        // For simplicity, we'll temporarily store it on the admin object in memory
        // This is not ideal for multi-instance deployments, but fine for a single server.
        admin.currentTotpSecret = secret.base32; // Temporary in-memory storage

        qrcode.toDataURL(secret.otpauth_url, (err, data_url) => {
            if (err) {
                console.error('Error generating QR code:', err);
                return res.status(500).json({ message: 'Error generating QR code.' });
            }
            res.json({ qrCodeUrl: data_url, secret: secret.base32 });
        });

    } catch (error) {
        console.error('Error generating 2FA secret:', error);
        res.status(500).json({ message: 'Error generating 2FA secret.' });
    }
});

app.post('/api/admin/2fa/verify', authenticateToken, async (req, res) => {
    const { totpCode, secret } = req.body; // Expect secret from frontend
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        if (!secret) {
            return res.status(400).json({ message: 'TOTP secret is missing for verification.' });
        }

        const verified = speakeasy.totp.verify({
            secret: secret, // Use the secret sent from the frontend
            encoding: 'base32',
            token: totpCode,
            window: 1
        });

        if (verified) {
            admin.totpSecret = secret; // Save the secret to DB only upon successful verification
            await admin.save();
            res.json({ verified: true, message: '2FA successfully enabled.' });
        } else {
            res.status(401).json({ verified: false, message: 'Invalid 2FA code.' });
        }
    } catch (error) {
        console.error('Error verifying 2FA code:', error);
        res.status(500).json({ message: 'Error verifying 2FA code.' });
    }
});

app.post('/api/admin/2fa/disable', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }
        admin.totpSecret = null;
        await admin.save();
        res.json({ message: 'Two-Factor Authentication disabled successfully.' });
    } catch (error) {
        console.error('Error disabling 2FA:', error);
        res.status(500).json({ message: 'Error disabling 2FA.' });
    }
});

// --- Other Admin API Endpoints (still require authentication) ---
app.get('/api/admin/bot-status', authenticateToken, async (req, res) => {
    const settings = await Settings.findOne({});
    res.json({
        status: settings ? settings.whatsappStatus : 'disconnected',
        lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null,
        qrCodeAvailable: qrCodeData !== null // Indicate if QR is currently available
    });
});

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    // This endpoint is primarily for admin to force a re-initialization,
    // potentially with a new QR if the current session is problematic.
    // It should always trigger a reset.
    console.log('[API] Admin requested to load/re-initialize session.');
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    isInitializing = false; // Allow the call to proceed
    initializeWhatsappClient(true); // Force a new session
    res.status(200).json({ message: 'Attempting to load new session or generate QR.' });
});

app.get('/api/admin/menu', authenticateToken, async (req, res) => {
    try {
        const items = await Item.find({});
        res.json(items);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching menu items', error: error.message });
    }
});

app.get('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) return res.status(404).json({ message: 'Item not found' });
        res.json(item);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching menu item', error: error.message });
    }
});

app.post('/api/admin/menu', authenticateToken, async (req, res) => {
    try {
        const newItem = new Item(req.body);
        await newItem.save();
        res.status(201).json({ message: 'Menu item added successfully', item: newItem });
    } catch (error) {
        res.status(400).json({ message: 'Error adding menu item', error: error.message });
    }
});

app.put('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const updatedItem = await Item.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!updatedItem) return res.status(404).json({ message: 'Item not found' });
        res.json({ message: 'Menu item updated successfully', item: updatedItem });
    }
    catch (error) {
        res.status(400).json({ message: 'Error updating menu item', error: error.message });
    }
});

app.delete('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const deletedItem = await Item.findByIdAndDelete(req.params.id);
        if (!deletedItem) return res.status(404).json({ message: 'Item not found' });
        res.json({ message: 'Menu item deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting menu item', error: error.message });
    }
});

app.get('/api/admin/orders', authenticateToken, async (req, res) => {
    try {
        // Fetch orders and sort by orderDate for admin view
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching orders', error: error.message });
    }
});

app.get('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        res.json(order);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching order', error: error.message });
    }
});

app.put('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        const updatedOrder = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true, runValidators: true });
        if (!updatedOrder) return res.status(404).json({ message: 'Order not found' });

        if (whatsappReady) {
            // Ensure customerPhone is in the correct format for whatsapp-web.js
            const customerChatId = updatedOrder.customerPhone.includes('@c.us') ? updatedOrder.customerPhone : updatedOrder.customerPhone + '@c.us';
            await client.sendMessage(customerChatId, `Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) status has been updated to '${status}'.`);
        }

        res.json({ message: 'Order status updated successfully', order: updatedOrder });
    } catch (error) {
        res.status(400).json({ message: 'Error updating order status', error: error.message });
    }
});

app.delete('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) return res.status(404).json({ message: 'Order not found' });
        res.json({ message: 'Order deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting order', error: error.message });
    }
});

app.get('/api/admin/customers', authenticateToken, async (req, res) => {
    try {
        const customers = await Customer.find({});
        res.json(customers);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching customers', error: error.message });
    }
});

app.get('/api/admin/customers/:phone/latest-order', authenticateToken, async (req, res) => {
    try {
        const customerPhone = req.params.phone;
        const latestOrder = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });
        if (!latestOrder) {
            return res.status(404).json({ message: 'No orders found for this customer.' });
        }
        res.json(latestOrder);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching latest order', error: error.message });
    }
});

app.delete('/api/admin/customers/:id', authenticateToken, async (req, res) => {
    try {
        const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);
        if (!deletedCustomer) return res.status(404).json({ message: 'Customer not found' });
        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting customer', error: error.message });
    }
});

app.get('/api/admin/settings', authenticateToken, async (req, res) => {
    try {
        let settings = await Settings.findOne({});
        if (!settings) {
            settings = new Settings();
            await settings.save();
        }
        res.json(settings);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching settings', error: error.message });
    }
});

app.put('/api/admin/settings', authenticateToken, async (req, res) => {
    try {
        const updatedSettings = await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true, runValidators: true });
        res.json({ message: 'Settings updated successfully', settings: updatedSettings });
    }
    catch (error) {
        res.status(400).json({ message: 'Error updating settings', error: error.message });
    }
});

// --- Public API Routes (no authentication needed) ---
app.get('/api/menu', async (req, res) => {
    try {
        const items = await Item.find({ isAvailable: true });
        res.json(items);
    } catch (err) {
        console.error('Error fetching public menu items:', err);
        res.status(500).json({ message: 'Failed to fetch menu items.' });
    }
});

app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne();
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

// New endpoint to create Razorpay order
app.post('/api/create-razorpay-order', async (req, res) => {
    const { amount, currency } = req.body; // amount in paisa

    if (!amount || !currency) {
        return res.status(400).json({ message: 'Amount and currency are required.' });
    }

    try {
        const options = {
            amount: amount, // amount in the smallest currency unit
            currency: currency,
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1 // auto-capture payment
        };
        const order = await razorpay.orders.create(options);
        res.status(200).json({ orderId: order.id });
    } catch (error) {
        console.error('Error creating Razorpay order:', error);
        res.status(500).json({ message: 'Failed to create Razorpay order.', error: error.message });
    }
});

// New endpoint to verify Razorpay payment and finalize order
app.post('/api/verify-payment', async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderData } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderData) {
        return res.status(400).json({ message: 'Missing payment verification details or order data.' });
    }

    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest === razorpay_signature) {
        try {
            // Generate custom order ID and PIN ID
            const customOrderId = generateCustomOrderId();
            const pinId = await generateUniquePinId();

            const itemDetails = [];
            for (const item of orderData.items) {
                const product = await Item.findById(item.productId);
                if (!product || !product.isAvailable) {
                    // This should ideally be caught earlier in the frontend or order creation
                    return res.status(400).json({ message: `Item ${item.name || item.productId} is not available.` });
                }
                itemDetails.push({
                    itemId: product._id,
                    name: product.name,
                    price: product.price,
                    quantity: item.quantity,
                });
            }

            const newOrder = new Order({
                customOrderId: customOrderId,
                pinId: pinId,
                items: itemDetails,
                customerName: orderData.customerName,
                customerPhone: orderData.customerPhone.trim(), // Ensure phone is trimmed
                deliveryAddress: orderData.deliveryAddress,
                customerLocation: orderData.customerLocation,
                subtotal: orderData.subtotal,
                transportTax: orderData.transportTax,
                totalAmount: orderData.totalAmount,
                paymentMethod: 'Online Payment', // Explicitly set as Online Payment
                status: 'Confirmed', // Mark as confirmed after successful payment
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id,
            });

            await newOrder.save();

            await Customer.findOneAndUpdate(
                { customerPhone: orderData.customerPhone.trim() },
                {
                    $set: {
                        customerName: orderData.customerName,
                        lastKnownLocation: orderData.customerLocation,
                        lastOrderDate: new Date()
                    },
                    $inc: { totalOrders: 1 }
                },
                { upsert: true, new: true }
            );

            if (whatsappReady) {
                const customerChatId = orderData.customerPhone.includes('@c.us') ? orderData.customerPhone : orderData.customerPhone + '@c.us';
                await client.sendMessage(customerChatId, `Your order (ID: ${newOrder.customOrderId}, PIN: ${newOrder.pinId}) has been placed successfully via online payment! We will notify you of its status updates. You can also view your orders by typing "My Orders" or by sending your PIN: ${newOrder.pinId}.`);
            }
            io.emit('new_order', newOrder); // Emit to admin dashboard

            res.status(200).json({ message: 'Payment verified and order placed successfully!', orderId: newOrder.customOrderId, pinId: newOrder.pinId });

        } catch (dbError) {
            console.error('Error saving order after Razorpay verification:', dbError);
            res.status(500).json({ message: 'Payment verified but failed to save order. Please contact support.', error: dbError.message });
        }
    } else {
        console.warn('Razorpay signature mismatch for order:', razorpay_order_id);
        res.status(400).json({ message: 'Payment verification failed: Invalid signature.' });
    }
});


app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount, paymentMethod } = req.body;

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        const cleanedCustomerPhone = customerPhone.trim();
        if (typeof cleanedCustomerPhone !== 'string' || cleanedCustomerPhone === '') {
            console.error('Invalid customerPhone received for order:', customerPhone);
            return res.status(400).json({ message: 'Invalid phone number provided for customer.' });
        }

        const itemDetails = [];
        for (const item of items) {
            const product = await Item.findById(item.productId);
            if (!product || !product.isAvailable) {
                return res.status(400).json({ message: `Item ${item.name || item.productId} is not available.` });
            }
            itemDetails.push({
                itemId: product._id,
                name: product.name,
                price: product.price,
                quantity: item.quantity,
            });
        }

        // Generate custom order ID and PIN ID for COD orders
        const customOrderId = generateCustomOrderId();
        const pinId = await generateUniquePinId();

        const newOrder = new Order({
            customOrderId: customOrderId,
            pinId: pinId,
            items: itemDetails,
            customerName,
            customerPhone: cleanedCustomerPhone,
            deliveryAddress,
            customerLocation,
            subtotal,
            transportTax,
            totalAmount,
            paymentMethod,
            status: 'Pending', // COD orders start as Pending
        });

        await newOrder.save();

        await Customer.findOneAndUpdate(
            { customerPhone: cleanedCustomerPhone },
            {
                $set: {
                    customerName: customerName,
                    lastKnownLocation: customerLocation,
                    lastOrderDate: new Date()
                },
                $inc: { totalOrders: 1 }
            },
            { upsert: true, new: true }
        );

        if (whatsappReady) {
            io.emit('new_order', newOrder);
            // Ensure customerPhone is in the correct format for whatsapp-web.js
            const customerChatId = cleanedCustomerPhone.includes('@c.us') ? cleanedCustomerPhone : cleanedCustomerPhone + '@c.us';
            await client.sendMessage(customerChatId, `Your order (ID: ${newOrder.customOrderId}, PIN: ${newOrder.pinId}) has been placed successfully via the web menu! We will notify you of its status updates. You can also view your orders by typing "My Orders" or by sending your PIN: ${newOrder.pinId}.`);
        }

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder.customOrderId, pinId: newOrder.pinId, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        if (err.code === 11000 && err.keyPattern && err.keyPattern.customerPhone) {
            res.status(409).json({ message: 'A customer with this phone number already exists or an internal data issue occurred. Please try again with a valid phone number.' });
        } else {
            res.status(500).json({ message: 'Failed to place order due to a server error.' });
        }
    }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const queryId = req.params.id;
        let order;

        // Try to find by customOrderId, then by pinId, then by MongoDB _id
        if (queryId.startsWith('JAR')) {
            order = await Order.findOne({ customOrderId: queryId });
        }
        if (!order && queryId.length === 10 && !isNaN(queryId)) { // Check if it looks like a PIN
            order = await Order.findOne({ pinId: queryId });
        }
        if (!order && mongoose.Types.ObjectId.isValid(queryId)) { // Fallback to MongoDB _id
            order = await Order.findById(queryId);
        }

        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json(order);
    } catch (err) {
        console.error('Error fetching order status:', err);
        res.status(500).json({ message: 'Failed to fetch order status.' });
    }
});

app.post('/api/public/request-qr', async (req, res) => {
    // This endpoint should always force a new QR generation if the client is not ready.
    // If it's already ready, we should prevent requesting a new QR.
    if (whatsappReady) {
        return res.status(400).json({ message: 'WhatsApp client is already connected. No new QR needed.' });
    }
    console.log('[API] Public QR request received. Forcing new session initialization.');
    isInitializing = false; // Allow the call to proceed
    initializeWhatsappClient(true); // Force a new session to get a new QR
    res.status(200).json({ message: 'Requesting new QR code. Check status page.' });
});


// --- URL Rewriting / Redirection for .html files ---
app.get('/admin/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/admin_dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/admin/login.html', (req, res) => res.redirect(301, '/admin/login'));
app.get('/menu.html', (req, res) => res.redirect(301, '/menu'));
app.get('/bot_status.html', (req, res) => res.redirect(301, '/status'));


// --- HTML Page Routes (Explicitly serve HTML files with new paths) ---
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.get('/dashboard', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/track', (req, res) => {
    const orderId = req.query.orderId;
    if (orderId) {
        res.redirect(`/menu?orderId=${orderId}`);
    } else {
        res.redirect('/menu');
    }
});

app.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'status.html'));
});


// --- Serve other static assets (CSS, JS, images) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Catch-all for undefined routes ---
app.use((req, res) => {
    console.log(`Unhandled route: ${req.method} ${req.originalUrl}. Redirecting to /status.`);
    res.redirect('/status');
});


// --- Initial Admin User Setup on Server Startup ---
async function ensureDefaultAdminExists() {
    try {
        let admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
            admin = new Admin({
                username: DEFAULT_ADMIN_USERNAME,
                password: hashedPassword,
                totpSecret: null
            });
            await admin.save();
            console.log(`Default admin user '${DEFAULT_ADMIN_USERNAME}' created with 2FA disabled.`);
        } else {
            console.log(`Default admin user '${DEFAULT_ADMIN_USERNAME}' already exists.`);
        }
    } catch (error) {
        console.error('Error ensuring default admin exists:', error);
    }
}

mongoose.connection.on('connected', () => {
    ensureDefaultAdminExists();
});


// Socket.io for real-time updates
io.on('connection', (socket) => {
    console.log('Admin dashboard connected via Socket.io');
    Settings.findOne({}).then(settings => {
        if (settings) {
            socket.emit('status', settings.whatsappStatus);
            socket.emit('sessionInfo', { lastAuthenticatedAt: settings.lastAuthenticatedAt });
            if (qrCodeData) { // If QR is already available, send it to newly connected client
                socket.emit('qrCode', qrCodeData);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Admin dashboard disconnected from Socket.io');
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Login: http://localhost:${PORT}/admin/login`);
    console.log(`Admin Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`Public Menu: http://localhost:${PORT}/menu`);
    console.log(`Bot Status: http://localhost:${PORT}/status`);
    console.log(`Default Admin Username (for initial setup): ${DEFAULT_ADMIN_USERNAME}`);
    console.log(`Default Admin Password (for initial setup): ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('REMEMBER TO ENABLE 2FA FROM THE DASHBOARD AFTER FIRST LOGIN FOR SECURITY.');
});

