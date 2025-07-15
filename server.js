// server.js
// This is the main entry point for the Node.js backend server.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); // Required for socket.io
const socketIo = require('socket.io'); // For real-time QR code updates
const path = require('path'); // For serving static files
const bcrypt = require('bcryptjs'); // Re-introduced for authentication
const jwt = require('jsonwebtoken'); // Re-introduced for authentication
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // WhatsApp Web JS library
const qrcode = require('qrcode'); // For generating QR code images for web display
const qrcodeTerminal = require('qrcode-terminal'); // For displaying QR in terminal
const cron = require('node-cron'); // For scheduling recurring tasks

const app = express();
const server = http.createServer(app);
const io = socketIo(server); // Initialize socket.io with the HTTP server

// --- MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room"; // Default if not in .env

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Mongoose Models ---

// User Model for Dashboard Login (Re-introduced)
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
});

// Hash password before saving
UserSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

const User = mongoose.model('User', UserSchema);

// MenuItem Model with suppressReservedKeysWarning
const MenuItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: { type: String },
    price: { type: Number, required: true },
    imageUrl: { type: String, default: 'https://placehold.co/400x300/E0E0E0/333333?text=No+Image' }, // Placeholder image
    category: { type: String, default: 'General' },
    isAvailable: { type: Boolean, default: true },
    isNew: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
}, { suppressReservedKeysWarning: true });

const MenuItem = mongoose.model('MenuItem', MenuItemSchema);

// Order Model
const OrderSchema = new mongoose.Schema({
    customerId: { type: String, required: true }, // WhatsApp phone number (e.g., 919876543210@c.us)
    customerName: { type: String, default: 'Unknown' },
    items: [{
        menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, default: 1 },
    }],
    totalAmount: { type: Number, required: true },
    status: { type: String, enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'], default: 'Pending' },
    orderDate: { type: Date, default: Date.now },
});

const Order = mongoose.model('Order', OrderSchema);

// --- Middleware ---
app.use(express.json()); // For parsing JSON request bodies
app.use(express.urlencoded({ extended: true })); // For parsing URL-encoded request bodies

// --- Authentication Middleware (Re-introduced) ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) return res.status(401).json({ message: 'Access Denied: No token provided!' });

    jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key', (err, user) => {
        if (err) return res.status(403).json({ message: 'Access Denied: Invalid token!' });
        req.user = user;
        next();
    });
};

// --- WhatsApp Client State Management ---
class WhatsAppClientManager {
    constructor(clientId, clientName) {
        this.clientId = clientId;
        this.clientName = clientName;
        this.qrCodeImage = null;
        this.statusMessage = `Initializing ${clientName}...`;
        this.isReady = false;
        this.client = null;
        this.initializationAttempts = 0;
        this.maxInitializationAttempts = 3;
        this.reconnectTimeout = null;
    }

    emitStatus() {
        const eventName = this.clientId === 'whatsapp-bot-1' ? 'qr1' : 'qr2';
        io.emit(eventName, {
            image: this.qrCodeImage,
            status: this.statusMessage,
            isReady: this.isReady
        });
        console.log(`Emitted ${eventName}:`, { status: this.statusMessage, isReady: this.isReady, hasImage: !!this.qrCodeImage });
    }

