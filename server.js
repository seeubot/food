const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// MongoDB connection
const MONGO_URI = 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
let db;

// Connect to MongoDB
MongoClient.connect(MONGO_URI)
    .then(client => {
        console.log('✅ Connected to MongoDB');
        db = client.db('foodiebot');
    })
    .catch(error => console.error('❌ MongoDB connection error:', error));

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
    connectedSessions: 0
};

// User cart state and session management
const userCarts = new Map();
const userSessions = new Map(); // Track user conversation state

// WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true }
});

// WhatsApp Event Handlers
client.on('qr', async (qr) => {
    console.log('📱 QR Code generated - Scan with WhatsApp to connect');
    console.log('QR Code available at: http://localhost:3000 -> QR Code tab');
    botState.qrCode = await qrcode.toDataURL(qr);
    botState.isAuthenticated = false;
});

client.on('ready', () => {
    console.log('✅ WhatsApp bot is ready and connected!');
    botState.isAuthenticated = true;
    botState.connectedSessions = 1;
    botState.qrCode = null;
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated successfully');
    botState.isAuthenticated = true;
});

client.on('auth_failure', (msg) => {
    console.log('❌ WhatsApp authentication failed:', msg);
    botState.isAuthenticated = false;
    botState.qrCode = null;
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
    botState.isAuthenticated = false;
    botState.connectedSessions = 0;
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

// Helper function to send welcome message with order URL
const sendWelcomeMessage = (message) => {
    const welcomeText = `🍽️ *Welcome to FoodieBot!* 🤖

Hello! I'm your personal food ordering assistant.

🌐 *ORDER NOW:*
Click here to browse our menu and place your order:
👆 https://random-tiena-school1660440-c68d25b7.koyeb.app/order.html

📦 Type *"cart"* - View your current order
✅ Type *"confirm"* - Place your order
👤 Type *"profile"* - View/Edit your profile
ℹ️ Type *"help"* - See this message again

Let's get started! Click the link above to see what delicious items we have available today! 🍕🍔🍜`;

    message.reply(welcomeText);
};

// Helper function to collect user details
const collectUserDetails = async (message, userPhone, userProfile) => {
    const session = userSessions.get(userPhone) || {};
    
    if (!userProfile.name) {
        userSessions.set(userPhone, { ...session, state: 'collecting_name' });
        message.reply('👋 Welcome! To complete your profile, please tell me your *full name*:');
        return true;
    }
    
    if (!userProfile.address) {
        userSessions.set(userPhone, { ...session, state: 'collecting_address' });
        message.reply('📍 Please provide your *delivery address*:\n\n(Include full address with landmark for accurate delivery)');
        return true;
    }
    
    return false; // Profile is complete
};

// Helper function to handle profile completion
const handleProfileCompletion = async (message, userPhone, messageBody) => {
    const session = userSessions.get(userPhone) || {};
    
    if (session.state === 'collecting_name') {
        await updateUserProfile(userPhone, { name: messageBody });
        userSessions.set(userPhone, { ...session, state: 'collecting_address' });
        message.reply('✅ Name saved!\n\n📍 Now please provide your *delivery address*:\n\n(Include full address with landmark for accurate delivery)');
        return true;
    }
    
    if (session.state === 'collecting_address') {
        await updateUserProfile(userPhone, { 
            address: messageBody,
            isProfileComplete: true 
        });
        userSessions.set(userPhone, { ...session, state: null });
        message.reply('✅ *Profile completed successfully!*\n\n🌐 *ORDER NOW:*\nClick here to browse our menu and place your order:\n👆 https://your-restaurant-website.com/order');
        return true;
    }
    
    return false;
};

// Payment verification helper
const handlePaymentVerification = async (message, userPhone, messageBody) => {
    const session = userSessions.get(userPhone) || {};
    
    if (session.state === 'awaiting_upi_proof') {
        // Check if message has attachment (screenshot)
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media.mimetype.startsWith('image/')) {
                // Save payment proof
                const paymentProof = {
                    orderId: session.pendingOrderId,
                    customerPhone: userPhone,
                    paymentMethod: 'UPI',
                    proofType: 'screenshot',
                    mediaData: media.data,
                    timestamp: new Date(),
                    status: 'pending_verification'
                };
                
                await db.collection('payment_proofs').insertOne(paymentProof);
                
                // Update order status
                await db.collection('orders').updateOne(
                    { _id: new ObjectId(session.pendingOrderId) },
                    { $set: { paymentStatus: 'verification_pending', paymentProofId: paymentProof._id } }
                );
                
                userSessions.set(userPhone, { ...session, state: null, pendingOrderId: null });
                
                message.reply('✅ *Payment screenshot received!*\n\n🔍 Your payment is under verification. We\'ll confirm your order once payment is verified.\n\nThank you for choosing FoodieBot! 🍽️');
                return true;
            }
        }
        
        // Check if it's UTR number (12 digits)
        if (/^\d{12}$/.test(messageBody)) {
            const paymentProof = {
                orderId: session.pendingOrderId,
                customerPhone: userPhone,
                paymentMethod: 'UPI',
                proofType: 'utr',
                utrNumber: messageBody,
                timestamp: new Date(),
                status: 'pending_verification'
            };
            
            await db.collection('payment_proofs').insertOne(paymentProof);
            
            await db.collection('orders').updateOne(
                { _id: new ObjectId(session.pendingOrderId) },
                { $set: { paymentStatus: 'verification_pending', paymentProofId: paymentProof._id } }
            );
            
            userSessions.set(userPhone, { ...session, state: null, pendingOrderId: null });
            
            message.reply(`✅ *UTR Number received!*\n\nUTR: ${messageBody}\n\n🔍 Your payment is under verification. We\'ll confirm your order once payment is verified.\n\nThank you for choosing FoodieBot! 🍽️`);
            return true;
        }
        
        message.reply('❌ Please send either:\n• Payment screenshot (image)\n• 12-digit UTR number\n\nOr type "cod" to switch to Cash on Delivery');
        return true;
    }
    
    return false;
};

