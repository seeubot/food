const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    items: [{
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true }, // Changed from Product to MenuItem
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
    deliveryFromLocation: { // Store shop location at time of order for tracking
        latitude: { type: Number },
        longitude: { type: Number }
    },
    subtotal: { type: Number, required: true },
    transportTax: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    status: { type: String, enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled', 'Pending Confirmation'], default: 'Pending' }, // Added Pending Confirmation
    orderDate: { type: Date, default: Date.now },
    paymentMethod: { type: String, enum: ['COD', 'Online'], default: 'COD' }
});

module.exports = mongoose.model('Order', orderSchema);

