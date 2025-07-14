// server.js
// This is the main entry point for the Node.js backend server.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); // Required for socket.io
const socketIo = require('socket.io'); // For real-time QR code updates
const path = require('path'); // For serving static files
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js'); // WhatsApp Web JS library
const qrcode = require('qrcode'); // For generating QR code images
const cron = require('node-cron'); // For scheduling recurring tasks

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
}); // Initialize socket.io with the HTTP server

// --- MongoDB Connection ---
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room"; // Default if not in .env

mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Mongoose Models ---

// User Model for Dashboard Login
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
}, { suppressReservedKeysWarning: true }); // <--- Added this option to suppress the warning

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

// --- Authentication Middleware ---
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

// --- WhatsApp Web JS Client Setup ---
let qrCodeImageBase64 = null; // Stores QR code image data (base64)
let qrCodeString = null; // Stores the raw QR code string
let whatsappStatusMessage = 'Initializing WhatsApp Client...'; // Stores status message
let whatsappClient; // WhatsApp client instance
let isWhatsappClientReady = false; // Flag to indicate client readiness
let lastQrGeneratedAt = null; // Timestamp of last QR generation

// Function to emit current QR and status to all connected Socket.IO clients
const emitQrAndStatus = () => {
    io.emit('qr-update', {
        image: qrCodeImageBase64,
        qrString: qrCodeString,
        status: whatsappStatusMessage,
        isReady: isWhatsappClientReady,
        timestamp: lastQrGeneratedAt
    });
};

