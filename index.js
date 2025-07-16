const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // Added MessageMedia
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
const MONGODB_URI = "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const ADMIN_NUMBER = '918897350151'; // Admin WhatsApp number for notifications (without +)
const SESSION_SECRET = process.env.SESSION_SECRET || 'supersecretkeyforfoodbot'; // CHANGE THIS IN PRODUCTION!
const SESSION_DIR_PATH = './.wwebjs_auth'; // Directory for whatsapp-web.js session files

// New: Reconnection and QR expiry settings
const RECONNECT_DELAY_MS = 5000; // 5 seconds delay before trying to re-initialize
const QR_EXPIRY_MS = 60000; // QR code considered expired after 60 seconds if not scanned
const WEEKLY_NOTIFICATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // Check for notifications every 24 hours

// Welcome Image URL
const WELCOME_IMAGE_URL = "https://i.postimg.cc/t4B8fw2d/IMG-20250525-WA0003.jpg";

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
    .then(() => console.log('MongoDB connected successfully'))
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
        let adminUser = await User.findOne({ username: 'admin' });
        if (!adminUser) {
            adminUser = new User({
                username: 'admin',
                password: 'adminpassword',
                isAdmin: true
            });
            await adminUser.save();
            console.log('Default admin user created: admin/adminpassword');
        }

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
    } catch (error) {
        console.error('Error initializing admin and settings:', error);
    }
}
initializeAdminAndSettings();

// --- WhatsApp Bot Setup ---
let qrCodeDataURL = null;
let clientReady = false;
let reconnectTimer = null; // To control re-initialization attempts
let qrExpiryTimer = null; // To track QR code validity

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
    // Clear any previous QR expiry timer
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

    qrcode.toDataURL(qr, { small: false }, (err, url) => {
        if (err) {
            console.error('Error generating QR code data URL:', err);
            qrCodeDataURL = null;
            io.emit('status', 'qr_error');
        } else {
            qrCodeDataURL = url;
            console.log('QR code generated and will be emitted to clients.');
            io.emit('qrCode', qrCodeDataURL);
            io.emit('status', 'qr_received');

            // Set a timer to expire the QR if not scanned
            qrExpiryTimer = setTimeout(() => {
                qrCodeDataURL = null;
                io.emit('qrCode', null); // Clear QR on frontend
                io.emit('status', 'qr_expired');
                console.log('QR code expired. Please restart bot or wait for new QR.');
            }, QR_EXPIRY_MS);
        }
    });
});

client.on('ready', () => {
    console.log('Client is ready!');
    clientReady = true;
    qrCodeDataURL = null; // Clear QR once ready
    if (reconnectTimer) clearTimeout(reconnectTimer); // Clear any pending reconnect
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer); // Clear QR expiry timer
    console.log('WhatsApp bot is connected and operational.');
    io.emit('status', 'ready');
    // Start weekly notification scheduler only when client is ready
    setInterval(sendWeeklyNotifications, WEEKLY_NOTIFICATION_INTERVAL_MS);
});

client.on('authenticated', (session) => {
    console.log('AUTHENTICATED', session);
    if (reconnectTimer) clearTimeout(reconnectTimer); // Clear any pending reconnect
    io.emit('status', 'authenticated');
});

client.on('auth_failure', async msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    console.log('Attempting to re-authenticate. Clearing session files...');
    clientReady = false;
    qrCodeDataURL = null;
    if (reconnectTimer) clearTimeout(reconnectTimer); // Clear any pending reconnect
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer); // Clear QR expiry timer
    io.emit('status', 'auth_failure');

    try {
        // More aggressive session file deletion
        await fs.rm(SESSION_DIR_PATH, { recursive: true, force: true });
        console.log('Deleted old session directory. Re-initializing client...');
    } catch (err) {
        console.error('Error deleting old session directory:', err);
    } finally {
        // Re-initialize after a delay
        reconnectTimer = setTimeout(() => {
            console.log(`Attempting to re-initialize client after ${RECONNECT_DELAY_MS / 1000} seconds.`);
            client.initialize();
            io.emit('status', 'reconnecting');
        }, RECONNECT_DELAY_MS);
    }
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected', reason);
    clientReady = false;
    qrCodeDataURL = null;
    if (reconnectTimer) clearTimeout(reconnectTimer); // Clear any pending reconnect
    if (qrExpiryTimer) clearTimeout(qrExpiryTimer); // Clear QR expiry timer
    io.emit('status', 'disconnected');
    console.log(`Attempting to re-initialize after ${RECONNECT_DELAY_MS / 1000} seconds...`);
    // Re-initialize after a delay
    reconnectTimer = setTimeout(() => {
        client.initialize();
        io.emit('status', 'reconnecting');
    }, RECONNECT_DELAY_MS);
});