    async generateQRImage(qrString) {
        try {
            // Generate QR code with better error correction and size
            const qrImage = await qrcode.toDataURL(qrString, {
                errorCorrectionLevel: 'M',
                type: 'image/png',
                quality: 0.92,
                margin: 1,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                },
                width: 300
            });
            console.log(`QR image generated successfully for ${this.clientName}`);
            return qrImage;
        } catch (error) {
            console.error(`Error generating QR image for ${this.clientName}:`, error);
            return null;
        }
    }

    async initialize() {
        if (this.initializationAttempts >= this.maxInitializationAttempts) {
            this.statusMessage = `${this.clientName} initialization failed after ${this.maxInitializationAttempts} attempts`;
            this.isReady = false;
            this.qrCodeImage = null;
            this.emitStatus();
            return;
        }

        this.initializationAttempts++;
        console.log(`Initializing ${this.clientName} (attempt ${this.initializationAttempts}/${this.maxInitializationAttempts})`);
        
        this.statusMessage = `Initializing ${this.clientName}...`;
        this.qrCodeImage = null;
        this.isReady = false;
        this.emitStatus();

        try {
            // Clean up existing client
            if (this.client) {
                try {
                    await this.client.destroy();
                } catch (destroyError) {
                    console.warn(`Error destroying existing client for ${this.clientName}:`, destroyError);
                }
            }

            // Create new client with enhanced configuration
            this.client = new Client({
                authStrategy: new LocalAuth({ 
                    clientId: this.clientId,
                    dataPath: `./.wwebjs_auth/`
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
                        '--disable-features=site-per-process',
                        '--disable-web-security',
                        '--disable-sync',
                        '--disable-infobars',
                        '--window-size=1920,1080',
                        '--ignore-certificate-errors',
                        '--incognito',
                        '--enable-features=NetworkService,NetworkServiceInProcess',
                        '--disable-site-isolation-trials',
                        '--font-render-hinting=none',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding'
                    ],
                    timeout: 60000 // 60 seconds timeout
                },
                webVersion: '2.2412.54', // Specify a stable web version
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                }
            });

            // Set up event handlers
            this.setupEventHandlers();

            // Initialize the client
            await this.client.initialize();

        } catch (error) {
            console.error(`Error initializing ${this.clientName}:`, error);
            this.statusMessage = `Initialization Error: ${error.message}`;
            this.qrCodeImage = null;
            this.isReady = false;
            this.emitStatus();
            
            // Retry after delay
            console.log(`Retrying ${this.clientName} initialization in 10 seconds...`);
            this.reconnectTimeout = setTimeout(() => this.initialize(), 10000);
        }
    }

    setupEventHandlers() {
        this.client.on('qr', async (qr) => {
            console.log(`QR received for ${this.clientName}`);
            
            // Display QR in terminal
            qrcodeTerminal.generate(qr, { small: true });
            
            // Generate QR image
            this.qrCodeImage = await this.generateQRImage(qr);
            this.statusMessage = `Scan this QR code for ${this.clientName} with your WhatsApp app`;
            this.isReady = false;
            this.emitStatus();
        });

        this.client.on('ready', () => {
            console.log(`${this.clientName} is ready!`);
            this.qrCodeImage = null;
            this.statusMessage = `${this.clientName} is ready!`;
            this.isReady = true;
            this.initializationAttempts = 0; // Reset attempts on successful connection
            this.emitStatus();
        });

        this.client.on('authenticated', () => {
            console.log(`${this.clientName} authenticated`);
            this.qrCodeImage = null;
            this.statusMessage = `${this.clientName} authenticated!`;
            this.isReady = true;
            this.emitStatus();
        });

        this.client.on('auth_failure', (msg) => {
            console.error(`Authentication failure for ${this.clientName}:`, msg);
            this.qrCodeImage = null;
            this.statusMessage = `Auth Failure: ${msg}`;
            this.isReady = false;
            this.emitStatus();
            
            // Retry authentication
            console.log(`Retrying ${this.clientName} authentication in 5 seconds...`);
            this.reconnectTimeout = setTimeout(() => this.initialize(), 5000);
        });

        this.client.on('disconnected', (reason) => {
            console.log(`${this.clientName} disconnected:`, reason);
            this.qrCodeImage = null;
            this.statusMessage = `Disconnected: ${reason}. Reconnecting...`;
            this.isReady = false;
            this.emitStatus();
            
            // Attempt to reconnect
            console.log(`Attempting to reconnect ${this.clientName} in 5 seconds...`);
            this.reconnectTimeout = setTimeout(() => this.initialize(), 5000);
        });

        this.client.on('loading_screen', (percent, message) => {
            console.log(`${this.clientName} loading:`, percent, message);
            this.statusMessage = `Loading: ${message} (${percent}%)`;
            this.emitStatus();
        });

        // Add message handler for client 1 (primary bot)
        if (this.clientId === 'whatsapp-bot-1') {
            this.client.on('message', async (msg) => {
                await this.handleMessage(msg);
            });
        } // Removed the extra '}' here
        // Add message handler for client 2 (secondary bot)
        if (this.clientId === 'whatsapp-bot-2') {
            this.client.on('message', async (msg) => {
                await this.handleMessage(msg);
            });
        }
    }

    async handleMessage(msg) {
        try {
            if (msg.body && msg.from) {
                console.log(`${this.clientName} received message from ${msg.from}: ${msg.body}`);
                
                // Basic bot response logic
                const messageBody = msg.body.toLowerCase().trim();
                
                if (messageBody === 'hello' || messageBody === 'hi' || messageBody === 'hey') {
                    await msg.reply('Hello! Welcome to our restaurant. Type "menu" to see our menu or "help" for assistance.');
                } else if (messageBody === 'menu') {
                    await this.sendMenu(msg);
                } else if (messageBody === 'help') {
                    await msg.reply('Available commands:\n- "menu" - View our menu\n- "order" - Place an order\n- "status" - Check order status\n- "contact" - Get contact information');
                } else if (messageBody === 'contact') {
                    await msg.reply('Contact us:\n📞 Phone: +1234567890\n📍 Address: 123 Restaurant St, City\n🕒 Hours: 9 AM - 10 PM');
                } else if (messageBody.startsWith('order')) {
                    await msg.reply('To place an order, please visit our menu first by typing "menu" and let us know which items you\'d like to order.');
                } else if (messageBody === 'status') {
                    await this.checkOrderStatus(msg);
                } else {
                    // Default response for unrecognized messages
                    await msg.reply('I didn\'t understand that. Type "help" to see available commands or "menu" to view our menu.');
                }
            }
        } catch (error) {
            console.error(`Error handling message in ${this.clientName}:`, error);
        }
    }

    async sendMenu(msg) {
        try {
            const menuItems = await MenuItem.find({ isAvailable: true }).sort({ category: 1, name: 1 });
            
            if (menuItems.length === 0) {
                await msg.reply('Sorry, our menu is currently not available. Please try again later.');
                return;
            }

            let menuText = '🍽️ *Our Menu* 🍽️\n\n';
            let currentCategory = '';
            
            menuItems.forEach(item => {
                if (item.category !== currentCategory) {
                    currentCategory = item.category;
                    menuText += `*${currentCategory}*\n`;
                    menuText += '─────────────\n';
                }
                
                menuText += `• ${item.name}\n`;
                if (item.description) {
                    menuText += `  ${item.description}\n`;
                }
                menuText += `  💰 $${item.price.toFixed(2)}\n`;
                if (item.isNew) menuText += '  🆕 New!\n';
                if (item.isTrending) menuText += '  🔥 Trending!\n';
                menuText += '\n';
            });

            menuText += 'To place an order, please let us know which items you\'d like!';
            
            await msg.reply(menuText);
        } catch (error) {
            console.error(`Error sending menu in ${this.clientName}:`, error);
            await msg.reply('Sorry, there was an error retrieving the menu. Please try again later.');
        }
    }

    async checkOrderStatus(msg) {
        try {
            const customerId = msg.from;
            const recentOrder = await Order.findOne({ customerId }).sort({ orderDate: -1 });
            
            if (!recentOrder) {
                await msg.reply('No recent orders found. Would you like to place an order?');
                return;
            }

            let statusText = `📋 *Order Status*\n\n`;
            statusText += `Order ID: ${recentOrder._id.toString().substring(0, 8)}\n`;
            statusText += `Status: ${recentOrder.status}\n`;
            statusText += `Total: $${recentOrder.totalAmount.toFixed(2)}\n`;
            statusText += `Date: ${recentOrder.orderDate.toLocaleDateString()}\n\n`;
            
            statusText += `*Items:*\n`;
            recentOrder.items.forEach(item => {
                statusText += `• ${item.name} x${item.quantity} - $${(item.price * item.quantity).toFixed(2)}\n`;
            });

            await msg.reply(statusText);
        } catch (error) {
            console.error(`Error checking order status in ${this.clientName}:`, error);
            await msg.reply('Sorry, there was an error checking your order status. Please try again later.');
        }
    }

    destroy() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        if (this.client) {
            return this.client.destroy();
        }
    }
}