const initializeWhatsappClient = () => {
    console.log('Initializing WhatsApp Client...');
    whatsappStatusMessage = 'Initializing WhatsApp Client...';
    qrCodeImageBase64 = null;
    qrCodeString = null;
    isWhatsappClientReady = false;
    lastQrGeneratedAt = null;
    emitQrAndStatus(); // Emit initial state

    try {
        whatsappClient = new Client({
            authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }), // Stores session data locally
            puppeteer: {
                headless: true, // Run in headless mode for deployment
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process', // This might help on some environments
                    '--disable-gpu',
                    // Additional arguments for better stability on headless Linux environments
                    '--disable-features=site-per-process',
                    '--disable-web-security',
                    '--disable-sync',
                    '--disable-infobars',
                    '--window-size=1920,1080', // Explicit window size
                    '--ignore-certificate-errors', // Can sometimes help with SSL issues
                    '--incognito', // Starts a clean session each time (might help if session data gets corrupted)
                    '--enable-features=NetworkService,NetworkServiceInProcess' // Experimental, but sometimes helps
                ],
            },
        });

        whatsappClient.on('qr', async (qr) => {
            console.log('QR RECEIVED', qr);
            qrCodeString = qr;
            qrCodeImageBase64 = await qrcode.toDataURL(qr); // Convert QR string to data URL
            whatsappStatusMessage = 'Scan this QR code with your WhatsApp app to connect.';
            isWhatsappClientReady = false;
            lastQrGeneratedAt = new Date().toISOString();
            emitQrAndStatus(); // Emit QR code to connected dashboard clients
        });

        whatsappClient.on('ready', () => {
            console.log('WhatsApp Client is ready!');
            qrCodeImageBase64 = null; // Clear QR image once ready
            qrCodeString = null;
            whatsappStatusMessage = 'WhatsApp Client is ready and connected!';
            isWhatsappClientReady = true;
            lastQrGeneratedAt = null;
            emitQrAndStatus(); // Inform dashboard
        });

        whatsappClient.on('authenticated', () => {
            console.log('WhatsApp Client Authenticated');
            qrCodeImageBase64 = null; // Clear QR image once authenticated
            qrCodeString = null;
            whatsappStatusMessage = 'WhatsApp Client Authenticated successfully!';
            isWhatsappClientReady = true;
            lastQrGeneratedAt = null;
            emitQrAndStatus();
        });

        whatsappClient.on('auth_failure', msg => {
            console.error('AUTHENTICATION FAILURE', msg);
            qrCodeImageBase64 = null;
            qrCodeString = null;
            whatsappStatusMessage = `Authentication Failed: ${msg}`;
            isWhatsappClientReady = false;
            lastQrGeneratedAt = null;
            emitQrAndStatus();
        });

        whatsappClient.on('disconnected', (reason) => {
            console.log('WhatsApp Client Disconnected', reason);
            qrCodeImageBase64 = null;
            qrCodeString = null;
            whatsappStatusMessage = `Disconnected: ${reason}. Attempting to reconnect...`;
            isWhatsappClientReady = false;
            lastQrGeneratedAt = null;
            emitQrAndStatus();
            // Attempt to re-initialize or restart the client
            console.log('Attempting to re-initialize WhatsApp Client in 5 seconds...');
            setTimeout(() => initializeWhatsappClient(), 5000); // Try to re-initialize after 5 seconds
        });

        whatsappClient.on('message', async (msg) => {
            console.log('MESSAGE RECEIVED', msg.body);

            const chat = await msg.getChat();
            // Ensure the customerId is in the format expected by WhatsApp-web.js (e.g., 919876543210@c.us)
            const customerId = msg.from;
            const customerName = chat.name || customerId.split('@')[0]; // Use chat name or phone number

            let responseText = '';

            // Convert message to lowercase for case-insensitive matching
            const lowerCaseMsg = msg.body.toLowerCase();

            if (lowerCaseMsg.includes('hi') || lowerCaseMsg.includes('hello') || lowerCaseMsg.includes('hey')) {
                responseText = `Hello ${customerName}! Welcome to our food business!
How can I help you today?

*1. Web Menu:* Browse our delicious menu and order online.
*2. Orders:* Check your past orders.
*3. Profile:* View your profile details.
*4. Help/Support:* Get assistance.

Please reply with the number of the option you'd like to choose.`;
            } else if (lowerCaseMsg.includes('1') || lowerCaseMsg.includes('menu')) {
                responseText = `Here's our delicious web menu: ${process.env.MENU_URL || 'https://your-food-business.com/menu'}
You can browse and place your order directly from there!`;
            } else if (lowerCaseMsg.includes('2') || lowerCaseMsg.includes('orders')) {
                // Fetch past orders for this customer
                const customerOrders = await Order.find({ customerId: customerId }).sort({ orderDate: -1 }).limit(5);

                if (customerOrders.length > 0) {
                    responseText = `Here are your recent orders:\n\n`;
                    customerOrders.forEach((order, index) => {
                        responseText += `*Order #${index + 1}* (ID: ${order._id.toString().substring(0, 8)}...)\n`;
                        responseText += `Status: *${order.status}*\n`;
                        responseText += `Total: Rs. ${order.totalAmount.toFixed(2)}\n`;
                        responseText += `Date: ${order.orderDate.toLocaleDateString()}\n`;
                        responseText += `Items: ${order.items.map(item => `${item.name} (x${item.quantity})`).join(', ')}\n\n`;
                    });
                    responseText += `To place a new order, visit our web menu: ${process.env.MENU_URL || 'https://your-food-business.com/menu'}`;
                } else {
                    responseText = `You haven't placed any orders yet. Visit our web menu to start ordering: ${process.env.MENU_URL || 'https://your-food-business.com/menu'}`;
                }
            } else if (lowerCaseMsg.includes('3') || lowerCaseMsg.includes('profile')) {
                responseText = `Your profile details:
Phone Number: ${customerId.split('@')[0]}
Name: ${customerName}
(More profile features coming soon!)`;
            } else if (lowerCaseMsg.includes('4') || lowerCaseMsg.includes('help') || lowerCaseMsg.includes('support')) {
                responseText = `For any assistance, you can:
- Call us at: +91 12345 67890
- Email us at: support@yourfoodbusiness.com
- Visit our FAQ: ${process.env.FAQ_URL || 'https://your-food-business.com/faq'}

We are here to help!`;
            } else if (lowerCaseMsg.includes('order')) {
                // This is a simplified order creation. In a real scenario, you'd have a more guided flow.
                // For now, it will just direct them to the menu.
                responseText = `To place an order, please visit our web menu: ${process.env.MENU_URL || 'https://your-food-business.com/menu'}`;
            }
            else {
                responseText = `I'm sorry, I didn't understand that.
Please choose from the options below:

*1. Web Menu:* Browse our delicious menu and order online.
*2. Orders:* Check your past orders.
*3. Profile:* View your profile details.
*4. Help/Support:* Get assistance.`;
            }

            await msg.reply(responseText);
        });

        whatsappClient.initialize();
    } catch (error) {
        console.error('Error initializing WhatsApp Client:', error);
        whatsappStatusMessage = `Initialization Error: ${error.message}. Check server logs.`;
        qrCodeImageBase64 = null;
        qrCodeString = null;
        isWhatsappClientReady = false;
        lastQrGeneratedAt = null;
        emitQrAndStatus();
        // Attempt to re-initialize after a delay
        console.log('Attempting to re-initialize WhatsApp Client after an error in 10 seconds...');
        setTimeout(() => initializeWhatsappClient(), 10000);
    }
};