// Initial client initialization
console.log('Initializing WhatsApp client...');
io.on('connection', (socket) => {
    console.log('A user connected to Socket.IO');
    // Emit current status and QR code to newly connected clients
    if (clientReady) {
        socket.emit('status', 'ready');
    } else if (qrCodeDataURL) {
        socket.emit('status', 'qr_received');
        socket.emit('qrCode', qrCodeDataURL);
    } else {
        socket.emit('status', 'initializing');
    }
});
client.initialize();

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
    console.log('MESSAGE RECEIVED from:', msg.from, 'Body:', msg.body);

    const senderNumber = msg.from.split('@')[0];
    const baseUrl = process.env.NODE_ENV === 'production' ? 'YOUR_KOYEB_URL' : 'http://localhost:8080'; // Replace YOUR_KOYEB_URL in production

    // Update customer notification date on any message received
    await updateCustomerNotification(senderNumber);

    // Basic bot functionalities
    if (msg.body === '!welcome') {
        const welcomeMessage = `Hello! Welcome to our food business!
            \nCheck out our delicious menu here: ${baseUrl}/menu
            \nHow can I help you today?
            \nHere are some options you can try:
            1. Type *!profile* to view your profile details.
            2. Type *!orders* to see your recent orders.
            3. Type *!help* for assistance.`;

        try {
            // Create a MessageMedia object from the URL
            const media = await MessageMedia.fromUrl(WELCOME_IMAGE_URL);
            // Send the image with the welcome message as a caption
            await client.sendMessage(msg.from, media, { caption: welcomeMessage });
            console.log('Welcome image and message sent.');
        } catch (error) {
            console.error('Error sending welcome image:', error);
            // Fallback to sending just the text message if image fails
            msg.reply(welcomeMessage);
        }
    } else if (msg.body === '!menu') {
        const menuUrl = `${baseUrl}/menu`;
        msg.reply(`Check out our delicious menu here: ${menuUrl}`);
    } else if (msg.body === '!profile') {
        msg.reply('Your profile details would be displayed here. (Feature under development)');
    } else if (msg.body === '!orders') {
        try {
            const customerOrders = await Order.find({ customerPhone: senderNumber }).sort({ orderDate: -1 }).limit(5);
            if (customerOrders.length > 0) {
                let orderList = 'Your recent orders:\n';
                customerOrders.forEach((order, index) => {
                    orderList += `${index + 1}. Order ID: ${order._id.toString().substring(0, 6)}... - Total: ₹${order.totalAmount.toFixed(2)} - Status: ${order.status}\n`;
                });
                msg.reply(orderList + '\nFor more details, visit the web menu or contact support.');
            } else {
                msg.reply('You have no recent orders. Why not place one now? Type !menu');
            }
        } catch (error) {
            console.error('Error fetching orders for bot:', error);
            msg.reply('Sorry, I could not fetch your orders at the moment. Please try again later.');
        }
    } else if (msg.body === '!help' || msg.body === '!support') {
        msg.reply('For any assistance, please contact our support team at +91-XXXX-XXXXXX or visit our website.');
    } else {
        msg.reply(`I received your message! Type *!menu* to see our offerings, or *!help* for assistance.`);
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

        const baseUrl = process.env.NODE_ENV === 'production' ? 'YOUR_KOYEB_URL' : 'http://localhost:8080'; // Replace YOUR_KOYEB_URL in production
        const menuUrl = `${baseUrl}/menu`;

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
    if (req.session.userId && req.session.isAdmin) {
        return next();
    }
    res.redirect('/admin/login');
}