// Payment options helper
const showPaymentOptions = (message, total, orderId) => {
    const paymentText = `💳 *Payment Options*\n\n💰 Total Amount: ₹${total}\n\n*Choose your payment method:*\n\n🏦 *UPI Payment*\nType "upi" to pay via UPI\n• PhonePe: 9876543210\n• Google Pay: 9876543210\n• Paytm: 9876543210\n\n💵 *Cash on Delivery*\nType "cod" for cash payment on delivery\n\nPlease select your preferred payment method:`;
    
    message.reply(paymentText);
};

// Message handler
client.on('message', async (message) => {
    const chat = await message.getChat();
    const contact = await message.getContact();
    const userPhone = contact.number;
    const messageBody = message.body.toLowerCase().trim();
    
    try {
        // Initialize user cart if doesn't exist
        if (!userCarts.has(userPhone)) {
            userCarts.set(userPhone, []);
        }
        
        // Get user profile
        const userProfile = await getUserProfile(userPhone);
        
        // Handle payment verification first
        if (await handlePaymentVerification(message, userPhone, message.body)) {
            return;
        }
        
        // Handle profile completion
        if (await handleProfileCompletion(message, userPhone, message.body)) {
            return;
        }
        
        // Check if profile is complete before allowing orders
        if (!userProfile.isProfileComplete && !['hello', 'hi', 'start', 'help', 'profile', 'order'].includes(messageBody)) {
            if (await collectUserDetails(message, userPhone, userProfile)) {
                return;
            }
        }
        
        // Handle different commands
        if (messageBody === 'hello' || messageBody === 'hi' || messageBody === 'start' || messageBody === 'help') {
            sendWelcomeMessage(message);
        }
        else if (messageBody === 'order') {
            const orderText = `🌐 *ORDER NOW:*\n\nClick here to browse our menu and place your order:\n👆 https://your-restaurant-website.com/order\n\n📱 After placing your order online, return here to:\n• Track your order status\n• Make payment\n• Get delivery updates\n\nHappy ordering! 🍽️`;
            message.reply(orderText);
        }
        else if (messageBody === 'profile') {
            let profileText = '👤 *Your Profile*\n\n';
            profileText += `📱 Phone: ${userPhone}\n`;
            profileText += `👋 Name: ${userProfile.name || 'Not set'}\n`;
            profileText += `📍 Address: ${userProfile.address || 'Not set'}\n\n`;
            
            if (!userProfile.isProfileComplete) {
                profileText += '⚠️ Profile incomplete. Please complete your profile to place orders.\n\n';
                if (!userProfile.name) {
                    profileText += 'Type your *full name* to update:';
                } else if (!userProfile.address) {
                    profileText += 'Type your *delivery address* to update:';
                }
            } else {
                profileText += '✅ Profile complete!\n\n';
                profileText += 'To update:\n• Type "update name" to change name\n• Type "update address" to change address';
            }
            
            message.reply(profileText);
        }
        else if (messageBody === 'update name') {
            userSessions.set(userPhone, { state: 'collecting_name' });
            message.reply('👋 Please enter your *new name*:');
        }
        else if (messageBody === 'update address') {
            userSessions.set(userPhone, { state: 'collecting_address' });
            message.reply('📍 Please enter your *new delivery address*:');
        }
        else if (messageBody === 'cart') {
            const userCart = userCarts.get(userPhone);
            if (userCart.length === 0) {
                message.reply('🛒 Your cart is empty.\n\n🌐 *ORDER NOW:*\nClick here to browse our menu and add items:\n👆 https://your-restaurant-website.com/order');
                return;
            }
            
            let cartText = '🛒 *Your Cart*\n\n';
            let total = 0;
            
            userCart.forEach((item, index) => {
                cartText += `${index + 1}. ${item.name} x${item.quantity} - ₹${item.price * item.quantity}\n`;
                total += item.price * item.quantity;
            });
            
            cartText += `\n💰 *Total: ₹${total}*\n\n`;
            cartText += '✅ Type "confirm" to place order\n';
            cartText += '🌐 Click here to add more items:\n👆 https://your-restaurant-website.com/order';
            
            message.reply(cartText);
        }
        else if (messageBody === 'confirm') {
            const userCart = userCarts.get(userPhone);
            if (userCart.length === 0) {
                message.reply('🛒 Your cart is empty.\n\n🌐 *ORDER NOW:*\nClick here to browse our menu and add items:\n👆 https://your-restaurant-website.com/order');
                return;
            }
            
            // Calculate total
            const total = userCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            
            // Generate unique order ID
            const orderId = generateOrderId();
            
            // Create order with orderId
            const order = {
                orderId: orderId,
                customerPhone: userPhone,
                customerName: userProfile.name,
                customerAddress: userProfile.address,
                items: userCart,
                total: total,
                status: 'pending_payment',
                paymentStatus: 'pending',
                timestamp: new Date(),
                createdAt: new Date()
            };
            
            const result = await db.collection('orders').insertOne(order);
            const mongoId = result.insertedId;
            
            // Show payment options
            showPaymentOptions(message, total, mongoId);
            
            // Store order ID in session for payment processing
            const session = userSessions.get(userPhone) || {};
            userSessions.set(userPhone, { ...session, pendingOrderId: mongoId.toString() });
        }
        else if (messageBody === 'upi') {
            const session = userSessions.get(userPhone) || {};
            if (!session.pendingOrderId) {
                message.reply('❌ No pending order found. Please place an order first by typing "confirm".');
                return;
            }
            
            const order = await db.collection('orders').findOne({ _id: new ObjectId(session.pendingOrderId) });
            if (!order) {
                message.reply('❌ Order not found. Please try again.');
                return;
            }
            
            userSessions.set(userPhone, { ...session, state: 'awaiting_upi_proof' });
            
            const upiText = `🏦 *UPI Payment Details*\n\n💰 Amount: ₹${order.total}\n📋 Order ID: ${order.orderId}\n\n*Pay to any of these UPI IDs:*\n• PhonePe: 9876543210\n• Google Pay: 9876543210\n• Paytm: 9876543210\n\n📸 *After payment, send:*\n• Payment screenshot (image), OR\n• 12-digit UTR number\n\n💡 Type "cod" to switch to Cash on Delivery`;
            
            message.reply(upiText);
        }
        else if (messageBody === 'cod') {
            const session = userSessions.get(userPhone) || {};
            if (!session.pendingOrderId) {
                message.reply('❌ No pending order found. Please place an order first by typing "confirm".');
                return;
            }
            
            // Update order with COD payment
            await db.collection('orders').updateOne(
                { _id: new ObjectId(session.pendingOrderId) },
                { 
                    $set: { 
                        paymentMethod: 'COD',
                        paymentStatus: 'cod_selected',
                        status: 'confirmed',
                        confirmedAt: new Date()
                    }
                }
            );
            
            const order = await db.collection('orders').findOne({ _id: new ObjectId(session.pendingOrderId) });
            
            // Clear cart and session
            userCarts.set(userPhone, []);
            userSessions.set(userPhone, { ...session, state: null, pendingOrderId: null });
            
            // Confirmation message
            let confirmText = '✅ *Order Confirmed with Cash on Delivery!*\n\n';
            confirmText += `📋 *Order ID: ${order.orderId}*\n\n`;
            confirmText += '*Order Summary:*\n';
            order.items.forEach((item, index) => {
                confirmText += `${index + 1}. ${item.name} x${item.quantity} - ₹${item.price * item.quantity}\n`;
            });
            confirmText += `\n💰 *Total: ₹${order.total}*\n`;
            confirmText += `💵 *Payment: Cash on Delivery*\n`;
            confirmText += `📍 *Delivery Address:*\n${userProfile.address}\n\n`;
            confirmText += '🚚 Your order is being prepared. We\'ll update you soon!\n';
            confirmText += 'Thank you for choosing FoodieBot! 🍽️';
            
            message.reply(confirmText);
        }
        else {
            // Unknown command - show available options
            const helpText = `🤔 I didn't understand that command.\n\n*Available commands:*\n• "order" - Get ordering link\n• "cart" - View your cart\n• "confirm" - Place order\n• "profile" - View/Edit profile\n• "help" - Show this help\n\n🌐 *ORDER NOW:*\nClick here to browse our menu:\n👆 https://your-restaurant-website.com/order`;
            message.reply(helpText);
        }
        
        // Store session data
        await db.collection('sessions').updateOne(
            { phone: contact.number },
            { 
                $set: { 
                    phone: contact.number,
                    name: contact.name || contact.pushname || userProfile.name,
                    lastMessage: message.body,
                    lastSeen: new Date()
                }
            },
            { upsert: true }
        );
        
    } catch (error) {
        console.error('Error handling message:', error);
        message.reply('😔 Sorry, something went wrong. Please try again or contact support.');
    }
});