// Initialize WhatsApp client on server start
initializeWhatsappClient();

// --- Scheduled Notification Function ---
const sendOrderReminderNotifications = async () => {
    if (!isWhatsappClientReady) {
        console.log('WhatsApp client not ready for sending scheduled notifications.');
        return;
    }

    console.log('Running scheduled order reminder task...');
    try {
        // Find all unique customer IDs that have placed orders
        const distinctCustomerIds = await Order.distinct('customerId');

        for (const customerId of distinctCustomerIds) {
            // Find the most recent order for this customer
            const lastOrder = await Order.findOne({ customerId })
                .sort({ orderDate: -1 })
                .limit(1);

            if (lastOrder) {
                const now = new Date();
                const lastOrderDate = lastOrder.orderDate;
                const timeDiff = now.getTime() - lastOrderDate.getTime();
                const daysDiff = Math.floor(timeDiff / (1000 * 60 * 60 * 24));

                // Check if daysDiff is a multiple of 7 (or very close, e.g., within 1 day of a multiple of 7)
                const REMINDER_INTERVAL_DAYS = parseInt(process.env.REMINDER_INTERVAL_DAYS || '7');
                const isReminderDay = (daysDiff > 0 && daysDiff % REMINDER_INTERVAL_DAYS === 0) ||
                                     (daysDiff > 0 && (daysDiff + 1) % REMINDER_INTERVAL_DAYS === 0) || // Check day before
                                     (daysDiff > 0 && (daysDiff - 1) % REMINDER_INTERVAL_DAYS === 0); // Check day after

                if (isReminderDay) {
                    const message = `Hey ${lastOrder.customerName || lastOrder.customerId.split('@')[0]}!
It's been a while since your last delicious order with us! 😋

We miss you! Check out our latest menu and special offers:
${process.env.MENU_URL || 'https://your-food-business.com/menu'}

Looking forward to serving you again soon!`;

                    try {
                        await whatsappClient.sendMessage(customerId, message);
                        console.log(`Sent reminder to ${customerId} (last ordered ${daysDiff} days ago).`);
                    } catch (sendError) {
                        console.error(`Failed to send reminder to ${customerId}:`, sendError);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in scheduled order reminder task:', error);
    }
};

// Schedule the task to run once every day at 09:00 AM (adjust as needed)
cron.schedule('0 9 * * *', () => {
    sendOrderReminderNotifications();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Set your desired timezone
});

// --- Admin Notification Function for New Orders ---
const notifyAdminOfNewOrder = async (order) => {
    if (!isWhatsappClientReady) {
        console.log('WhatsApp client not ready for sending admin notifications.');
        return;
    }

    const adminNumber = process.env.ADMIN_WHATSAPP_NUMBER;
    if (!adminNumber) {
        console.warn('ADMIN_WHATSAPP_NUMBER is not set in .env. Cannot send admin new order notification.');
        return;
    }

    const orderItems = order.items.map(item => `${item.name} (x${item.quantity})`).join(', ');
    const notificationMessage = `*🔔 New Order Alert! 🔔*

*Order ID:* ${order._id.toString().substring(0, 8)}...
*Customer:* ${order.customerName || order.customerId.split('@')[0]}
*Contact:* ${order.customerId.split('@')[0]}
*Items:* ${orderItems}
*Total Amount:* Rs. ${order.totalAmount.toFixed(2)}
*Status:* ${order.status}
*Order Date:* ${order.orderDate.toLocaleString()}

Please check the dashboard for more details.`;

    try {
        // Ensure the adminNumber is in the correct WhatsApp ID format (e.g., 919876543210@c.us)
        const formattedAdminNumber = adminNumber.includes('@c.us') ? adminNumber : `${adminNumber}@c.us`;
        await whatsappClient.sendMessage(formattedAdminNumber, notificationMessage);
        console.log(`Admin notified about new order: ${order._id}`);
    } catch (error) {
        console.error(`Failed to send new order notification to admin (${adminNumber}):`, error);
    }
};

// --- API Endpoints Health Check ---
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        whatsappStatus: whatsappStatusMessage,
        whatsappReady: isWhatsappClientReady,
        mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});

// --- API Endpoints (URL Rewriting using Express Router) ---

// Auth Routes
const authRouter = express.Router();
app.use('/api/auth', authRouter);

authRouter.post('/register', async (req, res) => {
    const { username, password } = req.body;
    
    // Basic validation
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }
    
    try {
        const newUser = new User({ username, password });
        await newUser.save();
        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        if (error.code === 11000) { // Duplicate key error for unique username
            return res.status(409).json({ message: 'Username already exists.' });
        }
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Error registering user.', error: error.message });
    }
});

authRouter.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }
    
    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(400).json({ message: 'Invalid credentials.' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials.' });

        const token = jwt.sign(
            { id: user._id, username: user.username },
            process.env.JWT_SECRET || 'your_jwt_secret_key',
            { expiresIn: '1h' } // Token expires in 1 hour
        );

        res.json({ 
            message: 'Logged in successfully!', 
            token,
            user: { id: user._id, username: user.username }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Error logging in.', error: error.message });
    }
});

// Menu Routes
const menuRouter = express.Router();
app.use('/api/menu', menuRouter);

menuRouter.get('/', async (req, res) => {
    try {
        const menuItems = await MenuItem.find().sort({ createdAt: -1 });
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu items:', error);
        res.status(500).json({ message: 'Error fetching menu items.', error: error.message });
    }
});

menuRouter.get('/:id', async (req, res) => {
    try {
        const menuItem = await MenuItem.findById(req.params.id);
        if (!menuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json(menuItem);
    } catch (error) {
        console.error('Error fetching menu item:', error);
        res.status(500).json({ message: 'Error fetching menu item.', error: error.message });
    }
});

menuRouter.post('/', authenticateToken, async (req, res) => {
    try {
        const { name, description, price, imageUrl, category, isAvailable, isNew, isTrending } = req.body;
        
        if (!name || !price) {
            return res.status(400).json({ message: 'Name and price are required.' });
        }
        
        const newMenuItem = new MenuItem({
            name,
            description,
            price: parseFloat(price),
            imageUrl: imageUrl || 'https://placehold.co/400x300/E0E0E0/333333?text=No+Image',
            category: category || 'General',
            isAvailable: isAvailable !== undefined ? isAvailable : true,
            isNew: isNew || false,
            isTrending: isTrending || false
        });
        
        await newMenuItem.save();
        res.status(201).json({ message: 'Menu item created successfully!', menuItem: newMenuItem });
    } catch (error) {
        console.error('Error creating menu item:', error);
        res.status(500).json({ message: 'Error creating menu item.', error: error.message });
    }
});

menuRouter.put('/:id', authenticateToken, async (req, res) => {
    try {
        const { name, description, price, imageUrl, category, isAvailable, isNew, isTrending } = req.body;
        
        const updatedMenuItem = await MenuItem.findByIdAndUpdate(
            req.params.id,
            {
                name,
                description,
                price: parseFloat(price),
                imageUrl,
                category,
                isAvailable,
                isNew,
                isTrending
            },
            { new: true, runValidators: true }
        );
        
        if (!updatedMenuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        
        res.json({ message: 'Menu item updated successfully!', menuItem: updatedMenuItem });
    } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(500).json({ message: 'Error updating menu item.', error: error.message });
    }
});

menuRouter.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const deletedMenuItem = await MenuItem.findByIdAndDelete(req.params.id);
        if (!deletedMenuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item deleted successfully!' });
    } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).json({ message: 'Error deleting menu item.', error: error.message });
    }
});