// Root route for bot status and QR display
app.get('/', async (req, res) => {
    try {
        // Ensure the bot_status.html exists in the public directory
        const htmlContent = await fs.readFile(path.join(__dirname, 'public', 'bot_status.html'), 'utf8');
        res.send(htmlContent);
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
                .dark-mode { background-color: #1a202c; color: #e2e8f0; }
                .dark-mode input { background-color: #2d3748; border-color: #4a5568; color: #e2e8f0; }
                .dark-mode button { background-color: #48bb78; }
            </style>
        </head>
        <body class="bg-gray-100 dark-mode flex items-center justify-center min-h-screen">
            <div class="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-xl max-w-md w-full">
                <h2 class="text-3xl font-bold text-gray-800 dark:text-white mb-6 text-center">Admin Login</h2>
                <form action="/admin/login" method="POST" class="space-y-4">
                    <div>
                        <label for="username" class="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Username:</label>
                        <input type="text" id="username" name="username" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline dark:bg-gray-700 dark:border-gray-600 dark:text-white" required>
                    </div>
                    <div>
                        <label for="password" class="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-2">Password:</label>
                        <input type="password" id="password" name="password" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 mb-3 leading-tight focus:outline-none focus:shadow-outline dark:bg-gray-700 dark:border-gray-600 dark:text-white" required>
                    </div>
                    <button type="submit" class="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline w-full transition duration-300 ease-in-out">Login</button>
                </form>
                ${req.session.message ? `<p class="text-red-500 text-center mt-4">${req.session.message}</p>` : ''}
            </div>
            <script>
                if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                    document.body.classList.add('dark-mode');
                }
            </script>
        </body>
        </html>
    `);
    delete req.session.message;
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (user && await user.comparePassword(password)) {
            req.session.userId = user._id;
            req.session.isAdmin = user.isAdmin;
            if (user.isAdmin) {
                return res.redirect('/admin/dashboard');
            } else {
                req.session.message = 'You are not authorized to access the admin panel.';
                return res.redirect('/admin/login');
            }
        } else {
            req.session.message = 'Invalid username or password.';
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
        res.redirect('/admin/login');
    });
});

// Admin Dashboard (Protected - now serves the single-page app)
app.get('/admin/dashboard', isAuthenticated, async (req, res) => {
    try {
        const dashboardHtml = await fs.readFile(path.join(__dirname, 'public', 'admin_dashboard.html'), 'utf8');
        res.send(dashboardHtml);
    } catch (error) {
        console.error('Error serving admin_dashboard.html:', error);
        res.status(500).send('<h1>Error loading Admin Dashboard.</h1><p>Please check server logs.</p>');
    }
});

// --- API for Admin Dashboard Orders ---
app.get('/api/admin/orders', isAuthenticated, async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching admin orders:', error);
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

app.get('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (error) {
        console.error('Error fetching single order:', error);
        res.status(500).json({ message: 'Error fetching order' });
    }
});


app.put('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        // Optional: Notify customer via WhatsApp about status update
        // client.sendMessage(order.customerPhone + '@c.us', `Your order #${order._id.toString().substring(0,6)} has been updated to: ${order.status}`);
        res.json(order);
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ message: 'Error updating order status' });
    }
});

// --- API for Admin Menu Management (CRUD) ---
app.get('/api/admin/menu', isAuthenticated, async (req, res) => {
    try {
        const products = await Product.find().sort({ name: 1 });
        res.json(products);
    } catch (error) {
        console.error('Error fetching admin menu:', error);
        res.status(500).json({ message: 'Error fetching menu items' });
    }
});

app.get('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });
        res.json(product);
    } catch (error) {
        console.error('Error fetching single product:', error);
        res.status(500).json({ message: 'Error fetching product' });
    }
});

app.post('/api/admin/menu', isAuthenticated, async (req, res) => {
    try {
        const newProduct = new Product(req.body);
        await newProduct.save();
        res.status(201).json(newProduct);
    } catch (error) {
        console.error('Error adding menu item:', error);
        res.status(500).json({ message: 'Error adding menu item' });
    }
});

app.put('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const updatedProduct = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!updatedProduct) return res.status(404).json({ message: 'Product not found' });
        res.json(updatedProduct);
    } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(500).json({ message: 'Error updating menu item' });
    }
});

app.delete('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedProduct = await Product.findByIdAndDelete(req.params.id);
        if (!deletedProduct) return res.status(404).json({ message: 'Product not found' });
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).json({ message: 'Error deleting menu item' });
    }
});

