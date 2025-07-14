// server.js

// --- 1. Import necessary modules ---
const express = require('express');
const mongoose = require('mongoose');
// dotenv is no longer needed as variables are hardcoded
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// WhatsApp Web.js imports
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); // For displaying QR in console
const fs = require('fs'); // For file system operations (QR image storage)

// --- 2. Initialize Express App and Hardcoded Environment Variables ---
const app = express();

// --- HARDCODED ENVIRONMENT VARIABLES ---
// !! WARNING: Hardcoding sensitive information is NOT recommended for production !!
// !! It poses security risks and makes configuration management difficult.    !!
const PORT = 3000;
const JWT_SECRET = 'supersecretkeythatshouldberandomandlong'; // **IMPORTANT**: Change this to a strong, random secret in production
const MONGODB_URI = "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const WHATSAPP_SESSION_PATH = './whatsapp_sessions';
const APP_BASE_URL = `https://jolly-phebe-seeutech-5259d95c.koyeb.app`; // UPDATED: Your Koyeb app URL
// --- END HARDCODED ENVIRONMENT VARIABLES ---


// Log loaded environment variables for debugging
console.log('--- Environment Variables Status (Hardcoded) ---');
console.log('MONGODB_URI:', MONGODB_URI ? 'Loaded' : 'NOT LOADED');
console.log('PORT:', PORT);
console.log('JWT_SECRET:', JWT_SECRET ? 'Loaded' : 'NOT LOADED');
console.log('WHATSAPP_SESSION_PATH:', WHATSAPP_SESSION_PATH);
console.log('APP_BASE_URL:', APP_BASE_URL);
console.log('------------------------------------');


// --- 3. Middleware Setup ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors()); // Allow all CORS for development, restrict in production
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

// --- 4. MongoDB Connection ---
// No robust check for MONGODB_URI needed as it's hardcoded now

mongoose.connect(MONGODB_URI)
    .then(() => {
        console.log('MongoDB connected successfully!');
        createDefaultAdmin(); // Optional: Create a default admin user if none exists
    })
    .catch(err => {
        console.error('MongoDB connection error details:', err.message); // Log the specific error message
        console.error('Full MongoDB connection error object:', err); // Log the full error object for more context
        process.exit(1); // Exit process if DB connection fails
    });

// Function to create a default admin user if not exists
async function createDefaultAdmin() {
    try {
        const adminCount = await Admin.countDocuments();
        if (adminCount === 0) {
            const hashedPassword = await bcrypt.hash('password', 10); // Hash 'password'
            const defaultAdmin = new Admin({
                username: 'admin',
                password: hashedPassword,
                role: 'admin'
            });
            await defaultAdmin.save();
            console.log('Default admin user created: admin/password');
        }
    } catch (error) {
        console.error('Error creating default admin:', error);
    }
}

// --- 5. Define Mongoose Schemas and Models ---

const userSchema = new mongoose.Schema({
    whatsappId: { type: String, required: true, unique: true },
    name: { type: String, default: 'Guest' },
    phone: { type: String, unique: true, sparse: true },
    address: String,
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const menuItemSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    description: String,
    price: { type: Number, required: true },
    originalPrice: Number,
    imageUrl: String,
    category: String,
    inStock: { type: Boolean, default: true },
    isNewlyAdded: { type: Boolean, default: false }, // Renamed from isNew to avoid Mongoose warning
    isTrending: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});
const MenuItem = mongoose.model('MenuItem', menuItemSchema);

const orderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
        {
            menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
            name: String,
            quantity: { type: Number, required: true },
            price: Number
        }
    ],
    totalAmount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'],
        default: 'pending'
    },
    orderDate: { type: Date, default: Date.now },
    deliveryAddress: String
});
const Order = mongoose.model('Order', orderSchema);

const adminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['admin', 'manager'], default: 'admin' },
    createdAt: { type: Date, default: Date.now }
});
const Admin = mongoose.model('Admin', adminSchema);