// --- Initialize WhatsApp Clients ---
const whatsappClient1 = new WhatsAppClientManager('whatsapp-bot-1', 'WhatsApp Bot 1');
const whatsappClient2 = new WhatsAppClientManager('whatsapp-bot-2', 'WhatsApp Bot 2');

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('Client connected to socket');
    
    // Send current status when client connects
    whatsappClient1.emitStatus();
    whatsappClient2.emitStatus();
    
    socket.on('disconnect', () => {
        console.log('Client disconnected from socket');
    });
});

// --- API Routes ---

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        whatsapp1: {
            isReady: whatsappClient1.isReady,
            status: whatsappClient1.statusMessage
        },
        whatsapp2: {
            isReady: whatsappClient2.isReady,
            status: whatsappClient2.statusMessage
        }
    });
});

// --- Authentication Routes (Re-introduced) ---

// User registration (for initial setup)
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required' });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists' });
        }

        // Create new user
        const user = new User({ username, password });
        await user.save();

        res.status(201).json({ message: 'User created successfully' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// User login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required' });
        }

        // Find user
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user._id, username: user.username },
            process.env.JWT_SECRET || 'your_jwt_secret_key',
            { expiresIn: '24h' }
        );

        res.json({ 
            message: 'Login successful', 
            token,
            user: { id: user._id, username: user.username }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login' });
    }
});

