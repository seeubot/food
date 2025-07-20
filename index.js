const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone'); // For time zone handling
const cron = require('node-cron'); // Import node-cron
const speakeasy = require('speakeasy'); // Import speakeasy for TOTP

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware for parsing JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT Secret (ensure this is in your .env file in production)
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey'; // Fallback for safety, but should be set in .env

// --- WARNING: HARDCODED ADMIN CREDENTIALS ---
// This is for testing purposes ONLY as per user request.
// NEVER use hardcoded credentials in a production environment.
// For production, use the /admin/create-initial-admin endpoint and store credentials securely.
const DEFAULT_ADMIN_USERNAME = 'dashboard_admin'; // Changed username for clarity
const DEFAULT_ADMIN_PASSWORD = 'password123';
// --- END WARNING ---

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, // This is a deprecated option, but keeping it for compatibility if needed.
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas (unchanged)
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
    orderDate: { type: Date, default: Date.now },
    status: { type: String, default: 'Pending', enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'] },
    paymentMethod: { type: String, default: 'Cash on Delivery', enum: ['Cash on Delivery', 'Online Payment'] },
    deliveryAddress: String,
    lastMessageTimestamp: { type: Date, default: Date.now }
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

// WhatsApp Client Initialization
let client = null;
let whatsappReady = false;
let qrCodeData = null;
let qrExpiryTimer = null;
let qrGeneratedTimestamp = null;

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

const initializeWhatsappClient = async (forceNewSession = false, retryCount = 0) => {
    console.log(`Initializing WhatsApp client (Force new session: ${forceNewSession ? 'Yes' : 'No'})... Attempt ${retryCount + 1}/${MAX_RETRIES}`);

    // If a client instance exists and is ready, and we are not forcing a new session, do nothing.
    if (client && whatsappReady && !forceNewSession) {
        console.log('Client already ready and not forcing new session. Skipping initialization.');
        return;
    }

    // If a client instance exists but is not ready, or we are forcing a new session, destroy it.
    if (client && (forceNewSession || !whatsappReady)) {
        try {
            console.log('Destroying previous client instance before re-initialization...');
            await client.destroy();
            console.log('Previous client destroyed successfully.');
            client = null;
        } catch (e) {
            console.error('Error destroying old client:', e);
            client = null; // Ensure client is null even if destroy fails
        }
    }

    // If client is still null, create a new one
    if (!client) {
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'admin',
                dataPath: path.join(__dirname, '.wwebjs_auth') // This path must be persistent
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

        // Attach event listeners only once when the client is created
        client.on('qr', async (qr) => {
            console.log('QR RECEIVED');
            qrCodeData = await qrcode.toDataURL(qr);
            qrGeneratedTimestamp = Date.now();
            io.emit('qrCode', qrCodeData); // Emit QR code immediately for faster display
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_received', lastAuthenticatedAt: null }, { upsert: true });
            io.emit('status', 'qr_received');

            if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
            qrExpiryTimer = setTimeout(async () => {
                if (whatsappReady === false && qrCodeData !== null) {
                    console.log('QR code expired. Reinitializing...');
                    qrCodeData = null;
                    io.emit('qrCode', null);
                    await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
                    io.emit('status', 'qr_error');
                    initializeWhatsappClient(true); // Force a new session
                }
            }, 60000); // 60 seconds expiry
        });

        client.on('authenticated', async (session) => {
            console.log('AUTHENTICATED');
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'authenticated', lastAuthenticatedAt: new Date() }, { upsert: true });
            io.emit('status', 'authenticated');
            io.emit('sessionInfo', { lastAuthenticatedAt: new Date() });
            qrCodeData = null;
            io.emit('qrCode', null);
            if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        });

        client.on('ready', async () => {
            console.log('Client is ready!');
            whatsappReady = true;
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'ready' }, { upsert: true });
            io.emit('status', 'ready');
            io.emit('sessionInfo', { lastAuthenticatedAt: (await Settings.findOne({})).lastAuthenticatedAt });
        });

        client.on('auth_failure', async msg => {
            console.error('AUTHENTICATION FAILURE', msg);
            whatsappReady = false;
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
            io.emit('status', 'auth_failure');
            qrCodeData = null;
            io.emit('qrCode', null);
            if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
            console.log('Reinitializing client due to auth_failure...');
            initializeWhatsappClient(true); // Force a new session after auth failure
        });

        client.on('disconnected', async (reason) => {
            console.log('Client was disconnected', reason);
            whatsappReady = false;
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
            io.emit('status', 'disconnected');
            qrCodeData = null;
            io.emit('qrCode', null);
            if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
            // Only reinitialize if it's a critical disconnection reason
            if (reason === 'PRIMARY_UNAVAILABLE' || reason === 'UNLAUNCHED' || reason === 'UNEXPECTED_LOGOUT') {
                 console.log('Reinitializing client due to critical disconnection...');
                 initializeWhatsappClient(true); // Force a new session
            } else {
                console.log('Client disconnected for non-critical reason. Not forcing re-initialization immediately.');
            }
        });

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
                    const pendingOrderOp = await Order.findOneAndUpdate(
                        { customerPhone: customerPhone, status: 'Pending' },
                        { $set: { paymentMethod: 'Online Payment' } },
                        { new: true, sort: { orderDate: -1 } }
                    );
                    if (pendingOrderOp) {
                        await client.sendMessage(chatId, 'Thank you for choosing online payment. A payment link will be sent to you shortly. Your Order ID: ' + pendingOrderOp._id.substring(0,6) + '...');
                        io.emit('new_order', pendingOrderOp);
                    } else {
                        await client.sendMessage(chatId, 'You have no pending orders. Please place an order first.');
                    }
                    break;
                default:
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
    }

    try {
        await client.initialize();
        console.log('WhatsApp client initialized successfully.');
    } catch (err) {
        console.error(`Client initialization error: ${err.message}`);
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            setTimeout(() => initializeWhatsappClient(forceNewSession, retryCount + 1), RETRY_DELAY_MS);
        } else {
            console.error('Max retries reached. WhatsApp client failed to initialize.');
            whatsappReady = false;
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
            io.emit('status', 'auth_failure');
            qrCodeData = null;
            io.emit('qrCode', null);
        }
    }
};

