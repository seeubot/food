const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// MongoDB connection
const MONGO_URI = 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
let db;

// Connect to MongoDB
async function connectToMongoDB() {
    try {
        const client = await MongoClient.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');
        db = client.db('foodiebot');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Helper function to generate unique order ID
const generateOrderId = () => {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `ORD${timestamp.slice(-6)}${random}`;
};

// Bot state
let botState = {
    qrCode: null,
    isAuthenticated: false,
    connectedSessions: 0,
    status: 'initializing'
};

// User session management (simplified)
const userSessions = new Map();

// WhatsApp Client with enhanced configuration
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './whatsapp-session'
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
            '--disable-gpu'
        ]
    }
});

// WhatsApp Event Handlers
client.on('qr', async (qr) => {
    console.log('\n🔄 Generating QR Code...');
    console.log('📱 QR Code generated - Scan with WhatsApp to connect');
    console.log('🌐 QR Code available at: http://localhost:3000/qr');
    console.log('📋 Admin Panel: http://localhost:3000');
    console.log('\n' + '='.repeat(50));
    
    try {
        botState.qrCode = await qrcode.toDataURL(qr);
        botState.isAuthenticated = false;
        botState.status = 'waiting_for_scan';
        console.log('✅ QR Code generated successfully!');
        
        // Also generate QR in terminal (optional)
        const qrTerminal = await qrcode.toString(qr, { type: 'terminal', small: true });
        console.log('\n📱 Scan this QR code with WhatsApp:');
        console.log(qrTerminal);
        console.log('\n' + '='.repeat(50));
        
    } catch (error) {
        console.error('❌ Error generating QR code:', error);
    }
});

client.on('ready', () => {
    console.log('\n🎉 SUCCESS! WhatsApp bot is ready and connected!');
    console.log('✅ Bot is now active and can receive messages');
    console.log('📱 Phone number connected:', client.info?.wid?.user || 'Unknown');
    console.log('🤖 Bot name:', client.info?.pushname || 'Unknown');
    botState.isAuthenticated = true;
    botState.connectedSessions = 1;
    botState.qrCode = null;
    botState.status = 'connected';
});

client.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated successfully');
    botState.isAuthenticated = true;
    botState.status = 'authenticated';
});

client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    botState.isAuthenticated = false;
    botState.qrCode = null;
    botState.status = 'auth_failed';
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
    botState.isAuthenticated = false;
    botState.connectedSessions = 0;
    botState.status = 'disconnected';
});

client.on('loading_screen', (percent, message) => {
    console.log('⏳ Loading WhatsApp...', percent + '%', message);
});

// Helper function to get or create user profile
const getUserProfile = async (userPhone) => {
    let user = await db.collection('users').findOne({ phone: userPhone });
    if (!user) {
        user = {
            phone: userPhone,
            name: null,
            address: null,
            isProfileComplete: false,
            createdAt: new Date()
        };
        await db.collection('users').insertOne(user);
    }
    return user;
};

// Helper function to update user profile
const updateUserProfile = async (userPhone, updates) => {
    await db.collection('users').updateOne(
        { phone: userPhone },
        { $set: { ...updates, updatedAt: new Date() } }
    );
};

// Helper function to send welcome message with web order link
const sendWelcomeMessage = async (message) => {
    const orderLink = `${process.env.BASE_URL || 'http://localhost:3000'}/order`;
    const welcomeText = `🍽️ *Welcome to FoodieBot!* 🤖

Hello! I'm your personal food ordering assistant.

🌐 *Place Your Order Online:*
${orderLink}

📱 *Quick Commands:*
🔗 Type *"order"* - Get the order link
👤 Type *"profile"* - View/Edit your profile  
📋 Type *"orders"* - View your order history
💳 Type *"payments"* - View payment options
ℹ️ Type *"help"* - See this message again

🚀 *Click the link above to browse our menu and place your order!*

Let's get started! 🍕🍔🍜`;

    message.reply(welcomeText);
};

// Helper function to send order link
const sendOrderLink = async (message) => {
    const orderLink = `${process.env.BASE_URL || 'http://localhost:3000'}/order`;
    const orderText = `🛒 *Place Your Order*

Click the link below to browse our delicious menu and place your order:

🔗 *Order Link:* ${orderLink}

📱 The link will open in your browser where you can:
• Browse our full menu with images
• Add items to your cart
• Enter delivery details
• Choose payment method
• Track your order

💡 *Tip:* Bookmark this link for easy future ordering!

🙏 Thank you for choosing FoodieBot!`;

    message.reply(orderText);
};

