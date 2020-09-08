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
  }
  connectedCallback() {
    this.shadowRoot.getElementById('parent').addEventListener('click', e => {
      const {width} = e.target.getBoundingClientRect();
      this.dispatchEvent(new CustomEvent('seek', {
        detail: e.offsetX / width * 100
      }));
    });
  }
  get percent() {
    return parseInt(getComputedStyle(this.shadowRoot.getElementById('progress')).getPropertyValue('--percent'));
  }
}
window.customElements.define('progress-view', ProgressView);
