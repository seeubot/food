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
const io = socketIo(server); // Initialize socket.io with the HTTP server

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

// Menu Item Model
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
});

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
let qrCodeData = 'Initializing...'; // Store QR code data
let whatsappClient; // WhatsApp client instance
let isWhatsappClientReady = false; // Flag to indicate client readiness

const initializeWhatsappClient = () => {
    console.log('Initializing WhatsApp Client...');
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
                '--disable-gpu'
            ],
        },
    });

    whatsappClient.on('qr', async (qr) => {
        console.log('QR RECEIVED', qr);
        qrCodeData = await qrcode.toDataURL(qr); // Convert QR string to data URL
        io.emit('qr', qrCodeData); // Emit QR code to connected dashboard clients
        isWhatsappClientReady = false; // Client is not ready until 'ready' event
    });

    whatsappClient.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        qrCodeData = 'WhatsApp Client is ready!'; // Update status
        io.emit('qr', qrCodeData); // Inform dashboard
        isWhatsappClientReady = true; // Set client as ready
    });

    whatsappClient.on('authenticated', () => {
        console.log('WhatsApp Client Authenticated');
        qrCodeData = 'WhatsApp Client Authenticated!';
        io.emit('qr', qrCodeData);
    });

    whatsappClient.on('auth_failure', msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        qrCodeData = `Auth Failure: ${msg}`;
        io.emit('qr', qrCodeData);
        isWhatsappClientReady = false;
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('WhatsApp Client Disconnected', reason);
        qrCodeData = `Disconnected: ${reason}. Reconnecting...`;
        io.emit('qr', qrCodeData);
        isWhatsappClientReady = false;
        // Attempt to re-initialize or restart the client
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


// --- API Endpoints (URL Rewriting using Express Router) ---

// Auth Routes
const authRouter = express.Router();
app.use('/api/auth', authRouter);

authRouter.post('/register', async (req, res) => {
    const { username, password } = req.body;
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

        res.json({ message: 'Logged in successfully!', token });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error during login.', error: error.message });
    }
});

// Menu Management Routes
const menuRouter = express.Router();
app.use('/api/menu', authenticateToken, menuRouter); // Protect menu routes

// Get all menu items
menuRouter.get('/', async (req, res) => {
    try {
        const menuItems = await MenuItem.find({});
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu items:', error);
        res.status(500).json({ message: 'Error fetching menu items.', error: error.message });
    }
});

// Add a new menu item
menuRouter.post('/', async (req, res) => {
    const { name, description, price, imageUrl, category, isAvailable, isNew, isTrending } = req.body;
    try {
        const newItem = new MenuItem({ name, description, price, imageUrl, category, isAvailable, isNew, isTrending });
        await newItem.save();
        res.status(201).json({ message: 'Menu item added successfully!', item: newItem });
    } catch (error) {
        console.error('Error adding menu item:', error);
        res.status(400).json({ message: 'Error adding menu item.', error: error.message });
    }
});

// Update a menu item
menuRouter.put('/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    try {
        const updatedItem = await MenuItem.findByIdAndUpdate(id, updates, { new: true });
        if (!updatedItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item updated successfully!', item: updatedItem });
    } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(400).json({ message: 'Error updating menu item.', error: error.message });
    }
});

// Delete a menu item
menuRouter.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const deletedItem = await MenuItem.findByIdAndDelete(id);
        if (!deletedItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item deleted successfully!' });
    } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).json({ message: 'Error deleting menu item.', error: error.message });
    }
});

// Order Management Routes
const orderRouter = express.Router();
app.use('/api/orders', orderRouter); // No authentication for placing orders from web menu