// Helper function to get user session state
const getUserSession = (userPhone) => {
    if (!userSessions.has(userPhone)) {
        userSessions.set(userPhone, { state: 'default', data: {} });
    }
    return userSessions.get(userPhone);
};

// Helper function to set user session state
const setUserSession = (userPhone, state, data = {}) => {
    userSessions.set(userPhone, { state, data });
};

// Main message handler
client.on('message', async (message) => {
    try {
        const userPhone = message.from;
        const messageText = message.body.toLowerCase().trim();
        
        // Get user profile and session
        const user = await getUserProfile(userPhone);
        const session = getUserSession(userPhone);
        
        console.log(`📱 Message from ${userPhone}: ${message.body}`);
        
        // Handle profile completion flow
        if (session.state === 'awaiting_name') {
            await updateUserProfile(userPhone, { name: message.body.trim() });
            setUserSession(userPhone, 'awaiting_address');
            message.reply('👤 Great! Now please provide your delivery address:');
            return;
        }
        
        if (session.state === 'awaiting_address') {
            await updateUserProfile(userPhone, { 
                address: message.body.trim(),
                isProfileComplete: true 
            });
            setUserSession(userPhone, 'default');
            const orderLink = `${process.env.BASE_URL || 'http://localhost:3000'}/order`;
            message.reply(`✅ Profile completed! Now you can place orders.\n\n🔗 Order here: ${orderLink}`);
            return;
        }
        
        // Handle profile editing
        if (session.state === 'editing_name') {
            await updateUserProfile(userPhone, { name: message.body.trim() });
            setUserSession(userPhone, 'default');
            message.reply('✅ Name updated successfully!');
            return;
        }
        
        if (session.state === 'editing_address') {
            await updateUserProfile(userPhone, { address: message.body.trim() });
            setUserSession(userPhone, 'default');
            message.reply('✅ Address updated successfully!');
            return;
        }
        
        // Main command handling
        if (messageText === 'hi' || messageText === 'hello' || messageText === 'start') {
            await sendWelcomeMessage(message);
            return;
        }
        
        // Removed 'menu' command - only 'order' now
        if (messageText === 'order') {
            await sendOrderLink(message);
            return;
        }
        
        if (messageText === 'help') {
            await sendWelcomeMessage(message);
            return;
        }
        
        if (messageText === 'profile') {
            const updatedUser = await getUserProfile(userPhone);
            let profileText = '👤 *Your Profile*\n\n';
            profileText += `📱 Phone: ${userPhone}\n`;
            profileText += `👤 Name: ${updatedUser.name || 'Not set'}\n`;
            profileText += `📍 Address: ${updatedUser.address || 'Not set'}\n\n`;
            profileText += `✏️ To edit:\n`;
            profileText += `• Type "edit name" to change name\n`;
            profileText += `• Type "edit address" to change address`;
            message.reply(profileText);
            return;
        }
        
        if (messageText === 'edit name') {
            setUserSession(userPhone, 'editing_name');
            message.reply('👤 Please enter your new name:');
            return;
        }
        
        if (messageText === 'edit address') {
            setUserSession(userPhone, 'editing_address');
            message.reply('📍 Please enter your new address:');
            return;
        }
        
        if (messageText === 'orders' || messageText === 'my orders') {
            try {
                const userOrders = await db.collection('orders')
                    .find({ userPhone })
                    .sort({ createdAt: -1 })
                    .limit(5)
                    .toArray();
                
                if (userOrders.length === 0) {
                    const orderLink = `${process.env.BASE_URL || 'http://localhost:3000'}/order`;
                    message.reply(`📋 You haven't placed any orders yet.\n\n🔗 Place your first order: ${orderLink}`);
                    return;
                }
                
                let ordersText = '📋 *Your Recent Orders*\n\n';
                userOrders.forEach((order, index) => {
                    const date = order.createdAt.toLocaleDateString();
                    const time = order.createdAt.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                    ordersText += `${index + 1}. *${order.orderId}*\n`;
                    ordersText += `   💰 ₹${order.total} • ${order.status}\n`;
                    ordersText += `   📅 ${date} ${time}\n\n`;
                });
                
                const orderLink = `${process.env.BASE_URL || 'http://localhost:3000'}/order`;
                ordersText += `🔗 Place new order: ${orderLink}`;
                
                message.reply(ordersText);
            } catch (error) {
                console.error('Error fetching user orders:', error);
                message.reply('❌ Sorry, unable to fetch your orders right now.');
            }
            return;
        }
        
        if (messageText === 'payments') {
            const paymentText = `💳 *Payment Options*\n\n💰 *Cash on Delivery (COD)*\n• Pay when your order arrives\n• No advance payment required\n\n🏦 *Online Payment*\n• UPI: foodiebot@upi\n• PhonePe: 9876543210\n• GPay: 9876543210\n\n📞 For payment issues, contact: 9876543210`;
            message.reply(paymentText);
            return;
        }
        
        // Handle numbers or any other input - redirect to web ordering
        const orderLink = `${process.env.BASE_URL || 'http://localhost:3000'}/order`;
        
        // If user sends numbers or any unrecognized command
        if (messageText.match(/\d+/g) || messageText.includes('menu')) {
            message.reply(`🛒 To place your order and browse our menu, please use our web interface:\n\n🔗 ${orderLink}\n\n📱 This will open in your browser where you can easily browse items and add them to your cart!`);
            return;
        }
        
        // Default response for unrecognized commands
        message.reply(`❓ I didn't understand that command.\n\nType "help" to see all available commands.\n\n🔗 Or place an order directly: ${orderLink}`);
        
    } catch (error) {
        console.error('Error handling message:', error);
        message.reply('❌ Sorry, something went wrong. Please try again.');
    }
});

