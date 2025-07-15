// server.js
// This is the main entry point for the Node.js backend server.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const http = require('http'); // Required for socket.io
const socketIo = require('socket.io'); // For real-time QR code updates
const path = require('path'); // For serving static files
// Removed bcrypt and jwt as they are no longer needed without JWT authentication
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
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

// User Model for Dashboard Login - REMOVED AS JWT AUTHENTICATION IS REMOVED
// const UserSchema = new mongoose.Schema({
//     username: { type: String, required: true, unique: true },
//     password: { type: String, required: true },
// });

// Hash password before saving - REMOVED
// UserSchema.pre('save', async function (next) {
//     if (this.isModified('password')) {
//         this.password = await bcrypt.hash(this.password, 10);
//     }
//     next();
// });
// const User = mongoose.model('User', UserSchema);


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

// --- Authentication Middleware --- REMOVED
// const authenticateToken = (req, res, next) => {
//     const authHeader = req.headers['authorization'];
//     const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

//     if (!token) return res.status(401).json({ message: 'Access Denied: No token provided!' });

//     jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret_key', (err, user) => {
//         if (err) return res.status(403).json({ message: 'Access Denied: Invalid token!' });
//         req.user = user;
//         next();
//     });
// };

// --- WhatsApp Web JS Client 1 Setup ---
let qrCodeImageBase64_1 = null; // Stores QR code image data (base64) for client 1
let whatsappStatusMessage_1 = 'Initializing WhatsApp Client 1...'; // Stores status message for client 1
let whatsappClient_1; // WhatsApp client instance 1
let isWhatsappClientReady_1 = false; // Flag to indicate client 1 readiness

// Function to emit current QR and status for client 1 to all connected Socket.IO clients
const emitQrAndStatus1 = () => {
    io.emit('qr1', { // Using 'qr1' event for client 1
        image: qrCodeImageBase64_1,
        status: whatsappStatusMessage_1,
        isReady: isWhatsappClientReady_1
    });
};

