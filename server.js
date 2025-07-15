const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Initialize the client
const client = new Client({
    authStrategy: new LocalAuth(),
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

// Support responses
const supportResponses = {
    'help': `🤖 *Support Bot Help*

Available commands:
• *help* - Show this help menu
• *hours* - Business hours
• *contact* - Contact information
• *faq* - Frequently asked questions
• *status* - Service status
• *human* - Connect with human support

Type any command to get started!`,

    'hours': `🕐 *Business Hours*

Monday - Friday: 9:00 AM - 6:00 PM
Saturday: 10:00 AM - 4:00 PM
Sunday: Closed

Timezone: UTC+0

We'll respond to your messages during business hours.`,

    'contact': `📞 *Contact Information*

📧 Email: support@yourcompany.com
📱 Phone: +1-234-567-8900
🌐 Website: https://yourcompany.com
📍 Address: 123 Business St, City, Country

For urgent matters, please call our phone number.`,

    'faq': `❓ *Frequently Asked Questions*

*Q: How do I reset my password?*
A: Visit our website and click "Forgot Password" or contact support.

*Q: How long does delivery take?*
A: Standard delivery is 3-5 business days.

*Q: What payment methods do you accept?*
A: We accept all major credit cards, PayPal, and bank transfers.

*Q: How can I track my order?*
A: You'll receive a tracking number via email once your order ships.

Need more help? Type *human* to connect with our support team.`,

    'status': `✅ *Service Status*

All systems operational:
• Website: ✅ Online
• Payment System: ✅ Online
• Email Support: ✅ Online
• Phone Support: ✅ Online

Last updated: ${new Date().toLocaleString()}

For real-time updates, visit our status page.`,

    'human': `👨‍💼 *Human Support*

I'm connecting you with our support team. Please wait while I transfer your conversation.

In the meantime, please provide:
• Your name
• Order number (if applicable)
• Brief description of your issue

Our team will respond within 2 hours during business hours.

Thank you for your patience! 🙏`
};

// Generate QR code
client.on('qr', (qr) => {
    console.log('QR Code generated. Scan it with WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// Client ready
client.on('ready', () => {
    console.log('✅ WhatsApp Support Bot is ready!');
    console.log('Bot is now connected and listening for messages...');
});

// Handle authentication
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
});

client.on('authenticated', () => {
    console.log('✅ Authentication successful!');
});

// Handle disconnection
client.on('disconnected', (reason) => {
    console.log('❌ Client was disconnected:', reason);
});

// Main message handler
client.on('message', async (message) => {
    // Ignore group messages and status updates
    if (message.from.includes('@g.us') || message.isStatus) {
        return;
    }

    const chat = await message.getChat();
    const contact = await message.getContact();
    const messageBody = message.body.toLowerCase().trim();

    // Log incoming message
    console.log(`📨 Message from ${contact.name || contact.number}: ${message.body}`);

    // Auto-reply logic
    try {
        let response = '';

        // Check for specific commands
        if (supportResponses[messageBody]) {
            response = supportResponses[messageBody];
        } else if (messageBody.includes('hello') || messageBody.includes('hi') || messageBody.includes('hey')) {
            response = `👋 Hello ${contact.name || 'there'}! Welcome to our support bot.

I'm here to help you 24/7. Type *help* to see available commands or describe your issue and I'll assist you.

How can I help you today?`;
        } else if (messageBody.includes('thank')) {
            response = `You're welcome! 😊 

Is there anything else I can help you with today? Type *help* for more options.`;
        } else if (messageBody.includes('bye') || messageBody.includes('goodbye')) {
            response = `Goodbye! 👋 

Thank you for contacting us. If you need further assistance, feel free to message us anytime.

Have a great day! 🌟`;
        } else if (messageBody.includes('order') || messageBody.includes('delivery') || messageBody.includes('shipping')) {
            response = `📦 *Order & Delivery Support*

For order-related queries:
• Check your email for order confirmation
• Use tracking number to monitor delivery
• Standard delivery: 3-5 business days
• Express delivery: 1-2 business days

Need specific help with your order? Type *human* to connect with our team.`;
        } else if (messageBody.includes('payment') || messageBody.includes('refund') || messageBody.includes('billing')) {
            response = `💳 *Payment & Billing Support*

Payment issues:
• Check your payment method
• Verify billing address
• Contact your bank if payment declined

Refund requests:
• Refunds processed within 5-7 business days
• Original payment method will be credited

For billing disputes, type *human* for assistance.`;
        } else if (messageBody.includes('account') || messageBody.includes('login') || messageBody.includes('password')) {
            response = `🔐 *Account Support*

Account issues:
• Reset password on our website
• Check your email for verification
• Clear browser cache and cookies

Still having trouble? Type *human* to get personalized help from our team.`;
        } else {
            // Default response for unrecognized messages
            response = `🤖 I received your message: "${message.body}"

I'm still learning! For immediate help, try these commands:
• *help* - See all available commands
• *faq* - Common questions
• *human* - Connect with support team

Or describe your issue and I'll do my best to help!`;
        }

        // Send response
        await chat.sendMessage(response);
        console.log(`✅ Response sent to ${contact.name || contact.number}`);

    } catch (error) {
        console.error('❌ Error handling message:', error);
        await chat.sendMessage('❌ Sorry, I encountered an error. Please try again or type *human* for assistance.');
    }
});

// Handle errors
client.on('error', (error) => {
    console.error('❌ Client error:', error);
});

// Initialize the client
console.log('🚀 Starting WhatsApp Support Bot...');
client.initialize();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down bot...');
    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🔄 Shutting down bot...');
    await client.destroy();
    process.exit(0);
});
