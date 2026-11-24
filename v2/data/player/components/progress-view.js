class ProgressView extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({
      mode: 'open'
    });
    shadow.innerHTML = `
      <style>
        #parent {
          background-color: var(--box-bg-color, #eaeaea);
          height: var(--height, 2px);
          /* an opt-in taller click zone; the paint stays on the thin
             content box */
          padding-top: var(--hit-padding, 0px);
          padding-bottom: var(--hit-padding, 0px);
          background-clip: content-box;
          display: flex;
          position: relative;
          cursor: pointer;
          border-radius: 5px;
        }
        #parent * {
          pointer-events: none;
        }
        #progress {
          background-color: var(--progress-bg-color, #8594ff);
          width: var(--percent, 0%);
          z-index: 1;
          border-radius: 5px;
        }
        .buffer {
          background-color: var(--buffer-bg-color, #ccc);
          position: absolute;
          height: 100%;
        }
      </style>
      <div id="parent">
        <span id="progress"></span>
      </div>
    `;
  }
  addBuffer(range) {
    const span = document.createElement('span');
    span.classList.add('buffer');
    span.style.width = range.width + '%';
    span.style.left = range.start + '%';
    this.shadowRoot.getElementById('parent').appendChild(span);
  }
  seek(percent) {
    this.shadowRoot.getElementById('progress').style.setProperty('--percent', percent + '%');
    this.setAttribute('aria-valuenow', this.value);
  }
  connectedCallback() {
    // the host is the slider: focusable, named by the consumer and
    // configurable in its range so that the volume bar can reuse this view
    this.tabIndex = 0;
    this.setAttribute('role', 'slider');
    this.setAttribute('aria-valuemin', this.min);
    this.setAttribute('aria-valuemax', this.max);
    if (!isNaN(this.percent)) {
      this.setAttribute('aria-valuenow', this.value);
    }

    this.shadowRoot.getElementById('parent').addEventListener('click', e => {
      const {width} = e.target.getBoundingClientRect();
      this.dispatchEvent(new CustomEvent('seek', {
        detail: e.offsetX / width * 100
      }));
    });
    // the slider keyboard; a step moves in percent units and reuses the
    // seek event so that every consumer keeps its own scale
    this.addEventListener('keydown', e => {
      let target = null;
      if (e.code === 'ArrowRight' || e.code === 'ArrowUp') {
        target = Math.min(100, this.percent + this.step);
      }
      else if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') {
        target = Math.max(0, this.percent - this.step);
      }
      else if (e.code === 'Home') {
        target = 0;
      }
      else if (e.code === 'End') {
        target = 100;
      }
      if (target === null) {
        return;
      }
      e.preventDefault();
      this.dispatchEvent(new CustomEvent('seek', {
        detail: target
      }));
    });
  }
  get percent() {
    return parseInt(getComputedStyle(this.shadowRoot.getElementById('progress')).getPropertyValue('--percent'));
  }
  get min() {
    return Number(this.getAttribute('min') || 0);
  }
  get max() {
    return Number(this.getAttribute('max') || 100);
  }
  get step() {
    return Number(this.getAttribute('step') || 1);
  }
  /* the slider value on the scale of the consumer */
  get value() {
    return Math.round((this.min + (this.max - this.min) * this.percent / 100) * 100) / 100;
  }
}
window.customElements.define('progress-view', ProgressView);
