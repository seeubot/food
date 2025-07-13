// public/js/dashboard.js

document.addEventListener('DOMContentLoaded', () => {
    const navLinks = document.querySelectorAll('.nav-link');
    const contentSections = document.querySelectorAll('.content-section');
    const qrCodeImage = document.getElementById('qrCodeImage');
    const qrStatus = document.getElementById('qrStatus');
    const ordersTableBody = document.getElementById('ordersTableBody');
    const noOrdersMessage = document.getElementById('noOrdersMessage');
    const menuItemForm = document.getElementById('menuItemForm');
    const menuItemsTableBody = document.getElementById('menuItemsTableBody');
    const noMenuItemsMessage = document.getElementById('noMenuItemsMessage');
    const menuMessageBox = document.getElementById('menuMessageBox');

    // Dashboard overview elements
    const totalOrdersElement = document.getElementById('totalOrders');
    const pendingOrdersElement = document.getElementById('pendingOrders');
    const totalMenuItemsElement = document.getElementById('totalMenuItems');

    // Function to show a specific section
    const showSection = (sectionId) => {
        contentSections.forEach(section => {
            section.classList.add('hidden');
        });
        document.getElementById(sectionId).classList.remove('hidden');

        navLinks.forEach(link => {
            link.classList.remove('bg-gray-700');
        });
        document.querySelector(`.nav-link[data-section="${sectionId.replace('-section', '')}"]`).classList.add('bg-gray-700');
    };

    // Event listeners for navigation links
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const section = e.target.closest('.nav-link').dataset.section;
            showSection(`${section}-section`);
            if (section === 'orders') {
                fetchOrders();
            } else if (section === 'menu') {
                fetchMenuItems();
            } else if (section === 'dashboard') {
                fetchDashboardData();
            }
        });
    });

    // --- Dashboard Data Fetching ---
    const fetchDashboardData = async () => {
        try {
            // Fetch QR Code
            const qrResponse = await fetch('/api/whatsapp-qr');
            const qrData = await qrResponse.json();
            if (qrData.qrCode && qrData.qrCode.startsWith('data:image/png;base64,')) {
                qrCodeImage.src = qrData.qrCode;
                qrCodeImage.style.display = 'block';
                qrStatus.textContent = 'Scan QR Code to connect WhatsApp';
            } else if (qrData.qrCode === 'WhatsApp Client is ready!') {
                qrCodeImage.style.display = 'none';
                qrStatus.textContent = 'WhatsApp Client is ready! Bot is active.';
            } else {
                qrCodeImage.style.display = 'none';
                qrStatus.textContent = qrData.qrCode || 'Failed to load QR code.';
            }

            // Fetch Orders for overview
            const ordersResponse = await fetch('/api/orders');
            const orders = await ordersResponse.json();
            totalOrdersElement.textContent = orders.length;
            const pending = orders.filter(order => order.status === 'Pending').length;
            pendingOrdersElement.textContent = pending;

            // Fetch Menu Items for overview
            const menuResponse = await fetch('/api/menu');
            const menuItems = await menuResponse.json();
            totalMenuItemsElement.textContent = menuItems.length;

        } catch (error) {
            console.error('Error fetching dashboard data:', error);
            qrStatus.textContent = 'Error fetching bot status or data.';
        }
    };

    // --- Orders Management ---
    const fetchOrders = async () => {
        try {
            const response = await fetch('/api/orders');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const orders = await response.json();
            renderOrders(orders);
        } catch (error) {
            console.error('Error fetching orders:', error);
            ordersTableBody.innerHTML = `<tr><td colspan="8" class="px-6 py-4 text-center text-red-500">Failed to load orders.</td></tr>`;
        }
    };

    const renderOrders = (orders) => {
        ordersTableBody.innerHTML = '';
        if (orders.length === 0) {
            noOrdersMessage.classList.remove('hidden');
            return;
        }
        noOrdersMessage.classList.add('hidden');

        orders.forEach(order => {
            const row = document.createElement('tr');
            row.classList.add('hover:bg-gray-50');
            row.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${order._id}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${order.userName || 'N/A'}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${order.userWhatsAppNumber || 'N/A'}</td>
                <td class="px-6 py-4 text-sm text-gray-500">
                    ${order.items.map(item => `${item.quantity}x ${item.product ? item.product.name : 'Unknown Product'}`).join('<br>')}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">₹${order.totalAmount.toFixed(2)}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <select class="status-select bg-white border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5" data-order-id="${order._id}">
                        <option value="Pending" ${order.status === 'Pending' ? 'selected' : ''}>Pending</option>
                        <option value="Confirmed" ${order.status === 'Confirmed' ? 'selected' : ''}>Confirmed</option>
                        <option value="Preparing" ${order.status === 'Preparing' ? 'selected' : ''}>Preparing</option>
                        <option value="Out for Delivery" ${order.status === 'Out for Delivery' ? 'selected' : ''}>Out for Delivery</option>
                        <option value="Completed" ${order.status === 'Completed' ? 'selected' : ''}>Completed</option>
                        <option value="Cancelled" ${order.status === 'Cancelled' ? 'selected' : ''}>Cancelled</option>
                    </select>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${new Date(order.createdAt).toLocaleString()}</td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button class="delete-order-btn text-red-600 hover:text-red-900 transition duration-200 ease-in-out" data-order-id="${order._id}">Delete</button>
                </td>
            `;
            ordersTableBody.appendChild(row);
        });

        // Add event listeners for status changes
        document.querySelectorAll('.status-select').forEach(select => {
            select.addEventListener('change', async (e) => {
                const orderId = e.target.dataset.orderId;
                const newStatus = e.target.value;
                try {
                    const response = await fetch(`/api/orders/${orderId}/status`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: newStatus })
                    });
                    if (response.ok) {
                        console.log(`Order ${orderId} status updated to ${newStatus}`);
                        // Optionally, re-fetch orders to update the list
                        fetchOrders();
                    } else {
                        console.error('Failed to update order status');
                        alert('Failed to update order status.'); // Use custom modal in production
                    }
                } catch (error) {
                    console.error('Error updating order status:', error);
                    alert('Error updating order status.'); // Use custom modal in production
                }
            });
        });

        // Add event listeners for delete buttons (placeholder for functionality)
        document.querySelectorAll('.delete-order-btn').forEach(button => {
            button.addEventListener('click', (e) => {
                const orderId = e.target.dataset.orderId;
                // In a real app, you'd add a confirmation modal here
                if (confirm(`Are you sure you want to delete order ${orderId}?`)) { // Replace with custom modal
                    // Implement delete API call here
                    alert('Delete functionality not implemented yet.'); // Replace with custom modal
                    console.log('Delete order:', orderId);
                }
            });
        });
    };

    // --- Menu Management ---
    menuItemForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const itemName = document.getElementById('itemName').value;
        const itemPrice = parseFloat(document.getElementById('itemPrice').value);
        const itemDescription = document.getElementById('itemDescription').value;
        const itemImageUrl = document.getElementById('itemImageUrl').value;

        try {
            const response = await fetch('/api/menu', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: itemName,
                    price: itemPrice,
                    description: itemDescription,
                    imageUrl: itemImageUrl
                })
            });

            if (response.ok) {
                menuMessageBox.textContent = 'Item added successfully!';
                menuMessageBox.classList.remove('hidden', 'bg-red-100', 'text-red-700');
                menuMessageBox.classList.add('bg-green-100', 'text-green-700');
                menuItemForm.reset();
                fetchMenuItems(); // Refresh the list
                fetchDashboardData(); // Update total menu items count
            } else {
                const errorData = await response.json();
                menuMessageBox.textContent = errorData.message || 'Failed to add item.';
                menuMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
                menuMessageBox.classList.add('bg-red-100', 'text-red-700');
            }
        } catch (error) {
            console.error('Error adding menu item:', error);
            menuMessageBox.textContent = 'An error occurred while adding the item.';
            menuMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
            menuMessageBox.classList.add('bg-red-100', 'text-red-700');
        }
    });

    const fetchMenuItems = async () => {
        try {
            const response = await fetch('/api/menu');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const menuItems = await response.json();
            renderMenuItems(menuItems);
        } catch (error) {
            console.error('Error fetching menu items:', error);
            menuItemsTableBody.innerHTML = `<tr><td colspan="5" class="px-6 py-4 text-center text-red-500">Failed to load menu items.</td></tr>`;
        }
    };

    const renderMenuItems = (items) => {
        menuItemsTableBody.innerHTML = '';
        if (items.length === 0) {
            noMenuItemsMessage.classList.remove('hidden');
            return;
        }
        noMenuItemsMessage.classList.add('hidden');

        items.forEach(item => {
            const row = document.createElement('tr');
            row.classList.add('hover:bg-gray-50');
            row.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap">
                    <img src="${item.imageUrl}" alt="${item.name}" class="w-16 h-16 object-cover rounded-lg">
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${item.name}</td>
                <td class="px-6 py-4 text-sm text-gray-500">${item.description || 'N/A'}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">₹${item.price.toFixed(2)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button class="delete-menu-item-btn text-red-600 hover:text-red-900 transition duration-200 ease-in-out" data-item-id="${item._id}">Delete</button>
                </td>
            `;
            menuItemsTableBody.appendChild(row);
        });

        // Add event listeners for delete menu item buttons
        document.querySelectorAll('.delete-menu-item-btn').forEach(button => {
            button.addEventListener('click', async (e) => {
                const itemId = e.target.dataset.itemId;
                // In a real app, use a custom modal for confirmation
                if (confirm(`Are you sure you want to delete "${e.target.closest('tr').querySelector('td:nth-child(2)').textContent}"?`)) {
                    try {
                        const response = await fetch(`/api/menu/${itemId}`, {
                            method: 'DELETE'
                        });
                        if (response.ok) {
                            menuMessageBox.textContent = 'Item deleted successfully!';
                            menuMessageBox.classList.remove('hidden', 'bg-red-100', 'text-red-700');
                            menuMessageBox.classList.add('bg-green-100', 'text-green-700');
                            fetchMenuItems(); // Refresh the list
                            fetchDashboardData(); // Update total menu items count
                        } else {
                            const errorData = await response.json();
                            menuMessageBox.textContent = errorData.message || 'Failed to delete item.';
                            menuMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
                            menuMessageBox.classList.add('bg-red-100', 'text-red-700');
                        }
                    } catch (error) {
                        console.error('Error deleting menu item:', error);
                        menuMessageBox.textContent = 'An error occurred while deleting the item.';
                        menuMessageBox.classList.remove('hidden', 'bg-green-100', 'text-green-700');
                        menuMessageBox.classList.add('bg-red-100', 'text-red-700');
                    }
                }
            });
        });
    };

    // Initial load: show dashboard and fetch data
    showSection('dashboard-section');
    fetchDashboardData();
});