// Endpoint for placing a new order from the web menu
orderRouter.post('/place', async (req, res) => {
    // Expected body: { customerPhoneNumber: '919876543210', customerName: 'John Doe', items: [{ itemId: '...', quantity: 1 }] }
    const { customerPhoneNumber, customerName, items } = req.body;

    if (!customerPhoneNumber || !items || items.length === 0) {
        return res.status(400).json({ message: 'Missing customer phone number or order items.' });
    }

    // Format customerId for WhatsApp-web.js
    const customerId = customerPhoneNumber.includes('@c.us') ? customerPhoneNumber : `${customerPhoneNumber}@c.us`;

    try {
        let totalAmount = 0;
        const orderItems = [];

        // Fetch menu item details to validate and calculate total
        for (const item of items) {
            const menuItem = await MenuItem.findById(item.itemId);
            if (!menuItem || !menuItem.isAvailable) {
                return res.status(400).json({ message: `Item "${item.itemId}" not found or not available.` });
            }
            orderItems.push({
                menuItemId: menuItem._id,
                name: menuItem.name,
                price: menuItem.price,
                quantity: item.quantity,
            });
            totalAmount += menuItem.price * item.quantity;
        }

        const newOrder = new Order({
            customerId,
            customerName: customerName || 'Guest',
            items: orderItems,
            totalAmount,
            status: 'Pending', // Initial status
        });

        await newOrder.save();

        // Notify admin about the new order
        await notifyAdminOfNewOrder(newOrder);

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });
    } catch (error) {
        console.error('Error placing new order:', error);
        res.status(500).json({ message: 'Error placing order.', error: error.message });
    }
});

// Get all orders (protected for dashboard)
orderRouter.get('/', authenticateToken, async (req, res) => {
    try {
        const orders = await Order.find({}).populate('items.menuItemId'); // Populate menu item details
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Error fetching orders.', error: error.message });
    }
});

// Get a single order by ID (protected for dashboard)
orderRouter.get('/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        const order = await Order.findById(id).populate('items.menuItemId');
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json(order);
    } catch (error) {
        console.error('Error fetching order by ID:', error);
        res.status(500).json({ message: 'Error fetching order.', error: error.message });
    }
});

// Update order status (protected for dashboard)
orderRouter.put('/:id/status', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // Expected status: 'Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'
    try {
        const updatedOrder = await Order.findByIdAndUpdate(id, { status }, { new: true });
        if (!updatedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({ message: 'Order status updated successfully!', order: updatedOrder });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(400).json({ message: 'Error updating order status.', error: error.message });
    }
});

// --- WhatsApp Web QR Code Endpoint ---
app.get('/api/whatsapp/qr', (req, res) => {
    res.json({ qrCode: qrCodeData });
});

// --- Webhook Endpoint for WhatsApp (if using a proper webhook service like Twilio/MessageBird) ---
app.post('/webhook/whatsapp', (req, res) => {
    console.log('Received webhook event:', req.body);
    // Process incoming WhatsApp messages here if using an external webhook provider
    res.status(200).send('Webhook received!');
});


// --- Serve Static Frontend Files (for Koyeb deployment) ---
// This serves your HTML dashboard from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// For any other routes not matched by API endpoints, serve the index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Error Handling Middleware ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// --- Server Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { // Use server.listen for socket.io
    console.log(`Server running on port ${PORT}`);
    console.log(`Dashboard served from /`);
    console.log(`WhatsApp QR code available at ${API_BASE_URL}/api/whatsapp/qr`);
    console.log('Remember to set JWT_SECRET, MENU_URL, FAQ_URL, REMINDER_INTERVAL_DAYS, and ADMIN_WHATSAPP_NUMBER in your .env file!');
});

// --- Socket.IO Connection ---
io.on('connection', (socket) => {
    console.log('A dashboard client connected via Socket.IO');
    // Send current QR code data to newly connected client
    socket.emit('qr', qrCodeData);

    socket.on('disconnect', () => {
        console.log('A dashboard client disconnected');
    });
});

// --- Initial Admin User Creation (Optional, for first run) ---
async function createDefaultAdminUser() {
    try {
        const adminUser = await User.findOne({ username: 'admin' });
        if (!adminUser) {
            const newAdmin = new User({ username: 'admin', password: 'adminpassword' }); // Change this password!
            await newAdmin.save();
            console.log('Default admin user "admin" created with password "adminpassword". PLEASE CHANGE THIS IN PRODUCTION!');
        }
    } catch (error) {
        console.error('Error creating default admin user:', error);
    }
}
// Call this function after MongoDB connection is established
mongoose.connection.once('open', () => {
    createDefaultAdminUser();
});