// API Routes

// Get bot status
app.get('/api/status', (req, res) => {
    res.json(botState);
});

// Get QR code for WhatsApp connection - Enhanced endpoint
app.get('/api/qr', (req, res) => {
    res.json({ 
        qrCode: botState.qrCode,
        status: botState.status,
        isAuthenticated: botState.isAuthenticated
    });
});

// New QR page route
app.get('/qr', (req, res) => {
    const qrPageHTML = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp QR Code - FoodieBot</title>
        <style>
            body { 
                font-family: Arial, sans-serif; 
                text-align: center; 
                padding: 20px; 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                min-height: 100vh;
                margin: 0;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
            }
            .container {
                background: rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(10px);
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
                border: 1px solid rgba(255, 255, 255, 0.18);
                max-width: 500px;
                width: 100%;
            }
            .qr-container {
                background: white;
                padding: 20px;
                border-radius: 15px;
                margin: 20px 0;
                display: inline-block;
            }
            .status {
                margin: 20px 0;
                padding: 15px;
                border-radius: 10px;
                font-weight: bold;
            }
            .status.waiting { background: rgba(255, 193, 7, 0.3); }
            .status.connected { background: rgba(40, 167, 69, 0.3); }
            .status.error { background: rgba(220, 53, 69, 0.3); }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 FoodieBot WhatsApp Connection</h1>
            <div id="status" class="status waiting">⏳ Loading...</div>
            <div id="qr-container" class="qr-container">
                <p>Generating QR Code...</p>
            </div>
            <div id="instructions">
                <h3>📱 How to Connect:</h3>
                <ol style="text-align: left; display: inline-block;">
                    <li>Open WhatsApp on your phone</li>
                    <li>Go to Settings → Linked Devices</li>
                    <li>Tap "Link a Device"</li>
                    <li>Scan the QR code above</li>
                </ol>
            </div>
        </div>

        <script>
            async function checkQRCode() {
                try {
                    const response = await fetch('/api/qr');
                    const data = await response.json();
                    
                    const statusDiv = document.getElementById('status');
                    const qrContainer = document.getElementById('qr-container');
                    
                    if (data.isAuthenticated) {
                        statusDiv.innerHTML = '✅ Bot Connected Successfully!';
                        statusDiv.className = 'status connected';
                        qrContainer.innerHTML = '<p>✅ WhatsApp is now connected!</p>';
                    } else if (data.qrCode) {
                        statusDiv.innerHTML = '📱 Scan QR Code with WhatsApp';
                        statusDiv.className = 'status waiting';
                        qrContainer.innerHTML = '<img src="' + data.qrCode + '" alt="QR Code" style="max-width: 100%;">';
                    } else {
                        statusDiv.innerHTML = '⏳ Generating QR Code...';
                        statusDiv.className = 'status waiting';
                        qrContainer.innerHTML = '<p>Please wait...</p>';
                    }
                } catch (error) {
                    console.error('Error fetching QR code:', error);
                    document.getElementById('status').innerHTML = '❌ Error loading QR code';
                    document.getElementById('status').className = 'status error';
                }
            }

            // Check QR code every 2 seconds
            setInterval(checkQRCode, 2000);
            checkQRCode(); // Initial check
        </script>
    </body>
    </html>`;
    
    res.send(qrPageHTML);
});

// Get menu items
app.get('/api/menu', async (req, res) => {
    try {
        const menuItems = await db.collection('menu').find({ available: true }).toArray();
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu:', error);
        res.status(500).json({ error: 'Failed to fetch menu' });
    }
});

// Add menu item
app.post('/api/menu', upload.single('image'), async (req, res) => {
    try {
        const { name, description, price, category, available } = req.body;
        
        const menuItem = {
            name,
            description,
            price: parseFloat(price),
            category,
            available: available !== 'false',
            imageData: req.file ? req.file.buffer : null,
            imageType: req.file ? req.file.mimetype : null,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        const result = await db.collection('menu').insertOne(menuItem);
        res.json({ success: true, id: result.insertedId });
    } catch (error) {
        console.error('Error adding menu item:', error);
        res.status(500).json({ error: 'Failed to add menu item' });
    }
});

// Update menu item
app.put('/api/menu/:id', upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, price, category, available } = req.body;
        
        const updateData = {
            name,
            description,
            price: parseFloat(price),
            category,
            available: available !== 'false',
            updatedAt: new Date()
        };
        
        if (req.file) {
            updateData.imageData = req.file.buffer;
            updateData.imageType = req.file.mimetype;
        }
        
        await db.collection('menu').updateOne(
            { _id: new ObjectId(id) },
            { $set: updateData }
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating menu item:', error);
        res.status(500).json({ error: 'Failed to update menu item' });
    }
});

// Delete menu item
app.delete('/api/menu/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('menu').deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting menu item:', error);
        res.status(500).json({ error: 'Failed to delete menu item' });
    }
});

// Get menu item image
app.get('/api/menu/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        const menuItem = await db.collection('menu').findOne({ _id: new ObjectId(id) });
        
        if (!menuItem || !menuItem.imageData) {
            return res.status(404).json({ error: 'Image not found' });
        }
        
        res.set('Content-Type', menuItem.imageType);
        res.send(menuItem.imageData);
    } catch (error) {
        console.error('Error fetching image:', error);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// Save order from web interface
app.post('/api/orders', async (req, res) => {
    try {
        const { userPhone, userName, userAddress, items, total, paymentMethod } = req.body;
        
        const orderId = generateOrderId();
        
        const order = {
            orderId,
            userPhone,
            userName,
            userAddress,
            items,
            total,
            paymentMethod: paymentMethod || 'COD',
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        await db.collection('orders').insertOne(order);
        
        // Update user profile if provided
        if (userName || userAddress) {
            await updateUserProfile(userPhone, {
                name: userName,
                address: userAddress,
                isProfileComplete: true
            });
        }
        
        res.json({ success: true, orderId });
    } catch (error) {
        console.error('Error saving order:', error);
        res.status(500).json({ error: 'Failed to save order' });
    }
});

// Get orders
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await db.collection('orders')
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Update order status
app.put('/api/orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        await db.collection('orders').updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date() } }
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Failed to update order status' });
    }
});

// Get users
app.get('/api/users', async (req, res) => {
    try {
        const users = await db.collection('users')
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Serve static files
app.use(express.static('public'));

// Serve the admin panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the order page (main ordering interface)
app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File size too large' });
        }
    }
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize the application
async function initializeApp() {
    try {
        console.log('🚀 Starting FoodieBot...');
        
        // Connect to MongoDB first
        await connectToMongoDB();
        
        // Start the Express server
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log('\n' + '='.repeat(60));
            console.log('🎉 FoodieBot Server Started Successfully!');
            console.log('='.repeat(60));
            console.log(`🌐 Server running on: http://localhost:${PORT}`);
            console.log(`📋 Admin Panel: http://localhost:${PORT}`);
            console.log(`🛒 Order Interface: http://localhost:${PORT}/order`);
            console.log(`📱 QR Code Page: http://localhost:${PORT}/qr`);
            console.log('='.repeat(60));
            console.log('\n⏳ Initializing WhatsApp client...');
        });
        
        // Initialize WhatsApp client
        console.log('🔄 Starting WhatsApp client initialization...');
        client.initialize();
        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n📱 Shutting down WhatsApp bot...');
    try {
        await client.destroy();
        console.log('✅ WhatsApp client destroyed successfully');
    } catch (error) {
        console.error('❌ Error destroying WhatsApp client:', error);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n📱 Received SIGTERM, shutting down gracefully...');
    try {
        await client.destroy();
        console.log('✅ WhatsApp client destroyed successfully');
    } catch (error) {
        console.error('❌ Error destroying WhatsApp client:', error);
    }
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Start the application
initializeApp();