// --- 6. Authentication Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- 7. Define Express API Routes ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Health check endpoint for deployment platforms
app.get('/health', (req, res) => {
    // You can add more checks here, e.g., database connection status
    res.status(200).json({ status: 'ok', database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', whatsappBot: whatsappClientStatus });
});

app.get('/api/menu', async (req, res) => {
    try {
        const menuItems = await MenuItem.find({});
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu items:', error);
        res.status(500).json({ message: 'Server error fetching menu items.' });
    }
});

app.post('/api/orders', async (req, res) => {
    try {
        const { userId, items, totalAmount, deliveryAddress } = req.body;

        if (!userId || !items || items.length === 0 || !totalAmount) {
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        let user = await User.findById(userId);
        if (!user) {
            user = await User.findOneAndUpdate(
                { whatsappId: `dummy_whatsapp_${userId}` },
                { name: `Dummy User ${userId.substring(0, 5)}`, phone: `+1${Math.floor(Math.random() * 10000000000)}` },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            console.warn(`Dummy user created for order: ${user.whatsappId}`);
        }

        const newOrder = new Order({
            userId: user._id,
            items,
            totalAmount,
            deliveryAddress
        });

        await newOrder.save();

        console.log('New order placed:', newOrder);
        // TODO: Notify admin about new order (e.g., via WebSocket)
        // Send order confirmation to user via WhatsApp Web.js
        const userWhatsappId = user.whatsappId; // Assuming whatsappId is a valid phone number with country code
        const orderConfirmationMessage = `Your order (ID: ${newOrder._id.toString().substring(0, 8)}) has been placed successfully! Total: $${newOrder.totalAmount.toFixed(2)}. We'll notify you of updates.`;
        sendWhatsAppMessage(userWhatsappId, orderConfirmationMessage);

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder._id });
    } catch (error) {
        console.error('Error placing order:', error);
        res.status(500).json({ message: 'Server error placing order.' });
    }
});

// --- 8. Admin Dashboard API Routes (Protected by Authentication) ---

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const admin = await Admin.findOne({ username });
        if (!admin) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { id: admin._id, username: admin.username, role: admin.role },
            JWT_SECRET,
            { expiresIn: '1h' }
        );

        res.status(200).json({ message: 'Login successful!', token });
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ message: 'Server error during admin login.' });
    }
});

app.post('/api/admin/menu', authenticateToken, async (req, res) => {
    try {
        const newMenuItem = new MenuItem(req.body);
        await newMenuItem.save();
        res.status(201).json({ message: 'Menu item added successfully!', item: newMenuItem });
    } catch (error) {
        console.error('Error adding menu item:', error);
        res.status(500).json({ message: 'Server error adding menu item.' });
    }
});

app.put('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const updatedItem = await MenuItem.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
        if (!updatedItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item updated successfully!', item: updatedItem });
    } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(500).json({ message: 'Server error updating menu item.' });
    }
});

app.delete('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const deletedItem = await MenuItem.findByIdAndDelete(id);
        if (!deletedItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item deleted successfully!' });
    } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).json({ message: 'Server error deleting menu item.' });
    }
});

app.get('/api/admin/orders', authenticateToken, async (req, res) => {
    try {
        const orders = await Order.find({}).populate('userId', 'name whatsappId phone').sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Server error fetching orders.' });
    }
});

app.put('/api/admin/orders/:id/status', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'].includes(status)) {
            return res.status(400).json({ message: 'Invalid order status.' });
        }

        const updatedOrder = await Order.findByIdAndUpdate(id, { status }, { new: true });
        if (!updatedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        // Notify user on WhatsApp about order status update
        const user = await User.findById(updatedOrder.userId);
        if (user && user.whatsappId) {
            const statusMessage = `Your order (ID: ${updatedOrder._id.toString().substring(0, 8)}) status has been updated to: *${status.replace(/_/g, ' ').toUpperCase()}*.`;
            sendWhatsAppMessage(user.whatsappId, statusMessage);
        }
        res.json({ message: 'Order status updated successfully!', order: updatedOrder });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ message: 'Server error updating order status.' });
    }
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
    try {
        const users = await User.find({});
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error fetching users.' });
    }
});

// --- 9. WhatsApp Web.js Integration ---

let qrCodeData = null; // To store QR code as base64 for web display
let whatsappClientStatus = 'disconnected'; // 'disconnected', 'connecting', 'ready', 'qr_available', 'authenticated', 'auth_failure'

// Ensure session directory exists
if (!fs.existsSync(WHATSAPP_SESSION_PATH)) {
    fs.mkdirSync(WHATSAPP_SESSION_PATH);
    console.log(`Created WhatsApp session directory: ${WHATSAPP_SESSION_PATH}`);
}

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'whatsapp-bot', // Unique ID for your session
        dataPath: WHATSAPP_SESSION_PATH
    }),
    puppeteer: {
        headless: true, // Run in headless mode (no browser UI)
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // This helps with memory usage on some platforms
            '--disable-gpu',
            '--incognito' // Ensures a clean session start for puppeteer
        ],
        // Optional: specify executable path if chromium is not found automatically
        // executablePath: '/usr/bin/google-chrome' // Example for Linux, adjust as needed
    }
});

client.on('qr', (qr) => {
    // Generate and scan this code with your phone
    qrcode.generate(qr, { small: true });
    console.log('QR RECEIVED:', qr);
    qrCodeData = qr; // Store QR data for web display
    whatsappClientStatus = 'qr_available';
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    qrCodeData = null; // Clear QR data once connected
    whatsappClientStatus = 'ready';
});

client.on('authenticated', () => {
    console.log('WhatsApp Client Authenticated!');
    whatsappClientStatus = 'authenticated';
});

