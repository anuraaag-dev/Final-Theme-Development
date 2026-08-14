(function () {
  const STORAGE_KEY = 'wishlist_handles';

  function getWishlist() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveWishlist(handles) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(handles));
    document.dispatchEvent(new CustomEvent('wishlist:updated', { detail: { handles } }));
  }

  function isInWishlist(handle) {
    return getWishlist().includes(handle);
  }

  function toggleWishlist(handle) {
    let handles = getWishlist();
    if (handles.includes(handle)) {
      handles = handles.filter((h) => h !== handle);
    } else {
      handles.push(handle);
    }
    saveWishlist(handles);
    return handles.includes(handle);
  }

  function updateButtonState(button) {
    const handle = button.getAttribute('data-product-handle');
    const active = isInWishlist(handle);
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active);
  }

  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-wishlist-button]');
    if (!button) return;
    e.preventDefault();
    toggleWishlist(button.getAttribute('data-product-handle'));
    document.querySelectorAll('[data-wishlist-button]').forEach(updateButtonState);
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-wishlist-button]').forEach(updateButtonState);
  });

  document.addEventListener('wishlist:updated', () => {
    document.querySelectorAll('[data-wishlist-count]').forEach((el) => {
      el.textContent = getWishlist().length;
      el.hidden = getWishlist().length === 0;
    });
  });

  window.Wishlist = { getWishlist, toggleWishlist, isInWishlist };
})();