(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected') {
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    }
    initializeWhatsappClient();
})();


// --- Bot Logic Functions (unchanged) ---
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
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(5);

    if (orders.length === 0) {
        await client.sendMessage(chatId, 'You have not placed any orders yet.');
        return;
    }

    let orderListMessage = 'Your Past Orders:\n\n';
    orders.forEach((order, index) => {
        orderListMessage += `*Order ${index + 1} (ID: ${order._id.substring(0, 6)}...)*\n`;
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

// --- Fleeting Lines for Re-Order Notifications (unchanged) ---
const reOrderNotificationMessagesTelugu = [
    "Feeling hungry again? 😋 New flavors await on our menu! Order now! 🚀",
    "Missing our delicious dishes? 💖 Order your next meal now! 🍽️",
    "7 days have passed! ⏳ It's the perfect time to re-order. Your favorite dishes are ready! ✨",
    "Special offer! 🎉 Get a discount on your next order this week. Check out the menu! 📜",
    "It's been 7 days since your last order from us. Re-order your favorites! 🧡",
    "Hungry? 🤤 Order your favorite meal from Delicious Bites now! 💨",
    "Want to see what's new on our menu? 👀 Order now and try it out! 🌟",
    "Have you forgotten our taste? 😋 It's the perfect time to re-order! 🥳",
    "Thinking of ordering? 🤔 This is the right hint! Order now! 👇",
    "Your last order was great, right? 😉 Get that experience again! 💯"
];

// --- Scheduled Notification Function (unchanged) ---
const sendReorderNotification = async () => {
    if (!whatsappReady) {
        console.log('WhatsApp client not ready for scheduled notifications. Skipping job.');
        return;
    }

    console.log('Running 7-day re-order notification job...');
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

        console.log(`Found ${customersToNotify.length} customers to notify.`);

        for (const customer of customersToNotify) {
            const chatId = customer.customerPhone + '@c.us';
            const randomIndex = Math.floor(Math.random() * reOrderNotificationMessagesTelugu.length);
            const message = reOrderNotificationMessagesTelugu[randomIndex];

            try {
                const notificationMessage = `${message}\n\nVisit our web menu to order: ${process.env.WEB_MENU_URL}`;
                await client.sendMessage(chatId, notificationMessage);
                await Customer.findByIdAndUpdate(customer._id, { lastNotificationSent: new Date() });
                console.log(`Sent re-order notification to ${customer.customerPhone}`);
            } catch (msgSendError) {
                console.error(`Failed to send re-order notification to ${customer.customerPhone}:`, msgSendError);
            }
        }
        console.log('7-day re-order notification job finished.');

    } catch (dbError) {
        console.error('Error in 7-day re-order notification job (DB query):', dbError);
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
    const { totpCode } = req.body;

    const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });

    if (!admin) {
        return res.status(500).json({ message: 'Admin user not found in database. Please restart server.' });
    }

    if (!admin.totpSecret) {
        // JWT token now expires in 7 days
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

    // JWT token now expires in 7 days
    const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, twoFactorEnabled: true });
});

app.get('/admin/logout', (req, res) => {
    res.send('Logged out successfully');
});

// Authentication Middleware for Admin APIs (unchanged)
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
            return res.status(403).json({ message: 'Forbidden: Invalid token.' });
        }
        req.user = user;
        next();
    });
};