// Order Routes
const orderRouter = express.Router();
app.use('/api/orders', orderRouter);

orderRouter.get('/', authenticateToken, async (req, res) => {
    try {
        const orders = await Order.find()
            .populate('items.menuItemId')
            .sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Error fetching orders.', error: error.message });
    }
});

orderRouter.get('/:id', authenticateToken, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id).populate('items.menuItemId');
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json(order);
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ message: 'Error fetching order.', error: error.message });
    }
});

orderRouter.post('/', async (req, res) => {
    try {
        const { customerId, customerName, items, totalAmount } = req.body;
        
        if (!customerId || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Customer ID and items are required.' });
        }
        
        // Validate and populate menu items
        const populatedItems = [];
        for (const item of items) {
            const menuItem = await MenuItem.findById(item.menuItemId);
            if (!menuItem) {
                return res.status(400).json({ message: `Menu item with ID ${item.menuItemId} not found.` });
            }
            if (!menuItem.isAvailable) {
                return res.status(400).json({ message: `${menuItem.name} is currently unavailable.` });
            }
            populatedItems.push({
                menuItemId: menuItem._id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: item.quantity || 1
            });
        }
        
        // Calculate total amount
        const calculatedTotal = populatedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        const newOrder = new Order({
            customerId,
            customerName: customerName || 'Unknown',
            items: populatedItems,
            totalAmount: calculatedTotal,
            status: 'Pending'
        });
        
        await newOrder.save();
        
        // Notify admin about new order
        await notifyAdminOfNewOrder(newOrder);
        
        res.status(201).json({ message: 'Order created successfully!', order: newOrder });
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ message: 'Error creating order.', error: error.message });
    }
});

