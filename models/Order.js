// models/Order.js
import mongoose from 'mongoose'; // Use import for ES modules

const orderItemSchema = new mongoose.Schema({
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product', // Reference to the Product model
        required: true
    },
    quantity: {
        type: Number,
        required: true,
        min: 1
    },
    price: { // Price at the time of order
        type: Number,
        required: true,
        min: 0
    }
});

const orderSchema = new mongoose.Schema({
    items: [orderItemSchema],
    userWhatsAppNumber: {
        type: String,
        required: true, // Assuming we always need this for notifications
        trim: true
    },
    userName: {
        type: String,
        trim: true,
        default: 'Guest'
    },
    userAddress: {
        type: String,
        trim: true
    },
    totalAmount: {
        type: Number,
        required: true,
        min: 0
    },
    status: {
        type: String,
        enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Completed', 'Cancelled'],
        default: 'Pending'
    },
    paymentMethod: {
        type: String,
        enum: ['Cash on Delivery', 'Online Payment (Placeholder)'],
        default: 'Cash on Delivery'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Update `updatedAt` field on save
orderSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

export default mongoose.model('Order', orderSchema); // Use export default for ES modules

