class SizeGuideBlock extends HTMLElement {
  connectedCallback() {
    this.dialog = this.querySelector('[data-size-guide-dialog]');
    this.openButton = this.querySelector('[data-size-guide-open]');
    this.closeButton = this.querySelector('[data-size-guide-close]');
    this.unitButtons = this.querySelectorAll('[data-size-guide-unit]');
    this.valueCells = this.querySelectorAll('[data-size-guide-value]');
    this.table = this.querySelector('[data-size-guide-table]');

    this.openButton?.addEventListener('click', () => this.open());
    this.closeButton?.addEventListener('click', () => this.close());

    this.unitButtons.forEach((button) => {
      button.addEventListener('click', () => this.setUnit(button.dataset.sizeGuideUnit));
    });

    // Close when clicking the backdrop (outside the dialog's content box)
    this.dialog?.addEventListener('click', (event) => {
      const rect = this.dialog.getBoundingClientRect();
      const clickedInsideContent =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!clickedInsideContent) this.close();
    });
  }

  open() {
    if (this.dialog && typeof this.dialog.showModal === 'function') {
      this.dialog.showModal();
    }
  }

  close() {
    this.dialog?.close();
  }

  setUnit(unit) {
    this.unitButtons.forEach((button) => {
      const isActive = button.dataset.sizeGuideUnit === unit;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    this.valueCells.forEach((cell) => {
      const value = unit === 'cm' ? cell.dataset.cm : cell.dataset.in;
      cell.textContent = value || '—';
    });

    if (this.table) this.table.dataset.unit = unit;
  }
}

customElements.define('size-guide-block', SizeGuideBlock);