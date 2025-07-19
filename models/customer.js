    const mongoose = require('mongoose');

    const customerSchema = new mongoose.Schema({
        customerPhone: { type: String, required: true, unique: true },
        customerName: { type: String, default: 'Customer' },
        lastKnownLocation: { // Last known location from their orders or messages
            latitude: { type: Number },
            longitude: { type: Number }
        },
        deliveryAddress: { type: String }, // Last known delivery address
        lastSeen: { type: Date, default: Date.now } // Timestamp of last interaction
    });

    // Update lastSeen on any save
    customerSchema.pre('save', function(next) {
        this.lastSeen = Date.now();
        next();
    });

    module.exports = mongoose.model('Customer', customerSchema);
    ```