const initializeWhatsappClient1 = () => {
    console.log('Initializing WhatsApp Client 1...');
    whatsappStatusMessage_1 = 'Initializing WhatsApp Client 1...';
    qrCodeImageBase64_1 = null;
    isWhatsappClientReady_1 = false;
    emitQrAndStatus1(); // Emit initial state for client 1

    try {
        whatsappClient_1 = new Client({
            authStrategy: new LocalAuth({ clientId: 'whatsapp-bot-1' }), // Unique clientId for bot 1
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

        whatsappClient_1.on('qr', async (qr) => {
            console.log('QR 1 RECEIVED', qr);
            qrCodeImageBase64_1 = await qrcode.toDataURL(qr); // Convert QR string to data URL
            whatsappStatusMessage_1 = 'Scan this QR code for Bot 1 with your WhatsApp app.';
            isWhatsappClientReady_1 = false;
            emitQrAndStatus1(); // Emit QR code to connected dashboard clients
        });

        whatsappClient_1.on('ready', () => {
            console.log('WhatsApp Client 1 is ready!');
            qrCodeImageBase64_1 = null; // Clear QR image once ready
            whatsappStatusMessage_1 = 'WhatsApp Client 1 is ready!';
            isWhatsappClientReady_1 = true;
            emitQrAndStatus1(); // Inform dashboard
        });

        whatsappClient_1.on('authenticated', () => {
            console.log('WhatsApp Client 1 Authenticated');
            qrCodeImageBase64_1 = null; // Clear QR image once authenticated
            whatsappStatusMessage_1 = 'WhatsApp Client 1 Authenticated!';
            isWhatsappClientReady_1 = true;
            emitQrAndStatus1();
        });

        whatsappClient_1.on('auth_failure', msg => {
            console.error('AUTHENTICATION FAILURE 1', msg);
            qrCodeImageBase64_1 = null;
            whatsappStatusMessage_1 = `Auth Failure 1: ${msg}`;
            isWhatsappClientReady_1 = false;
            emitQrAndStatus1();
        });

        whatsappClient_1.on('disconnected', (reason) => {
            console.log('WhatsApp Client 1 Disconnected', reason);
            qrCodeImageBase64_1 = null;
            whatsappStatusMessage_1 = `Disconnected 1: ${reason}. Reconnecting...`;
            isWhatsappClientReady_1 = false;
            emitQrAndStatus1();
            // Attempt to re-initialize or restart the client
            console.log('Attempting to re-initialize WhatsApp Client 1 in 5 seconds...');
            setTimeout(() => initializeWhatsappClient1(), 5000); // Try to re-initialize after 5 seconds
        });

        whatsappClient_1.on('message', async (msg) => {
            console.log('MESSAGE RECEIVED (Bot 1)', msg.body);

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

        whatsappClient_1.initialize();
    } catch (error) {
        console.error('Error initializing WhatsApp Client 1:', error);
        whatsappStatusMessage_1 = `Initialization Error 1: ${error.message}. Check server logs.`;
        qrCodeImageBase64_1 = null;
        isWhatsappClientReady_1 = false;
        emitQrAndStatus1();
        // Attempt to re-initialize after a delay
        console.log('Attempting to re-initialize WhatsApp Client 1 after an error in 10 seconds...');
        setTimeout(() => initializeWhatsappClient1(), 10000);
    }
};

// --- WhatsApp Web JS Client 2 Setup ---
let qrCodeImageBase64_2 = null; // Stores QR code image data (base64) for client 2
let whatsappStatusMessage_2 = 'Initializing WhatsApp Client 2...'; // Stores status message for client 2
let whatsappClient_2; // WhatsApp client instance 2
let isWhatsappClientReady_2 = false; // Flag to indicate client 2 readiness

// Function to emit current QR and status for client 2 to all connected Socket.IO clients
const emitQrAndStatus2 = () => {
    io.emit('qr2', { // Using 'qr2' event for client 2
        image: qrCodeImageBase64_2,
        status: whatsappStatusMessage_2,
        isReady: isWhatsappClientReady_2
    });
};

const initializeWhatsappClient2 = () => {
    console.log('Initializing WhatsApp Client 2...');
    whatsappStatusMessage_2 = 'Initializing WhatsApp Client 2...';
    qrCodeImageBase64_2 = null;
    isWhatsappClientReady_2 = false;
    emitQrAndStatus2(); // Emit initial state for client 2

    try {
        whatsappClient_2 = new Client({
            authStrategy: new LocalAuth({ clientId: 'whatsapp-bot-2' }), // Unique clientId for bot 2
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

        whatsappClient_2.on('qr', async (qr) => {
            console.log('QR 2 RECEIVED', qr);
            qrCodeImageBase64_2 = await qrcode.toDataURL(qr); // Convert QR string to data URL
            whatsappStatusMessage_2 = 'Scan this QR code for Bot 2 with your WhatsApp app.';
            isWhatsappClientReady_2 = false;
            emitQrAndStatus2(); // Emit QR code to connected dashboard clients
        });

        whatsappClient_2.on('ready', () => {
            console.log('WhatsApp Client 2 is ready!');
            qrCodeImageBase64_2 = null; // Clear QR image once ready
            whatsappStatusMessage_2 = 'WhatsApp Client 2 is ready!';
            isWhatsappClientReady_2 = true;
            emitQrAndStatus2(); // Inform dashboard
        });

        whatsappClient_2.on('authenticated', () => {
            console.log('WhatsApp Client 2 Authenticated');
            qrCodeImageBase64_2 = null; // Clear QR image once authenticated
            whatsappStatusMessage_2 = 'WhatsApp Client 2 Authenticated!';
            isWhatsappClientReady_2 = true;
            emitQrAndStatus2();
        });

        whatsappClient_2.on('auth_failure', msg => {
            console.error('AUTHENTICATION FAILURE 2', msg);
            qrCodeImageBase64_2 = null;
            whatsappStatusMessage_2 = `Auth Failure 2: ${msg}`;
            isWhatsappClientReady_2 = false;
            emitQrAndStatus2();
        });

        whatsappClient_2.on('disconnected', (reason) => {
            console.log('WhatsApp Client 2 Disconnected', reason);
            qrCodeImageBase64_2 = null;
            whatsappStatusMessage_2 = `Disconnected 2: ${reason}. Reconnecting...`;
            isWhatsappClientReady_2 = false;
            emitQrAndStatus2();
            // Attempt to re-initialize or restart the client
            console.log('Attempting to re-initialize WhatsApp Client 2 in 5 seconds...');
            setTimeout(() => initializeWhatsappClient2(), 5000); // Try to re-initialize after 5 seconds
        });

        // No message handling for client 2 by default, but can be added here
        whatsappClient_2.on('message', async (msg) => {
            console.log('MESSAGE RECEIVED (Bot 2):', msg.body);
            // You can add distinct message handling logic for Bot 2 here if needed
            // For example:
            // if (msg.body.toLowerCase() === 'status') {
            //     msg.reply('Bot 2 is active and ready!');
            // }
        });

        whatsappClient_2.initialize();
    } catch (error) {
        console.error('Error initializing WhatsApp Client 2:', error);
        whatsappStatusMessage_2 = `Initialization Error 2: ${error.message}. Check server logs.`;
        qrCodeImageBase64_2 = null;
        isWhatsappClientReady_2 = false;
        emitQrAndStatus2();
        // Attempt to re-initialize after a delay
        console.log('Attempting to re-initialize WhatsApp Client 2 after an error in 10 seconds...');
        setTimeout(() => initializeWhatsappClient2(), 10000);
    }
};


// Initialize both WhatsApp clients on server start
initializeWhatsappClient1();
initializeWhatsappClient2();


// --- Scheduled Notification Function ---
const sendOrderReminderNotifications = async () => {
    // This function will use client 1 (the primary bot) for notifications
    if (!isWhatsappClientReady_1) {
        console.log('WhatsApp client 1 not ready for sending scheduled notifications.');
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
                        await whatsappClient_1.sendMessage(customerId, message); // Use client 1
                        console.log(`Sent reminder to ${customerId} (last ordered ${daysDiff} days ago) via Bot 1.`);
                    } catch (sendError) {
                        console.error(`Failed to send reminder to ${customerId} via Bot 1:`, sendError);
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
    // This function will use client 1 (the primary bot) for notifications
    if (!isWhatsappClientReady_1) {
        console.log('WhatsApp client 1 not ready for sending admin notifications.');
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
        await whatsappClient_1.sendMessage(formattedAdminNumber, notificationMessage); // Use client 1
        console.log(`Admin notified about new order: ${order._id} via Bot 1`);
    } catch (error) {
        console.error(`Failed to send new order notification to admin (${adminNumber}) via Bot 1:`, error);
    }
};


// --- API Endpoints (URL Rewriting using Express Router) ---

// Auth Routes - REMOVED AS JWT AUTHENTICATION IS REMOVED
// const authRouter = express.Router();
// app.use('/api/auth', authRouter);

// authRouter.post('/register', async (req, res) => { /* ... */ });
// authRouter.post('/login', async (req, res) => { /* ... */ });

// Menu Management Routes
const menuRouter = express.Router();
app.use('/api/menu', menuRouter); // No authentication for fetching menu items on public menu

// Get all menu items (PUBLIC)
menuRouter.get('/', async (req, res) => {
    try {
        const menuItems = await MenuItem.find({});
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu items:', error);
        res.status(500).json({ message: 'Error fetching menu items.', error: error.message });
    }
});

// Add a new menu item (NOW PUBLIC - WAS PROTECTED)
// WARNING: This endpoint is now publicly accessible. Anyone can add menu items.
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

// Update a menu item (NOW PUBLIC - WAS PROTECTED)
// WARNING: This endpoint is now publicly accessible. Anyone can update menu items.
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

// Delete a menu item (NOW PUBLIC - WAS PROTECTED)
// WARNING: This endpoint is now publicly accessible. Anyone can delete menu items.
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

// Endpoint for placing a new order from the web menu (ALREADY PUBLIC)
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
                // Improved error message to include specific item ID for debugging
                return res.status(400).json({ message: `Item with ID "${item.itemId}" not found or not available.` });
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

        // Notify admin about the new order (using primary bot)
        await notifyAdminOfNewOrder(newOrder);

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });
    } catch (error) {
        console.error('Error placing new order:', error);
        res.status(500).json({ message: 'Error placing order.', error: error.message });
    }
});

// Get all orders (NOW PUBLIC - WAS PROTECTED)
// WARNING: This endpoint is now publicly accessible. Anyone can view all orders.
orderRouter.get('/', async (req, res) => {
    try {
        const orders = await Order.find({}).populate('items.menuItemId'); // Populate menu item details
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Error fetching orders.', error: error.message });
    }
});

// Get a single order by ID (NOW PUBLIC - WAS PROTECTED)
// WARNING: This endpoint is now publicly accessible. Anyone can view any order by ID.
orderRouter.get('/:id', async (req, res) => {
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

// Update order status (NOW PUBLIC - WAS PROTECTED)
// WARNING: This endpoint is now publicly accessible. Anyone can change the status of any order.
orderRouter.put('/:id/status', async (req, res) => {
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

// --- WhatsApp Web QR Code Endpoints (ALREADY PUBLIC) ---
app.get('/api/whatsapp/qr1', (req, res) => {
    res.json({
        image: qrCodeImageBase64_1,
        status: whatsappStatusMessage_1,
        isReady: isWhatsappClientReady_1
    });
});

app.get('/api/whatsapp/qr2', (req, res) => {
    res.json({
        image: qrCodeImageBase64_2,
        status: whatsappStatusMessage_2,
        isReady: isWhatsappClientReady_2
    });
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
    console.log(`WhatsApp QR code endpoint 1: /api/whatsapp/qr1`);
    console.log(`WhatsApp QR code endpoint 2: /api/whatsapp/qr2`);
    console.log('--- WARNING: JWT AUTHENTICATION HAS BEEN REMOVED. ALL DASHBOARD APIs ARE NOW PUBLICLY ACCESSIBLE. ---');
    console.log('Remember to set MENU_URL, FAQ_URL, REMINDER_INTERVAL_DAYS, and ADMIN_WHATSAPP_NUMBER in your .env file!');
});

// --- Socket.IO Connection ---
io.on('connection', (socket) => {
    console.log('A dashboard client connected via Socket.IO');
    // Send current QR and status data for both clients to newly connected client
    emitQrAndStatus1();
    emitQrAndStatus2();

    socket.on('disconnect', () => {
        console.log('A dashboard client disconnected');
    });
});

// --- Initial Admin User Creation (Optional, for first run) - REMOVED AS USER MODEL IS REMOVED ---
// async function createDefaultAdminUser() { /* ... */ }
// mongoose.connection.once('open', () => {
//     createDefaultAdminUser();
// });