// --- Menu Management Routes ---

// Get all menu items
app.get('/api/menu', async (req, res) => {
    try {
        const menuItems = await MenuItem.find().sort({ category: 1, name: 1 });
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu items:', error);
        res.status(500).json({ message: 'Server error fetching menu items' });
    }
});

// Get menu item by ID
app.get('/api/menu/:id', async (req, res) => {
    try {
        const menuItem = await MenuItem.findById(req.params.id);
        if (!menuItem) {
            return res.status(404).json({ message: 'Menu item not found' });
        }
        res.json(menuItem);
    } catch (error) {
            console.error('Error fetching menu item:', error);
        res.status(500).json({ message: 'Server error fetching menu item' });
    }
});

// Create new menu item (protected)
app.post('/api/menu', authenticateToken, async (req, res) => {
    try {
        const { name, description, price, imageUrl, category, isAvailable, isNew, isTrending } = req.body;
        
        if (!name || !price) {
            return res.status(400).json({ message: 'Name and price are required' });
        }

        const menuItem = new MenuItem({
            name,
            description,
            price,
            imageUrl,
            category,
            isAvailable,
            isNew,
            isTrending
        });

        const savedItem = await menuItem.save();
        res.status(201).json(savedItem);
    } catch (error) {
        console.error('Error creating menu item:', error);
        res.status(500).json({ message: 'Server error creating menu item' });
    }
});

// Update menu item (protected)
app.put('/api/menu/:id', authenticateToken, async (req, res) => {
    try {
        const { name, description, price, imageUrl, category, isAvailable, isNew, isTrending } = req.body;
        
        const updatedItem = await MenuItem.findByIdAndUpdate(
            req.params.id,
            { name, description, price, imageUrl, category, isAvailable, isNew, isTrending },
            { new: true, runValidators: true }
        );

        if (!updatedItem) {
            return res.status(404).json({ message: 'Menu item not found' });
        }

        res.json(updatedItem);
    } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(500).json({ message: 'Server error updating menu item' });
    }
});

// Delete menu item (protected)
app.delete('/api/menu/:id', authenticateToken, async (req, res) => {
    try {
        const deletedItem = await MenuItem.findByIdAndDelete(req.params.id);
        if (!deletedItem) {
            return res.status(404).json({ message: 'Menu item not found' });
        }
        res.json({ message: 'Menu item deleted successfully' });
    } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).json({ message: 'Server error deleting menu item' });
    }
});

// --- Order Management Routes ---

// Get all orders (protected)
app.get('/api/orders', authenticateToken, async (req, res) => {
    try {
        const orders = await Order.find()
            .populate('items.menuItemId')
            .sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Server error fetching orders' });
    }
});

// Get order by ID (protected)
app.get('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id).populate('items.menuItemId');
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ message: 'Server error fetching order' });
    }
});

// Create new order
app.post('/api/orders', async (req, res) => {
    try {
        const { customerId, customerName, items } = req.body;
        
        if (!customerId || !items || items.length === 0) {
            return res.status(400).json({ message: 'Customer ID and items are required' });
        }

        // Calculate total amount
        let totalAmount = 0;
        const orderItems = [];

        for (const item of items) {
            const menuItem = await MenuItem.findById(item.menuItemId);
            if (!menuItem) {
                return res.status(400).json({ message: `Menu item not found: ${item.menuItemId}` });
            }
            
            const quantity = item.quantity || 1;
            const itemTotal = menuItem.price * quantity;
            totalAmount += itemTotal;

            orderItems.push({
                menuItemId: menuItem._id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: quantity
            });
        }

        const order = new Order({
            customerId,
            customerName: customerName || 'Unknown',
            items: orderItems,
            totalAmount
        });

        const savedOrder = await order.save();
        res.status(201).json(savedOrder);
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ message: 'Server error creating order' });
    }
});

