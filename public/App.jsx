import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import io from 'socket.io-client'; // Import socket.io-client
import {
  Home,
  Utensils,
  ClipboardList,
  MessageCircleMore,
  QrCode,
  CheckCircle,
  XCircle,
  RefreshCw,
  Plus,
  Edit,
  Trash2,
  ChevronDown,
  Menu as MenuIcon, // Renamed to avoid conflict with HTML <Menu>
  Loader2,
  AlertCircle,
  ChevronUp,
} from 'lucide-react'; // Using lucide-react for icons

// Ensure Tailwind CSS is loaded via CDN in the HTML file
// <script src="https://cdn.tailwindcss.com"></script>
// <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

// Base URL for your backend API
const API_BASE_URL = ''; // Use empty string for relative paths if served from same origin

// Custom Toast Notification Component
const Toast = ({ message, type, onClose }) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      onClose();
    }, 3000); // Toast disappears after 3 seconds
    return () => clearTimeout(timer);
  }, [onClose]);

  if (!isVisible) return null;

  let bgColor = 'bg-gray-800';
  let textColor = 'text-white';
  let icon = null;

  switch (type) {
    case 'success':
      bgColor = 'bg-green-600';
      icon = <CheckCircle className="w-5 h-5 mr-2" />;
      break;
    case 'error':
      bgColor = 'bg-red-600';
      icon = <XCircle className="w-5 h-5 mr-2" />;
      break;
    case 'info':
      bgColor = 'bg-blue-600';
      icon = <AlertCircle className="w-5 h-5 mr-2" />;
      break;
    default:
      break;
  }

  return (
    <div
      className={`fixed bottom-4 right-4 p-4 rounded-lg shadow-lg flex items-center ${bgColor} ${textColor} z-50 transition-all duration-300 ease-in-out transform`}
      style={{ transform: isVisible ? 'translateY(0)' : 'translateY(100px)' }}
    >
      {icon}
      <span>{message}</span>
      <button onClick={() => setIsVisible(false)} className="ml-4 text-white hover:text-gray-200">
        &times;
      </button>
    </div>
  );
};

// Loading Spinner Component
const LoadingSpinner = () => (
  <div className="flex justify-center items-center py-8">
    <Loader2 className="animate-spin text-tomato-500 w-8 h-8" />
  </div>
);