// --- 2FA Specific Endpoints (unchanged, operate on DEFAULT_ADMIN_USERNAME) ---
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
        admin.totpSecret = secret.base32;
        await admin.save();
        console.log(`New TOTP secret generated and saved for admin: ${admin.username}`);

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
    const { totpCode } = req.body;
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin || !admin.totpSecret) {
            return res.status(400).json({ message: '2FA not set up for this user.' });
        }

        const verified = speakeasy.totp.verify({
            secret: admin.totpSecret,
            encoding: 'base32',
            token: totpCode,
            window: 1
        });

        if (verified) {
            res.json({ verified: true, message: '2FA code verified successfully.' });
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

// --- Other Admin API Endpoints (unchanged, still require authentication) ---
app.get('/api/admin/bot-status', authenticateToken, async (req, res) => {
    const settings = await Settings.findOne({});
    res.json({
        status: settings ? settings.whatsappStatus : 'disconnected',
        lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null,
        qrCodeAvailable: qrCodeData !== null
    });
});

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    if (client && (whatsappReady || qrCodeData)) {
         return res.status(400).json({ message: 'WhatsApp client is already connected or QR is active. Please restart if new session is needed.' });
    }
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient(true);
    res.status(200).json({ message: 'Attempting to load saved session.' });
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
            await client.sendMessage(updatedOrder.customerPhone + '@c.us', `Your order (ID: ${updatedOrder._id.substring(0, 6)}...) status has been updated to '${status}'.`);
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

app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount, paymentMethod } = req.body;

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        // --- IMPORTANT FIX FOR DUPLICATE KEY ERROR ---
        // Ensure customerPhone is a non-empty string before using it in a unique index query
        if (typeof customerPhone !== 'string' || customerPhone.trim() === '') {
            console.error('Invalid customerPhone received for order:', customerPhone);
            return res.status(400).json({ message: 'Invalid phone number provided for customer.' });
        }
        const cleanedCustomerPhone = customerPhone.trim();
        // --- END FIX ---

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

        const newOrder = new Order({
            items: itemDetails,
            customerName,
            customerPhone: cleanedCustomerPhone, // Use cleaned phone number here
            deliveryAddress,
            customerLocation,
            subtotal,
            transportTax,
            totalAmount,
            paymentMethod,
            status: 'Pending',
        });

        await newOrder.save();

        await Customer.findOneAndUpdate(
            { customerPhone: cleanedCustomerPhone }, // Use cleaned phone number here
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
            await client.sendMessage(cleanedCustomerPhone + '@c.us', `Your order (ID: ${newOrder._id.substring(0, 6)}...) has been placed successfully via the web menu! We will notify you of its status updates. You can also view your orders by typing "My Orders".`);
        }

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder._id, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        // Check for duplicate key error specifically and provide a more user-friendly message
        if (err.code === 11000 && err.keyPattern && err.keyPattern.customerPhone) {
            res.status(409).json({ message: 'A customer with this phone number already exists or an internal data issue occurred. Please try again with a valid phone number.' });
        } else {
            res.status(500).json({ message: 'Failed to place order due to a server error.' });
        }
    }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
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
    if (client && (whatsappReady || qrCodeData)) {
        return res.status(400).json({ message: 'WhatsApp client is already connected or QR is active. Please restart if new QR is needed.' });
    }
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient(true); // Force a new session to get a new QR
    res.status(200).json({ message: 'Requesting new QR code. Check dashboard.' });
});


// --- URL Rewriting / Redirection for .html files ---
// Redirect old .html paths to new clean paths
app.get('/admin/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/admin_dashboard.html', (req, res) => res.redirect(301, '/dashboard')); // Handle old name
app.get('/admin/login.html', (req, res) => res.redirect(301, '/admin/login'));
app.get('/menu.html', (req, res) => res.redirect(301, '/menu'));
app.get('/bot_status.html', (req, res) => res.redirect(301, '/status')); // Redirect to new status path


// --- HTML Page Routes (Explicitly serve HTML files with new paths) ---
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.get('/dashboard', authenticateToken, (req, res) => { // New path for dashboard
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); // Serve renamed file
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/track', (req, res) => {
    const orderId = req.query.orderId;
    if (orderId) {
        res.redirect(`/menu?orderId=${orderId}`); // Still redirects to menu with orderId
    } else {
        res.redirect('/menu');
    }
});

app.get('/status', (req, res) => { // New path for bot status
    res.sendFile(path.join(__dirname, 'public', 'status.html')); // Serve renamed file
});

app.get('/', (req, res) => { // Root path now serves status.html
    res.sendFile(path.join(__dirname, 'public', 'status.html'));
});


// --- Serve other static assets (CSS, JS, images) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Catch-all for undefined routes ---
// This should be the last middleware
app.use((req, res) => {
    console.log(`Unhandled route: ${req.method} ${req.originalUrl}. Redirecting to /status.`);
    res.redirect('/status');
});


// --- Initial Admin User Setup on Server Startup (unchanged logic) ---
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


// Socket.io for real-time updates (unchanged)
io.on('connection', (socket) => {
    console.log('Admin dashboard connected');
    Settings.findOne({}).then(settings => {
        if (settings) {
            socket.emit('status', settings.whatsappStatus);
            socket.emit('sessionInfo', { lastAuthenticatedAt: settings.lastAuthenticatedAt });
        }
    });

    socket.on('disconnect', () => {
        console.log('Admin dashboard disconnected');
    });
});

// Start the server (console logs updated)
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