// Update order status (protected)
app.put('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        
        if (!status) {
            return res.status(400).json({ message: 'Status is required' });
        }

        const updatedOrder = await Order.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true, runValidators: true }
        );

        if (!updatedOrder) {
            return res.status(404).json({ message: 'Order not found' });
        }

        res.json(updatedOrder);
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ message: 'Server error updating order' });
    }
});

// Delete order (protected)
app.delete('/api/orders/:id', authenticateToken, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json({ message: 'Order deleted successfully' });
    } catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).json({ message: 'Server error deleting order' });
    }
});

// --- WhatsApp Management Routes ---

// Get WhatsApp status (protected)
app.get('/api/whatsapp/status', authenticateToken, (req, res) => {
    res.json({
        client1: {
            isReady: whatsappClient1.isReady,
            status: whatsappClient1.statusMessage
        },
        client2: {
            isReady: whatsappClient2.isReady,
            status: whatsappClient2.statusMessage
        }
    });
});

// Restart WhatsApp client (protected)
app.post('/api/whatsapp/restart/:clientId', authenticateToken, async (req, res) => {
    try {
        const { clientId } = req.params;
        
        if (clientId === '1') {
            await whatsappClient1.initialize();
            res.json({ message: 'WhatsApp Client 1 restart initiated' });
        } else if (clientId === '2') {
            await whatsappClient2.initialize();
            res.json({ message: 'WhatsApp Client 2 restart initiated' });
        } else {
            res.status(400).json({ message: 'Invalid client ID' });
        }
    } catch (error) {
        console.error('Error restarting WhatsApp client:', error);
        res.status(500).json({ message: 'Server error restarting WhatsApp client' });
    }
});

// Send message through WhatsApp (protected)
app.post('/api/whatsapp/send', authenticateToken, async (req, res) => {
    try {
        const { clientId, to, message } = req.body;
        
        if (!clientId || !to || !message) {
            return res.status(400).json({ message: 'Client ID, recipient, and message are required' });
        }

        const client = clientId === '1' ? whatsappClient1 : whatsappClient2;
        
        if (!client.isReady) {
            return res.status(400).json({ message: 'WhatsApp client is not ready' });
        }

        await client.client.sendMessage(to, message);
        res.json({ message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        res.status(500).json({ message: 'Server error sending message' });
    }
});

// --- Static Files & Frontend ---
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all handler for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Scheduled Tasks ---

// Daily cleanup task (runs at 2 AM)
cron.schedule('0 2 * * *', async () => {
    console.log('Running daily cleanup task...');
    
    try {
        // Clean up old orders (older than 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const deletedOrders = await Order.deleteMany({
            orderDate: { $lt: thirtyDaysAgo },
            status: { $in: ['Delivered', 'Cancelled'] }
        });
        
        console.log(`Cleaned up ${deletedOrders.deletedCount} old orders`);
    } catch (error) {
        console.error('Error in daily cleanup task:', error);
    }
});

// --- Server Initialization ---

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // Create default admin user if none exists
        const userCount = await User.countDocuments();
        if (userCount === 0) {
            const defaultUser = new User({
                username: 'admin',
                password: 'admin123' // Change this in production!
            });
            await defaultUser.save();
            console.log('Default admin user created (username: admin, password: admin123)');
        }

        // Start server
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            console.log(`Dashboard: http://localhost:${PORT}`);
        });

        // Initialize WhatsApp clients
        console.log('Initializing WhatsApp clients...');
        await whatsappClient1.initialize();
        await whatsappClient2.initialize();

    } catch (error) {
        console.error('Error starting server:', error);
        process.exit(1);
    }
}

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    
    try {
        await whatsappClient1.destroy();
        await whatsappClient2.destroy();
        await mongoose.connection.close();
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    
    try {
        await whatsappClient1.destroy();
        await whatsappClient2.destroy();
        await mongoose.connection.close();
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

// Start the server
startServer();