// API endpoint to add items to cart from web interface
app.post('/api/add-to-cart', async (req, res) => {
    try {
        const { userPhone, items } = req.body;
        
        if (!userPhone || !items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid request data' });
        }
        
        // Initialize user cart if doesn't exist
        if (!userCarts.has(userPhone)) {
            userCarts.set(userPhone, []);
        }
        
        const userCart = userCarts.get(userPhone);
        
        // Add items to cart
        items.forEach(newItem => {
            const existingItem = userCart.find(cartItem => cartItem._id.toString() === newItem._id.toString());
            
            if (existingItem) {
                existingItem.quantity += newItem.quantity || 1;
            } else {
                userCart.push({
                    _id: newItem._id,
                    name: newItem.name,
                    price: newItem.price,
                    quantity: newItem.quantity || 1
                });
            }
        });
        
        // Send confirmation message to user
        const itemNames = items.map(item => item.name).join(', ');
        const confirmMessage = `✅ *Items added to your cart!*\n\n${itemNames}\n\n💬 Return to WhatsApp and type "cart" to view your order or "confirm" to place it.`;
        
        await client.sendMessage(`${userPhone}@c.us`, confirmMessage);
        
        res.json({ success: true, message: 'Items added to cart' });
    } catch (error) {
        console.error('Error adding to cart:', error);
        res.status(500).json({ error: error.message });
    }
});