// --- API for Admin Shop Settings ---
app.get('/api/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const settings = await AdminSettings.findOne();
        res.json(settings);
    } catch (error) {
        console.error('Error fetching admin settings:', error);
        res.status(500).json({ message: 'Error fetching settings' });
    }
});

app.put('/api/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const updatedSettings = await AdminSettings.findOneAndUpdate({}, req.body, { new: true, upsert: true });
        res.json(updatedSettings);
    } catch (error) {
        console.error('Error updating admin settings:', error);
        res.status(500).json({ message: 'Error updating settings' });
    }
});

// Public Web Menu Panel (Now serves menu_panel.html)
app.get('/menu', async (req, res) => {
    try {
        const menuPanelHtml = await fs.readFile(path.join(__dirname, 'public', 'menu_panel.html'), 'utf8');
        res.send(menuPanelHtml);
    } catch (error) {
        console.error('Error serving menu_panel.html:', error);
        res.status(500).send('<h1>Error loading Menu Panel.</h1><p>Please check server logs.</p>');
    }
});

// API for Public Menu
app.get('/api/menu', async (req, res) => {
    try {
        const products = await Product.find({ isAvailable: true }).sort({ category: 1, name: 1 });
        res.json(products);
    } catch (error) {
        console.error('Error fetching public menu:', error);
        res.status(500).json({ message: 'Error fetching menu items' });
    }
});

// API for Public Shop Settings (only what's needed for delivery calculation)
app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await AdminSettings.findOne({}, 'shopLocation deliveryRates shopName'); // Fetch shopName as well
        res.json(settings);
    }
    catch (error) {
        console.error('Error fetching public settings:', error);
        res.status(500).json({ message: 'Error fetching settings' });
    }
});


// API for Delivery Cost Calculation
app.post('/api/calculate-delivery-cost', async (req, res) => {
    const { customerLocation } = req.body;
    if (!customerLocation || typeof customerLocation.latitude === 'undefined' || typeof customerLocation.longitude === 'undefined') {
        return res.status(400).json({ message: 'Customer location (latitude, longitude) is required.' });
    }

    try {
        const settings = await AdminSettings.findOne();
        if (!settings || !settings.shopLocation || !settings.deliveryRates || settings.deliveryRates.length === 0) {
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
            if (i === sortedRates.length - 1) {
                transportTax = sortedRates[i].amount;
            }
        }

        res.json({ distance, transportTax });

    } catch (error) {
        console.error('Error calculating delivery cost:', error);
        res.status(500).json({ message: 'Error calculating delivery cost' });
    }
});

// API for Placing Orders
app.post('/api/order', async (req, res) => {
    const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount } = req.body;

    if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !subtotal || !totalAmount) {
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

        // Update customer notification date to reset weekly reminder timer
        await updateCustomerNotification(customerPhone);

        // Notify Admin via WhatsApp
        if (clientReady) {
            const adminMessage = `🔔 NEW ORDER PLACED! 🔔\n\n` +
                                 `Order ID: ${newOrder._id.toString().substring(0, 6)}...\n` +
                                 `Customer: ${newOrder.customerName}\n` +
                                 `Phone: ${newOrder.customerPhone}\n` +
                                 `Total: ₹${newOrder.totalAmount.toFixed(2)}\n` +
                                 `Address: ${newOrder.deliveryAddress}\n\n` +
                                 `View on Dashboard: ${req.protocol}://${req.get('host')}/admin/dashboard`;
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
        console.error('Error placing order:', error);
        res.status(500).json({ message: 'Error placing order.' });
    }
});

// API for fetching a single order by ID (for tracking)
app.get('/api/order/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (error) {
        console.error('Error fetching order for tracking:', error);
        res.status(500).json({ message: 'Error fetching order details.' });
    }
});


// Start the Express server
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('Waiting for WhatsApp client to be ready...');
    console.log('Visit the root URL of your deployment to check status and scan the QR.');
    console.log(`Admin login: ${process.env.NODE_ENV === 'production' ? 'YOUR_KOYEB_URL' : 'http://localhost:8080'}/admin/login`);
    console.log(`Public menu: ${process.env.NODE_ENV === 'production' ? 'YOUR_KOYEB_URL' : 'http://localhost:8080'}/menu`);
});