// Dashboard Layout Component
const DashboardLayout = ({ children, currentView, setCurrentView }) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const navItems = [
    { name: 'Dashboard', icon: Home, view: 'dashboard' },
    { name: 'WhatsApp Bots', icon: MessageCircleMore, view: 'whatsapp' },
    { name: 'Menu Management', icon: Utensils, view: 'menu' },
    { name: 'Order Management', icon: ClipboardList, view: 'orders' },
  ];

  return (
    <div className="flex min-h-screen bg-gray-900 text-gray-100 font-inter">
      {/* Mobile Sidebar Toggle */}
      <button
        className="lg:hidden fixed top-4 left-4 z-40 p-2 rounded-md bg-gray-800 text-gray-100 hover:bg-gray-700 transition-colors"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
      >
        <MenuIcon className="w-6 h-6" />
      </button>

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 bg-gray-800 shadow-lg transform ${
          isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } lg:translate-x-0 lg:relative lg:flex-shrink-0 transition-transform duration-300 ease-in-out`}
      >
        <div className="p-6 text-2xl font-bold text-tomato-500 border-b border-gray-700">
          FoodBiz Admin
        </div>
        <nav className="mt-6">
          <ul>
            {navItems.map((item) => (
              <li key={item.view}>
                <button
                  onClick={() => {
                    setCurrentView(item.view);
                    setIsSidebarOpen(false); // Close sidebar on mobile after selection
                  }}
                  className={`flex items-center w-full px-6 py-3 text-lg font-medium rounded-r-full transition-colors duration-200
                    ${
                      currentView === item.view
                        ? 'bg-tomato-700 text-white shadow-lg'
                        : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                    }`}
                >
                  <item.icon className="w-6 h-6 mr-4" />
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 p-6 lg:ml-64 overflow-auto">
        <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  );
};

// WhatsApp Bots Status Panel
const WhatsAppPanel = ({ showToast }) => {
  const [bot1Status, setBot1Status] = useState({ image: null, status: 'Loading...', isReady: false });
  const [bot2Status, setBot2Status] = useState({ image: null, status: 'Loading...', isReady: false });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const socket = io(API_BASE_URL); // Connect to Socket.IO

    socket.on('qr1', (data) => {
      setBot1Status(data);
      setIsLoading(false);
      if (data.isReady) {
        showToast('WhatsApp Bot 1 is ready!', 'success');
      } else if (data.status.includes('Auth Failure') || data.status.includes('Disconnected')) {
        showToast(`WhatsApp Bot 1: ${data.status}`, 'error');
      }
    });

    socket.on('qr2', (data) => {
      setBot2Status(data);
      setIsLoading(false);
      if (data.isReady) {
        showToast('WhatsApp Bot 2 is ready!', 'success');
      } else if (data.status.includes('Auth Failure') || data.status.includes('Disconnected')) {
        showToast(`WhatsApp Bot 2: ${data.status}`, 'error');
      }
    });

    // Initial fetch in case socket.io misses the first emit
    const fetchInitialStatus = async () => {
      try {
        const [res1, res2] = await Promise.all([
          fetch(`${API_BASE_URL}/api/whatsapp/qr1`),
          fetch(`${API_BASE_URL}/api/whatsapp/qr2`)
        ]);
        const data1 = await res1.json();
        const data2 = await res2.json();
        setBot1Status(data1);
        setBot2Status(data2);
      } catch (error) {
        console.error('Error fetching initial WhatsApp status:', error);
        showToast('Failed to fetch initial WhatsApp status.', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    fetchInitialStatus();

    return () => {
      socket.disconnect();
    };
  }, [showToast]);

  return (
    <div>
      <h1 className="text-3xl font-bold text-white mb-8">WhatsApp Bots Status</h1>

      {isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Bot 1 Card */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-md flex flex-col items-center">
            <h2 className="text-xl font-semibold mb-4 text-tomato-400">WhatsApp Bot 1</h2>
            <div className="mb-4 text-lg flex items-center">
              Status:
              <span className={`ml-2 font-medium ${bot1Status.isReady ? 'text-green-400' : 'text-yellow-400'}`}>
                {bot1Status.status}
              </span>
              {bot1Status.isReady ? (
                <CheckCircle className="w-5 h-5 ml-2 text-green-400" />
              ) : (
                <AlertCircle className="w-5 h-5 ml-2 text-yellow-400" />
              )}
            </div>
            {bot1Status.image && !bot1Status.isReady ? (
              <div className="bg-white p-4 rounded-md">
                <img src={bot1Status.image} alt="QR Code 1" className="w-48 h-48 object-contain" />
              </div>
            ) : (
              <div className="w-48 h-48 flex items-center justify-center bg-gray-700 rounded-md text-gray-400 text-sm">
                {bot1Status.isReady ? 'Bot 1 Connected' : 'Waiting for QR Code...'}
              </div>
            )}
            <p className="mt-4 text-sm text-gray-400 text-center">
              Scan the QR code with your WhatsApp app to connect Bot 1.
            </p>
          </div>

          {/* Bot 2 Card */}
          <div className="bg-gray-800 p-6 rounded-lg shadow-md flex flex-col items-center">
            <h2 className="text-xl font-semibold mb-4 text-tomato-400">WhatsApp Bot 2</h2>
            <div className="mb-4 text-lg flex items-center">
              Status:
              <span className={`ml-2 font-medium ${bot2Status.isReady ? 'text-green-400' : 'text-yellow-400'}`}>
                {bot2Status.status}
              </span>
              {bot2Status.isReady ? (
                <CheckCircle className="w-5 h-5 ml-2 text-green-400" />
              ) : (
                <AlertCircle className="w-5 h-5 ml-2 text-yellow-400" />
              )}
            </div>
            {bot2Status.image && !bot2Status.isReady ? (
              <div className="bg-white p-4 rounded-md">
                <img src={bot2Status.image} alt="QR Code 2" className="w-48 h-48 object-contain" />
              </div>
            ) : (
              <div className="w-48 h-48 flex items-center justify-center bg-gray-700 rounded-md text-gray-400 text-sm">
                {bot2Status.isReady ? 'Bot 2 Connected' : 'Waiting for QR Code...'}
              </div>
            )}
            <p className="mt-4 text-sm text-gray-400 text-center">
              Scan the QR code with your WhatsApp app to connect Bot 2.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// Menu Management Panel
const MenuPanel = ({ showToast }) => {
  const [menuItems, setMenuItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentMenuItem, setCurrentMenuItem] = useState(null); // For editing
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [sortOrder, setSortOrder] = useState('name-asc'); // 'name-asc', 'name-desc', 'price-asc', 'price-desc'

  const fetchMenuItems = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/menu`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setMenuItems(data);
    } catch (error) {
      console.error('Error fetching menu items:', error);
      showToast('Failed to fetch menu items.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchMenuItems();
  }, [fetchMenuItems]);

  const handleAddEdit = async (itemData) => {
    setIsLoading(true);
    try {
      let response;
      if (currentMenuItem) {
        // Edit existing item
        response = await fetch(`${API_BASE_URL}/api/menu/${currentMenuItem._id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(itemData),
        });
      } else {
        // Add new item
        response = await fetch(`${API_BASE_URL}/api/menu`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(itemData),
        });
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to save menu item.');
      }

      await fetchMenuItems();
      showToast(`Menu item ${currentMenuItem ? 'updated' : 'added'} successfully!`, 'success');
      setIsModalOpen(false);
      setCurrentMenuItem(null);
    } catch (error) {
      console.error('Error saving menu item:', error);
      showToast(error.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this menu item?')) {
      return;
    }
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/menu/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete menu item.');
      }
      await fetchMenuItems();
      showToast('Menu item deleted successfully!', 'success');
    } catch (error) {
      console.error('Error deleting menu item:', error);
      showToast(error.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const openAddModal = () => {
    setCurrentMenuItem(null);
    setIsModalOpen(true);
  };

  const openEditModal = (item) => {
    setCurrentMenuItem(item);
    setIsModalOpen(true);
  };

  const closeAddEditModal = () => {
    setIsModalOpen(false);
    setCurrentMenuItem(null);
  };

  const allCategories = ['All', ...new Set(menuItems.map(item => item.category))];

  const filteredAndSortedItems = menuItems
    .filter(item =>
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) &&
      (filterCategory === 'All' || item.category === filterCategory)
    )
    .sort((a, b) => {
      if (sortOrder === 'name-asc') return a.name.localeCompare(b.name);
      if (sortOrder === 'name-desc') return b.name.localeCompare(a.name);
      if (sortOrder === 'price-asc') return a.price - b.price;
      if (sortOrder === 'price-desc') return b.price - a.price;
      return 0;
    });

  return (
    <div>
      <h1 className="text-3xl font-bold text-white mb-8">Menu Management</h1>

      <div className="bg-gray-800 p-6 rounded-lg shadow-md mb-6">
        <div className="flex flex-col md:flex-row justify-between items-center mb-4">
          <input
            type="text"
            placeholder="Search menu items..."
            className="w-full md:w-1/3 p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 placeholder-gray-400 focus:outline-none focus:border-tomato-500 mb-4 md:mb-0"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <div className="flex flex-col md:flex-row gap-4 w-full md:w-2/3 md:justify-end">
            <select
              className="p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
            >
              {allCategories.map(cat => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <select
              className="p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            >
              <option value="name-asc">Name (A-Z)</option>
              <option value="name-desc">Name (Z-A)</option>
              <option value="price-asc">Price (Low to High)</option>
              <option value="price-desc">Price (High to Low)</option>
            </select>
            <button
              onClick={openAddModal}
              className="bg-tomato-500 hover:bg-tomato-600 text-gray-900 font-semibold py-3 px-5 rounded-md flex items-center justify-center transition-colors shadow-md"
            >
              <Plus className="w-5 h-5 mr-2" />
              Add New Item
            </button>
          </div>
        </div>

        {isLoading ? (
          <LoadingSpinner />
        ) : filteredAndSortedItems.length === 0 ? (
          <p className="text-center text-gray-400 py-8">No menu items found. Try adjusting your filters or add a new item!</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-700">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Image
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Name
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Category
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Price
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Available
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    New
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Trending
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-gray-800 divide-y divide-gray-700">
                {filteredAndSortedItems.map((item) => (
                  <tr key={item._id} className="hover:bg-gray-700 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        className="w-16 h-16 rounded-md object-cover"
                        onError={(e) => { e.target.onerror = null; e.target.src = "https://placehold.co/64x64/E0E0E0/333333?text=No+Image"; }}
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-200 font-medium">
                      {item.name}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-300">
                      {item.category}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-200">
                      Rs. {item.price.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {item.isAvailable ? (
                        <CheckCircle className="w-5 h-5 text-green-500" />
                      ) : (
                        <XCircle className="w-5 h-5 text-red-500" />
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {item.isNew ? (
                        <CheckCircle className="w-5 h-5 text-blue-500" />
                      ) : (
                        <XCircle className="w-5 h-5 text-gray-500" />
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {item.isTrending ? (
                        <CheckCircle className="w-5 h-5 text-purple-500" />
                      ) : (
                        <XCircle className="w-5 h-5 text-gray-500" />
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => openEditModal(item)}
                        className="text-blue-400 hover:text-blue-500 mr-3 p-2 rounded-md hover:bg-gray-600 transition-colors"
                        title="Edit Item"
                      >
                        <Edit className="w-5 h-5" />
                      </button>
                      <button
                        onClick={() => handleDelete(item._id)}
                        className="text-red-400 hover:text-red-500 p-2 rounded-md hover:bg-gray-600 transition-colors"
                        title="Delete Item"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isModalOpen && (
        <MenuItemModal
          item={currentMenuItem}
          onSave={handleAddEdit}
          onClose={closeAddEditModal}
          showToast={showToast}
        />
      )}
    </div>
  );
};

// MenuItem Add/Edit Modal
const MenuItemModal = ({ item, onSave, onClose, showToast }) => {
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    price: '',
    imageUrl: '',
    category: '',
    isAvailable: true,
    isNew: false,
    isTrending: false,
  });

  useEffect(() => {
    if (item) {
      setFormData({
        name: item.name || '',
        description: item.description || '',
        price: item.price || '',
        imageUrl: item.imageUrl || '',
        category: item.category || '',
        isAvailable: item.isAvailable || false,
        isNew: item.isNew || false,
        isTrending: item.isTrending || false,
      });
    }
  }, [item]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prevData) => ({
      ...prevData,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name || !formData.price || !formData.category) {
      showToast('Name, Price, and Category are required.', 'error');
      return;
    }
    if (isNaN(formData.price) || parseFloat(formData.price) <= 0) {
      showToast('Price must be a positive number.', 'error');
      return;
    }
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl w-full max-w-md relative">
        <h2 className="text-2xl font-bold text-white mb-6">
          {item ? 'Edit Menu Item' : 'Add New Menu Item'}
        </h2>
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-100 transition-colors"
        >
          <XCircle className="w-6 h-6" />
        </button>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-300 mb-1">
              Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              className="w-full p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
              required
            />
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-300 mb-1">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              value={formData.description}
              onChange={handleChange}
              rows="3"
              className="w-full p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
            ></textarea>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="price" className="block text-sm font-medium text-gray-300 mb-1">
                Price (Rs.)
              </label>
              <input
                type="number"
                id="price"
                name="price"
                value={formData.price}
                onChange={handleChange}
                step="0.01"
                className="w-full p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
                required
              />
            </div>
            <div>
              <label htmlFor="category" className="block text-sm font-medium text-gray-300 mb-1">
                Category
              </label>
              <input
                type="text"
                id="category"
                name="category"
                value={formData.category}
                onChange={handleChange}
                className="w-full p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="imageUrl" className="block text-sm font-medium text-gray-300 mb-1">
              Image URL
            </label>
            <input
              type="url"
              id="imageUrl"
              name="imageUrl"
              value={formData.imageUrl}
              onChange={handleChange}
              className="w-full p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
            />
            {formData.imageUrl && (
              <img
                src={formData.imageUrl}
                alt="Preview"
                className="mt-2 w-24 h-24 object-cover rounded-md"
                onError={(e) => { e.target.onerror = null; e.target.src = "https://placehold.co/96x96/E0E0E0/333333?text=No+Preview"; }}
              />
            )}
          </div>

          <div className="flex items-center space-x-4">
            <label className="flex items-center text-gray-300">
              <input
                type="checkbox"
                name="isAvailable"
                checked={formData.isAvailable}
                onChange={handleChange}
                className="form-checkbox h-5 w-5 text-tomato-500 rounded border-gray-600 bg-gray-700 focus:ring-tomato-500"
              />
              <span className="ml-2 text-sm">Available</span>
            </label>
            <label className="flex items-center text-gray-300">
              <input
                type="checkbox"
                name="isNew"
                checked={formData.isNew}
                onChange={handleChange}
                className="form-checkbox h-5 w-5 text-tomato-500 rounded border-gray-600 bg-gray-700 focus:ring-tomato-500"
              />
              <span className="ml-2 text-sm">New Item</span>
            </label>
            <label className="flex items-center text-gray-300">
              <input
                type="checkbox"
                name="isTrending"
                checked={formData.isTrending}
                onChange={handleChange}
                className="form-checkbox h-5 w-5 text-tomato-500 rounded border-gray-600 bg-gray-700 focus:ring-tomato-500"
              />
              <span className="ml-2 text-sm">Trending</span>
            </label>
          </div>

          <div className="flex justify-end space-x-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-md text-gray-300 border border-gray-600 hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-tomato-500 hover:bg-tomato-600 text-gray-900 font-semibold px-5 py-2 rounded-md transition-colors shadow-md"
            >
              {item ? 'Update Item' : 'Add Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Order Management Panel
const OrdersPanel = ({ showToast }) => {
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState(null); // For order details modal
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [filterStatus, setFilterStatus] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');

  const orderStatuses = ['All', 'Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

  const fetchOrders = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/orders`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      // Sort orders by date descending by default
      const sortedData = data.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate));
      setOrders(sortedData);
    } catch (error) {
      console.error('Error fetching orders:', error);
      showToast('Failed to fetch orders.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const handleUpdateOrderStatus = async (orderId, newStatus) => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/orders/${orderId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to update order status.');
      }
      await fetchOrders();
      showToast('Order status updated successfully!', 'success');
      // If the details modal is open for this order, update its status
      if (selectedOrder && selectedOrder._id === orderId) {
        setSelectedOrder(prev => ({ ...prev, status: newStatus }));
      }
    } catch (error) {
      console.error('Error updating order status:', error);
      showToast(error.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const openOrderDetailsModal = (order) => {
    setSelectedOrder(order);
    setIsDetailsModalOpen(true);
  };

  const closeOrderDetailsModal = () => {
    setIsDetailsModalOpen(false);
    setSelectedOrder(null);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'Pending': return 'bg-yellow-600 text-yellow-100';
      case 'Confirmed': return 'bg-blue-600 text-blue-100';
      case 'Preparing': return 'bg-purple-600 text-purple-100';
      case 'Out for Delivery': return 'bg-indigo-600 text-indigo-100';
      case 'Delivered': return 'bg-green-600 text-green-100';
      case 'Cancelled': return 'bg-red-600 text-red-100';
      default: return 'bg-gray-600 text-gray-100';
    }
  };

  const filteredOrders = orders
    .filter(order =>
      (filterStatus === 'All' || order.status === filterStatus) &&
      (order.customerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
       order.customerId.toLowerCase().includes(searchTerm.toLowerCase()) ||
       order._id.toString().toLowerCase().includes(searchTerm.toLowerCase()))
    );

  return (
    <div>
      <h1 className="text-3xl font-bold text-white mb-8">Order Management</h1>

      <div className="bg-gray-800 p-6 rounded-lg shadow-md mb-6">
        <div className="flex flex-col md:flex-row justify-between items-center mb-4 gap-4">
          <input
            type="text"
            placeholder="Search orders by customer or ID..."
            className="w-full md:w-1/2 p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 placeholder-gray-400 focus:outline-none focus:border-tomato-500"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <div className="flex flex-col md:flex-row gap-4 w-full md:w-1/2 md:justify-end">
            <select
              className="p-3 rounded-md bg-gray-700 border border-gray-600 text-gray-100 focus:outline-none focus:border-tomato-500"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              {orderStatuses.map(status => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <button
              onClick={fetchOrders}
              className="bg-gray-700 hover:bg-gray-600 text-gray-100 font-semibold py-3 px-5 rounded-md flex items-center justify-center transition-colors shadow-md"
            >
              <RefreshCw className="w-5 h-5 mr-2" />
              Refresh Orders
            </button>
          </div>
        </div>

        {isLoading ? (
          <LoadingSpinner />
        ) : filteredOrders.length === 0 ? (
          <p className="text-center text-gray-400 py-8">No orders found matching your criteria.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="min-w-full divide-y divide-gray-700">
              <thead className="bg-gray-700">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Order ID
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Customer
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Items
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Total
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Status
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Date
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-gray-800 divide-y divide-gray-700">
                {filteredOrders.map((order) => (
                  <tr key={order._id} className="hover:bg-gray-700 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap text-gray-200">
                      {order._id.substring(0, 8)}...
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-gray-200 font-medium">{order.customerName}</div>
                      <div className="text-gray-400 text-sm">{order.customerId.split('@')[0]}</div>
                    </td>
                    <td className="px-6 py-4">
                      <ul className="list-disc list-inside text-gray-300 text-sm">
                        {order.items.slice(0, 2).map((item, idx) => (
                          <li key={idx}>
                            {item.name} (x{item.quantity})
                          </li>
                        ))}
                        {order.items.length > 2 && (
                          <li className="text-gray-400">...and {order.items.length - 2} more</li>
                        )}
                      </ul>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-200 font-medium">
                      Rs. {order.totalAmount.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusColor(order.status)}`}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-gray-300 text-sm">
                      {new Date(order.orderDate).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <button
                        onClick={() => openOrderDetailsModal(order)}
                        className="text-blue-400 hover:text-blue-500 mr-3 p-2 rounded-md hover:bg-gray-600 transition-colors"
                        title="View Details"
                      >
                        <ClipboardList className="w-5 h-5" />
                      </button>
                      <StatusDropdown
                        currentStatus={order.status}
                        onStatusChange={(newStatus) => handleUpdateOrderStatus(order._id, newStatus)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isDetailsModalOpen && selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={closeOrderDetailsModal}
          onStatusChange={handleUpdateOrderStatus}
          getStatusColor={getStatusColor}
        />
      )}
    </div>
  );
};

// Status Dropdown for Order Table
const StatusDropdown = ({ currentStatus, onStatusChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const statuses = ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

  return (
    <div className="relative inline-block text-left z-10">
      <div>
        <button
          type="button"
          className="inline-flex justify-center w-full rounded-md border border-gray-600 shadow-sm px-4 py-2 bg-gray-700 text-sm font-medium text-gray-300 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-tomato-500"
          onClick={() => setIsOpen(!isOpen)}
        >
          Update Status
          {isOpen ? (
            <ChevronUp className="-mr-1 ml-2 h-5 w-5" />
          ) : (
            <ChevronDown className="-mr-1 ml-2 h-5 w-5" />
          )}
        </button>
      </div>

      {isOpen && (
        <div className="origin-top-right absolute right-0 mt-2 w-48 rounded-md shadow-lg bg-gray-800 ring-1 ring-black ring-opacity-5 focus:outline-none">
          <div className="py-1">
            {statuses.map((status) => (
              <button
                key={status}
                onClick={() => {
                  onStatusChange(status);
                  setIsOpen(false);
                }}
                className={`block w-full text-left px-4 py-2 text-sm ${
                  status === currentStatus
                    ? 'bg-tomato-700 text-white'
                    : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                }`}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Order Details Modal
const OrderDetailsModal = ({ order, onClose, onStatusChange, getStatusColor }) => {
  const [newStatus, setNewStatus] = useState(order.status);

  const handleStatusChange = (status) => {
    setNewStatus(status);
    onStatusChange(order._id, status);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 p-8 rounded-lg shadow-xl w-full max-w-2xl relative">
        <h2 className="text-2xl font-bold text-white mb-6">
          Order Details - ID: {order._id.substring(0, 10)}...
        </h2>
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-100 transition-colors"
        >
          <XCircle className="w-6 h-6" />
        </button>

        <div className="space-y-6">
          {/* Customer Info */}
          <div className="bg-gray-700 p-5 rounded-lg">
            <h3 className="text-lg font-semibold text-tomato-400 mb-3">Customer Information</h3>
            <p className="text-gray-200">
              <span className="font-medium">Name:</span> {order.customerName}
            </p>
            <p className="text-gray-200">
              <span className="font-medium">Phone:</span>{' '}
              <a
                href={`tel:${order.customerId.split('@')[0]}`}
                className="text-blue-400 hover:underline"
              >
                {order.customerId.split('@')[0]}
              </a>
            </p>
          </div>

          {/* Order Summary */}
          <div className="bg-gray-700 p-5 rounded-lg">
            <h3 className="text-lg font-semibold text-tomato-400 mb-3">Order Summary</h3>
            <ul className="divide-y divide-gray-600">
              {order.items.map((item, index) => (
                <li key={index} className="py-2 flex justify-between items-center text-gray-200">
                  <span>
                    {item.name} (x{item.quantity})
                  </span>
                  <span>Rs. {(item.price * item.quantity).toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 pt-4 border-t border-gray-600 text-right">
              <p className="text-xl font-bold text-white">
                Total Amount: Rs. {order.totalAmount.toFixed(2)}
              </p>
            </div>
          </div>

          {/* Status & Actions */}
          <div className="bg-gray-700 p-5 rounded-lg flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h3 className="text-lg font-semibold text-tomato-400 mb-2">Order Status</h3>
              <span className={`px-4 py-2 inline-flex text-sm leading-5 font-semibold rounded-full ${getStatusColor(newStatus)}`}>
                {newStatus}
              </span>
              <p className="text-gray-400 text-sm mt-1">
                Ordered on: {new Date(order.orderDate).toLocaleString()}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <label htmlFor="status-select" className="sr-only">Change Status</label>
              <select
                id="status-select"
                value={newStatus}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="p-3 rounded-md bg-gray-600 border border-gray-500 text-gray-100 focus:outline-none focus:border-tomato-500"
              >
                {['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'].map(
                  (status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-6 py-3 rounded-md bg-gray-700 text-gray-100 hover:bg-gray-600 font-semibold transition-colors shadow-md"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};


// Main App Component
const App = () => {
  const [currentView, setCurrentView] = useState('dashboard'); // Default view
  const [toast, setToast] = useState(null);

  const showToast = useCallback((message, type) => {
    setToast({ message, type });
  }, []);

  const renderView = () => {
    switch (currentView) {
      case 'dashboard':
        return (
          <div className="bg-gray-800 p-6 rounded-lg shadow-md">
            <h1 className="text-3xl font-bold text-white mb-6">Dashboard Overview</h1>
            <p className="text-gray-300">
              Welcome to your Food Business Admin Dashboard! Use the navigation on the left to manage your WhatsApp bots, menu, and orders.
            </p>
            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="p-6 bg-gray-700 rounded-lg shadow-md">
                    <h2 className="text-xl font-semibold text-tomato-400 mb-2">Quick Access</h2>
                    <ul className="space-y-2">
                        <li>
                            <button onClick={() => setCurrentView('whatsapp')} className="text-blue-400 hover:text-blue-300 flex items-center">
                                <MessageCircleMore className="w-5 h-5 mr-2" /> Check Bot Status
                            </button>
                        </li>
                        <li>
                            <button onClick={() => setCurrentView('menu')} className="text-blue-400 hover:text-blue-300 flex items-center">
                                <Utensils className="w-5 h-5 mr-2" /> Manage Menu
                            </button>
                        </li>
                        <li>
                            <button onClick={() => setCurrentView('orders')} className="text-blue-400 hover:text-blue-300 flex items-center">
                                <ClipboardList className="w-5 h-5 mr-2" /> View Orders
                            </button>
                        </li>
                    </ul>
                </div>
                <div className="p-6 bg-gray-700 rounded-lg shadow-md">
                    <h2 className="text-xl font-semibold text-tomato-400 mb-2">Recent Activity</h2>
                    <p className="text-gray-300 text-sm">
                        * New Order #12345 (Pending) - 5 mins ago<br/>
                        * Bot 1 Connected - 1 hour ago<br/>
                        * Menu Item "Spicy Noodles" updated - Yesterday
                    </p>
                    <p className="text-gray-400 text-xs mt-4">
                        (This section would dynamically show recent activities from your backend logs/data.)
                    </p>
                </div>
                <div className="p-6 bg-gray-700 rounded-lg shadow-md">
                    <h2 className="text-xl font-semibold text-tomato-400 mb-2">Key Metrics</h2>
                    <p className="text-gray-300 text-sm">
                        * Today's Orders: <span className="font-bold text-tomato-300">5</span><br/>
                        * Total Revenue (Today): <span className="font-bold text-green-400">Rs. 1,250.00</span><br/>
                        * Active Bots: <span className="font-bold text-blue-400">2/2</span>
                    </p>
                    <p className="text-gray-400 text-xs mt-4">
                        (This section would dynamically show real-time or daily statistics.)
                    </p>
                </div>
            </div>
          </div>
        );
      case 'whatsapp':
        return <WhatsAppPanel showToast={showToast} />;
      case 'menu':
        return <MenuPanel showToast={showToast} />;
      case 'orders':
        return <OrdersPanel showToast={showToast} />;
      default:
        return null;
    }
  };

  return (
    <>
      <DashboardLayout currentView={currentView} setCurrentView={setCurrentView}>
        {renderView()}
      </DashboardLayout>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </>
  );
};

export default App;

// Ensure the root element exists in your HTML (e.g., <div id="root"></div>)
// const container = document.getElementById('root');
// const root = createRoot(container);
// root.render(<App />);