// API Routes
app.get('/api/status', (req, res) => {
    res.json({
        isAuthenticated: botState.isAuthenticated,
        connectedSessions: botState.connectedSessions,
        qrGenerated: !!botState.qrCode
    });
});

app.get('/api/qr', (req, res) => {
    if (botState.qrCode) {
        const base64Data = botState.qrCode.replace(/^data:image\/png;base64,/, '');
        const img = Buffer.from(base64Data, 'base64');
        res.writeHead(200, { 
            'Content-Type': 'image/png',
            'Content-Length': img.length 
        });
        res.end(img);
    } else {
        res.status(404).json({ 
            error: 'QR code not available',
            message: botState.isAuthenticated ? 'Already authenticated' : 'QR code not generated yet'
        });
    }
});

// Orders API
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await db.collection('orders').find().sort({ timestamp: -1 }).toArray();
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        await db.collection('orders').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status, updatedAt: new Date() } }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Payment verification API
app.get('/api/payment-proofs', async (req, res) => {
    try {
        const proofs = await db.collection('payment_proofs').find().sort({ timestamp: -1 }).toArray();
        res.json(proofs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/payment-proofs/:id/verify', async (req, res) => {
    try {
        const { verified, notes } = req.body;
        const proofId = new ObjectId(req.params.id);
        
        // Update payment proof
        await db.collection('payment_proofs').updateOne(
            { _id: proofId },
            { 
                $set: { 
                    status: verified ? 'verified' : 'rejected',
                    verificationNotes: notes,
                    verifiedAt: new Date()
                }
            }
        );
        
        // Get payment proof to find order
        const proof = await db.collection('payment_proofs').findOne({ _id: proofId });
        
        if (proof && verified) {
            // Update order status
            await db.collection('orders').updateOne(
                { _id: new ObjectId(proof.orderId) },
                { 
                    $set: { 
                        paymentStatus: 'verified',
                        status: 'confirmed',
                        confirmedAt: new Date()
                    }
                }
            );
            
            // Send confirmation to customer
            const order = await db.collection('orders').findOne({ _id: new ObjectId(proof.orderId) });
            if (order) {
                const confirmText = `✅ *Payment Verified & Order Confirmed!*\n\n📋 Order ID: ${order.orderId}\n💰 Amount: ₹${order.total}\n🚚 Your order is now being prepared.\n\nThank you for choosing FoodieBot! 🍽️`;
                await client.sendMessage(`${proof.customerPhone}@c.us`, confirmText);
            }
        } else if (proof && !verified) {
            // Send rejection message
            const rejectText = `❌ *Payment Verification Failed*\n\n${notes || 'Payment could not be verified. Please contact support or try again.'}\n\nFor assistance, please contact us.`;
            await client.sendMessage(`${proof.customerPhone}@c.us`, rejectText);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Users API
app.get('/api/users', async (req, res) => {
    try {
        const users = await db.collection('users').find().sort({ createdAt: -1 }).toArray();
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Menu API
app.get('/api/menu', async (req, res) => {
    try {
        const menuItems = await db.collection('menu').find().toArray();
        res.json(menuItems);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/menu', async (req, res) => {
    try {
        const menuItem = { ...req.body, createdAt: new Date() };
        const result = await db.collection('menu').insertOne(menuItem);
        res.json({ success: true, id: result.insertedId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/menu/:id', async (req, res) => {
    try {
        await db.collection('menu').deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Sessions API
app.get('/api/sessions', async (req, res) => {
    try {
        const sessions = await db.collection('sessions').find().sort({ lastSeen: -1 }).toArray();
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Broadcast API
app.post('/api/broadcast', async (req, res) => {
    try {
        const { message } = req.body;
        const sessions = await db.collection('sessions').find().toArray();
        let sentCount = 0;
        
        for (const session of sessions) {
            try {
                await client.sendMessage(`${session.phone}@c.us`, message);
                sentCount++;
            } catch (error) {
                console.error(`Failed to send to ${session.phone}:`, error);
            }
        }
        
        res.json({ success: true, sentTo: sentCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve admin panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Admin panel: http://localhost:${PORT}`);
    console.log(`📱 QR Code: http://localhost:${PORT}/api/qr`);
    
    // Initialize WhatsApp client
    client.initialize();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    try {
        await client.destroy();
        console.log('✅ WhatsApp client destroyed');
    } catch (error) {
        console.error('❌ Error destroying WhatsApp client:', error);
    }
    
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    
    try {
        await client.destroy();
        console.log('✅ WhatsApp client destroyed');
    } catch (error) {
        console.error('❌ Error destroying WhatsApp client:', error);
    }
    
    process.exit(0);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

// Keep alive function for deployment platforms
setInterval(() => {
    console.log(`🔄 Bot is alive - ${new Date().toISOString()}`);
}, 300000); // Every 5 minutes
