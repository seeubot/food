    const mongoose = require('mongoose');

    const menuItemSchema = new mongoose.Schema({
        name: { type: String, required: true },
        description: { type: String },
        price: { type: Number, required: true, min: 0 },
        imageUrl: { type: String, default: 'https://placehold.co/300x200/cccccc/333333?text=Food+Item' },
        category: { type: String, default: 'Main Course' },
        isAvailable: { type: Boolean, default: false },
        isTrending: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    });

    module.exports = mongoose.model('MenuItem', menuItemSchema);
    ```

