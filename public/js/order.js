// public/js/order.js

document.addEventListener('DOMContentLoaded', () => {
    const menuItemsContainer = document.getElementById('menuItemsContainer');
    const loadingMessage = document.getElementById('loadingMessage');
    const noItemsMessage = document.getElementById('noItemsMessage');
    const cartItemCountSpan = document.getElementById('cartItemCount');
    const cartTotalSpan = document.getElementById('cartTotal');
    const cartModal = document.getElementById('cartModal');
    const closeCartModalBtn = document.getElementById('closeCartModal');
    const viewCartBtn = document.getElementById('viewCartBtn');
    const cartItemsContainer = document.getElementById('cartItemsContainer');
    const emptyCartMessage = document.getElementById('emptyCartMessage');
    const checkoutBtn = document.getElementById('checkoutBtn');
    const checkoutModal = document.getElementById('checkoutModal');
    const closeCheckoutModalBtn = document.getElementById('closeCheckoutModal');
    const checkoutTotalSpan = document.getElementById('checkoutTotal');
    const checkoutForm = document.getElementById('checkoutForm');
    const orderMessageBox = document.getElementById('orderMessageBox');

    let cart = JSON.parse(localStorage.getItem('cart')) || [];
    let menuItems = []; // To store fetched menu items

    // Function to update cart display
    const updateCartDisplay = () => {
        cartItemCountSpan.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
        const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        cartTotalSpan.textContent = `₹${total.toFixed(2)}`;
        checkoutTotalSpan.textContent = `₹${total.toFixed(2)}`; // Update total in checkout modal

        renderCartItems();
        localStorage.setItem('cart', JSON.stringify(cart));
    };

    // Function to render cart items in the modal
    const renderCartItems = () => {
        cartItemsContainer.innerHTML = '';
        if (cart.length === 0) {
            emptyCartMessage.classList.remove('hidden');
            return;
        }
        emptyCartMessage.classList.add('hidden');

        cart.forEach(item => {
            const cartItemDiv = document.createElement('div');
            cartItemDiv.classList.add('flex', 'items-center', 'justify-between', 'py-2', 'border-b', 'border-gray-200', 'last:border-b-0');
            cartItemDiv.innerHTML = `
                <div class="flex-1">
                    <p class="font-semibold">${item.name}</p>
                    <p class="text-sm text-gray-600">₹${item.price.toFixed(2)} x ${item.quantity}</p>
                </div>
                <button class="remove-from-cart-btn bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1 px-2 rounded-md transition duration-200 ease-in-out" data-product-id="${item.productId}">Remove</button>
            `;
            cartItemsContainer.appendChild(cartItemDiv);
        });

        // Add event listeners for remove buttons
        document.querySelectorAll('.remove-from-cart-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const productIdToRemove = e.target.dataset.productId;
                cart = cart.filter(item => item.productId !== productIdToRemove);
                updateCartDisplay();
                // Also update the quantity on the main menu page
                const quantityInput = document.querySelector(`.quantity-input[data-product-id="${productIdToRemove}"]`);
                if (quantityInput) {
                    quantityInput.value = 0;
                }
            });
        });
    };

    // Function to add/update item in cart
    const updateCartItem = (productId, quantity) => {
        const product = menuItems.find(item => item._id === productId);
        if (!product) return;

        const existingItemIndex = cart.findIndex(item => item.productId === productId);

        if (quantity > 0) {
            if (existingItemIndex > -1) {
                cart[existingItemIndex].quantity = quantity;
            } else {
                cart.push({
                    productId: product._id,
                    name: product.name,
                    price: product.price,
                    quantity: quantity
                });
            }
        } else {
            // Remove item if quantity is 0
            cart = cart.filter(item => item.productId !== productId);
        }
        updateCartDisplay();
    };

    // Fetch menu items from the backend
    const fetchMenuItems = async () => {
        loadingMessage.classList.remove('hidden');
        menuItemsContainer.innerHTML = '';
        try {
            const response = await fetch('/api/menu');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            menuItems = await response.json();
            loadingMessage.classList.add('hidden');

            if (menuItems.length === 0) {
                noItemsMessage.classList.remove('hidden');
                return;
            }
            noItemsMessage.classList.add('hidden');
            renderMenuItems();
        } catch (error) {
            console.error('Error fetching menu items:', error);
            loadingMessage.textContent = 'Failed to load menu. Please try again later.';
            loadingMessage.classList.remove('hidden');
            noItemsMessage.classList.add('hidden');
        }
    };

    // Render menu items on the page
    const renderMenuItems = () => {
        menuItemsContainer.innerHTML = ''; // Clear previous items
        menuItems.forEach(item => {
            const currentCartItem = cart.find(cartItem => cartItem.productId === item._id);
            const quantityInCart = currentCartItem ? currentCartItem.quantity : 0;

            const productCard = document.createElement('div');
            productCard.classList.add('product-card');
            productCard.innerHTML = `
                <img src="${item.imageUrl}" alt="${item.name}" class="product-image">
                <div class="p-4 flex-grow flex flex-col justify-between">
                    <div>
                        <h3 class="text-xl font-semibold text-gray-800 mb-2">${item.name}</h3>
                        <p class="text-gray-600 text-sm mb-3">${item.description || ''}</p>
                    </div>
                    <div class="flex items-center justify-between mt-auto">
                        <p class="text-2xl font-bold text-blue-600">₹${item.price.toFixed(2)}</p>
                        <div class="quantity-control">
                            <button class="quantity-btn decrease-btn" data-product-id="${item._id}">-</button>
                            <input type="number" class="quantity-input" data-product-id="${item._id}" value="${quantityInCart}" min="0" readonly>
                            <button class="quantity-btn increase-btn" data-product-id="${item._id}">+</button>
                        </div>
                    </div>
                </div>
            `;
            menuItemsContainer.appendChild(productCard);
        });

        // Add event listeners for quantity controls
        document.querySelectorAll('.quantity-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const productId = e.target.dataset.productId;
                const quantityInput = document.querySelector(`.quantity-input[data-product-id="${productId}"]`);
                let currentQuantity = parseInt(quantityInput.value);

                if (e.target.classList.contains('increase-btn')) {
                    currentQuantity++;
                } else if (e.target.classList.contains('decrease-btn')) {
                    currentQuantity = Math.max(0, currentQuantity - 1);
                }
                quantityInput.value = currentQuantity;
                updateCartItem(productId, currentQuantity);
            });
        });
    };

    // --- Modal Logic ---
    const openModal = (modalElement) => {
        modalElement.classList.remove('hidden');
    };

    const closeModal = (modalElement) => {
        modalElement.classList.add('hidden');
    };

    viewCartBtn.addEventListener('click', () => {
        openModal(cartModal);
    });

    closeCartModalBtn.addEventListener('click', () => {
        closeModal(cartModal);
    });

    checkoutBtn.addEventListener('click', () => {
        if (cart.length === 0) {
            alert('Your cart is empty. Please add items before checking out.'); // Replace with custom modal
            return;
        }
        closeModal(cartModal); // Close cart modal
        openModal(checkoutModal); // Open checkout modal
    });

    closeCheckoutModalBtn.addEventListener('click', () => {
        closeModal(checkoutModal);
    });

    // Handle checkout form submission
    checkoutForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const userName = document.getElementById('userName').value;
        const userWhatsAppNumber = document.getElementById('userWhatsAppNumber').value;
        const userAddress = document.getElementById('userAddress').value;
        const paymentMethod = document.getElementById('paymentMethod').value;

        // Basic validation
        if (!userName || !userWhatsAppNumber || !userAddress || cart.length === 0) {
            orderMessageBox.textContent = 'Please fill in all required fields and ensure your cart is not empty.';
            orderMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
            orderMessageBox.classList.add('bg-red-100', 'text-red-700');
            return;
        }

        const orderItems = cart.map(item => ({
            productId: item.productId,
            quantity: item.quantity
        }));

        try {
            const response = await fetch('/api/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: orderItems,
                    userName,
                    userWhatsAppNumber,
                    userAddress,
                    paymentMethod
                })
            });

            if (response.ok) {
                orderMessageBox.textContent = 'Order placed successfully! You will receive a WhatsApp confirmation shortly.';
                orderMessageBox.classList.remove('hidden', 'bg-red-100', 'text-red-700');
                orderMessageBox.classList.add('bg-green-100', 'text-green-700');
                cart = []; // Clear cart after successful order
                localStorage.removeItem('cart');
                updateCartDisplay();
                checkoutForm.reset();
                // Reset quantities on menu items
                document.querySelectorAll('.quantity-input').forEach(input => input.value = 0);
                setTimeout(() => {
                    closeModal(checkoutModal);
                    orderMessageBox.classList.add('hidden');
                }, 3000); // Close modal after 3 seconds
            } else {
                const errorData = await response.json();
                orderMessageBox.textContent = errorData.message || 'Failed to place order. Please try again.';
                orderMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
                orderMessageBox.classList.add('bg-red-100', 'text-red-700');
            }
        } catch (error) {
            console.error('Error placing order:', error);
            orderMessageBox.textContent = 'An error occurred while placing your order. Please try again.';
            orderMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
            orderMessageBox.classList.add('bg-red-100', 'text-red-700');
        }
    });

    // Initial load
    fetchMenuItems();
    updateCartDisplay();
});