orderRouter.put('/:id/status', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status value.' });
        }
        
        const updatedOrder = await Order.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true }
        ).populate('items.menuItemId');
        
        if (!updatedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        
        // Send status update to customer via WhatsApp
        if (isWhatsappClientReady) {
            const statusMessage = `*Order Status Update*

Order ID: ${updatedOrder._id.toString().substring(0, 8)}...
Status: *${status}*
Total: Rs. ${updatedOrder.totalAmount.toFixed(2)}

${status === 'Confirmed' ? 'Your order has been confirmed and will be prepared shortly!' : 
  status === 'Preparing' ? 'Your delicious food is being prepared!' :
  status === 'Out for Delivery' ? 'Your order is on its way! 🚚' :
  status === 'Delivered' ? 'Your order has been delivered! Enjoy your meal! 😋' :
  status === 'Cancelled' ? 'Your order has been cancelled. Please contact us for more information.' :
  'Order status updated.'}

Thank you for choosing us!`;
            
            try {
                await whatsappClient.sendMessage(updatedOrder.customerId, statusMessage);
                console.log(`Status update sent to ${updatedOrder.customerId} for order ${updatedOrder._id}`);
            } catch (whatsappError) {
                console.error(`Failed to send status update to ${updatedOrder.customerId}:`, whatsappError);
            }
        }
        
        res.json({ message: 'Order status updated successfully!', order: updatedOrder });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ message: 'Error updating order status.', error: error.message });
    }
});

orderRouter.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({ message: 'Order deleted successfully!' });
    } catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).json({ message: 'Error deleting order.', error: error.message });
    }
});