client.on('auth_failure', msg => {
    // Fired if session restore fails
    console.error('AUTHENTICATION FAILURE:', msg);
    whatsappClientStatus = 'auth_failure';
    // Consider deleting session files here if auth_failure is persistent
    // fs.readdirSync(WHATSAPP_SESSION_PATH).forEach(file => fs.unlinkSync(path.join(WHATSAPP_SESSION_PATH, file)));
    // client.initialize(); // Re-initialize after clearing session
});

client.on('disconnected', (reason) => {
    console.log('WhatsApp Client was disconnected:', reason);
    whatsappClientStatus = 'disconnected';
    // Attempt to re-initialize or prompt for re-scan
    // For production, you might want a more robust re-initialization strategy with delays/retries
    // client.initialize();
});

// Main message handler for the bot
client.on('message', async msg => {
    console.log('MESSAGE RECEIVED:', msg.body);

    // Filter out messages from groups or status updates if you only want direct chats
    if (msg.isGroupMsg || msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) {
        return; // Ignore group messages and broadcasts
    }

    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const userName = contact.pushname || contact.name || 'Customer'; // Get contact name

    // Ensure the user exists in our DB or create them
    let user = await User.findOneAndUpdate(
        { whatsappId: msg.from }, // Use msg.from as whatsappId
        { name: userName, phone: msg.from },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    let replyMessage = "Sorry, I didn't understand that. Type 'menu' to see our food options!";

    const lowerCaseBody = msg.body.toLowerCase();

    if (lowerCaseBody.includes('hi') || lowerCaseBody.includes('hello') || lowerCaseBody === 'start') {
        replyMessage = `Hello ${userName}! Welcome to our food service. Here's our delicious menu: ${APP_BASE_URL}`;
    } else if (lowerCaseBody.includes('menu')) {
        replyMessage = `Here's our menu: ${APP_BASE_URL}`;
    } else if (lowerCaseBody.includes('order status') || lowerCaseBody.includes('my order')) {
        const latestOrder = await Order.findOne({ userId: user._id }).sort({ orderDate: -1 });
        if (latestOrder) {
            replyMessage = `Your latest order (ID: ${latestOrder._id.toString().substring(0, 8)}) is currently: *${latestOrder.status.replace(/_/g, ' ').toUpperCase()}*. Total: $${latestOrder.totalAmount.toFixed(2)}.`;
        } else {
            replyMessage = "You haven't placed any orders yet. Check out our menu!";
        }
    } else if (lowerCaseBody.includes('help')) {
        replyMessage = "I can help you with:\n- Type 'menu' to see our food options.\n- Type 'order status' to check your latest order.\n- For anything else, please contact our support.";
    }
    // Add more complex bot logic here based on user input

    // Send the reply
    try {
        await msg.reply(replyMessage);
        console.log(`Sent reply to ${msg.from}: ${replyMessage}`);
    } catch (error) {
        console.error(`Error sending reply to ${msg.from}:`, error);
    }
});

// Initialize the WhatsApp client
client.initialize();
console.log('WhatsApp Client initialization started...');
whatsappClientStatus = 'connecting';

// Function to send WhatsApp messages from anywhere in your backend
async function sendWhatsAppMessage(to, message) {
    if (whatsappClientStatus === 'ready') {
        try {
            // WhatsApp Web.js requires the ID to be in the format 'number@c.us'
            // Ensure 'to' is a valid phone number string (e.g., '919876543210')
            const chatId = to.includes('@c.us') ? to : `${to.replace(/\+/g, '')}@c.us`;
            await client.sendMessage(chatId, message);
            console.log(`WhatsApp message sent to ${chatId}: ${message}`);
        } catch (error) {
            console.error(`ERROR: Failed to send WhatsApp message to ${to}. Reason:`, error.message);
            console.error('Ensure the WhatsApp client is "ready" and the recipient number is valid.');
        }
    } else {
        console.warn(`WARNING: WhatsApp client not ready to send message to ${to}. Current status: ${whatsappClientStatus}`);
        console.warn('Message was not sent:', message);
    }
}

// API endpoint to get WhatsApp bot status
app.get('/api/whatsapp/status', authenticateToken, (req, res) => {
    res.json({ status: whatsappClientStatus });
});

// API endpoint to get QR code for WhatsApp Web.js
app.get('/api/whatsapp/qr', authenticateToken, (req, res) => {
    if (whatsappClientStatus === 'qr_available' && qrCodeData) {
        res.json({ qr: qrCodeData, status: whatsappClientStatus });
    } else {
        res.status(200).json({ qr: null, status: whatsappClientStatus, message: 'QR code not available or client already connected.' });
    }
});

// --- 10. Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke on the server!');
});

// --- 11. Start the Server ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Web Menu: ${APP_BASE_URL}`);
    console.log(`Admin Dashboard: ${APP_BASE_URL}/dashboard`);
    console.log('WhatsApp Web.js will print QR to console or use /api/whatsapp/qr endpoint.');
});