// WhatsApp Status Routes
const whatsappRouter = express.Router();
app.use('/api/whatsapp', whatsappRouter);

whatsappRouter.get('/status', authenticateToken, (req, res) => {
    res.json({
        status: whatsappStatusMessage,
        isReady: isWhatsappClientReady,
        qrCode: qrCodeImageBase64,
        qrString: qrCodeString,
        lastQrGenerated: lastQrGeneratedAt
    });
});

whatsappRouter.post('/restart', authenticateToken, async (req, res) => {
    try {
        console.log('Manual WhatsApp client restart requested...');
        
        // Destroy existing client if it exists
        if (whatsappClient) {
            try {
                await whatsappClient.destroy();
                console.log('Existing WhatsApp client destroyed.');
            } catch (destroyError) {
                console.error('Error destroying existing client:', destroyError);
            }
        }
        
        // Re-initialize the client
        setTimeout(() => {
            initializeWhatsappClient();
        }, 2000); // Small delay to ensure cleanup
        
        res.json({ message: 'WhatsApp client restart initiated.' });
    } catch (error) {
        console.error('Error restarting WhatsApp client:', error);
        res.status(500).json({ message: 'Error restarting WhatsApp client.', error: error.message });
    }
});

// Dashboard Analytics Routes
const analyticsRouter = express.Router();
app.use('/api/analytics', analyticsRouter);

analyticsRouter.get('/dashboard', authenticateToken, async (req, res) => {
    try {
        const totalOrders = await Order.countDocuments();
        const totalRevenue = await Order.aggregate([
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);
        const totalMenuItems = await MenuItem.countDocuments();
        const pendingOrders = await Order.countDocuments({ status: 'Pending' });
        const deliveredOrders = await Order.countDocuments({ status: 'Delivered' });
        
        // Recent orders
        const recentOrders = await Order.find()
            .populate('items.menuItemId')
            .sort({ orderDate: -1 })
            .limit(10);
        
        // Order status distribution
        const statusDistribution = await Order.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        
        // Monthly revenue (last 6 months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        
        const monthlyRevenue = await Order.aggregate([
            { $match: { orderDate: { $gte: sixMonthsAgo } } },
            {
                $group: {
                    _id: {
                        year: { $year: '$orderDate' },
                        month: { $month: '$orderDate' }
                    },
                    revenue: { $sum: '$totalAmount' },
                    orderCount: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
        ]);
        
        res.json({
            summary: {
                totalOrders,
                totalRevenue: totalRevenue[0]?.total || 0,
                totalMenuItems,
                pendingOrders,
                deliveredOrders
            },
            recentOrders,
            statusDistribution,
            monthlyRevenue,
            whatsappStatus: {
                isReady: isWhatsappClientReady,
                status: whatsappStatusMessage
            }
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ message: 'Error fetching analytics.', error: error.message });
    }
});

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('New client connected for QR updates');
    
    // Send current QR code status immediately upon connection
    emitQrAndStatus();
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// --- Serve Static Files (Frontend) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Catch-All Route for SPA ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Error Handling Middleware ---
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ message: 'Internal server error.', error: error.message });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`MongoDB: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
});

// --- Graceful Shutdown ---
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');
    
    // Close WhatsApp client
    if (whatsappClient) {
        try {
            await whatsappClient.destroy();
            console.log('WhatsApp client destroyed.');
        } catch (error) {
            console.error('Error destroying WhatsApp client:', error);
        }
    }
    
    // Close MongoDB connection
    try {
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
    } catch (error) {
        console.error('Error closing MongoDB connection:', error);
    }
    
    // Close server
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully...');
    
    // Close WhatsApp client
    if (whatsappClient) {
        try {
            await whatsappClient.destroy();
            console.log('WhatsApp client destroyed.');
        } catch (error) {
            console.error('Error destroying WhatsApp client:', error);
        }
    }
    
    // Close MongoDB connection
    try {
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
    } catch (error) {
        console.error('Error closing MongoDB connection:', error);
    }
    
    // Close server
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});
