class VolumeView extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({
      mode: 'open'
    });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
        }
        #volume {
          display: flex;
          align-items: center;
          cursor: pointer;
          border-radius: 20px;
          padding: 5px;
        }
        #volume > svg {
          height: 20px;
          width: 20px;
        }
        #volume:hover {
          background-color: rgba(0, 0, 0, 0.05);
        }
        #sound {
          width: 0;
          padding-left: 0;
          --percent: 50%;
          /* the click zone spans the whole padded height of the container;
             the negative margins keep the taller box from growing it */
          --hit-padding: 12.5px;
          margin-top: -5px;
          margin-bottom: -5px;
          transition: width .5s, padding-left .5s;
          position: relative;
        }
        #volume:hover > #sound {
          width: 48px;
          padding-left: 5px;
        }
        #volume:hover > #sound:after {
          content: '';
          position: absolute;
          left: 50%;
          top: calc(50% - 2.5px);
          width: 1px;
          height: 5px;
          background-color: #ccc;
          z-index: 1;
          pointer-events: none;
        }
        /* the icon reflects the level; each state hides what it must not
           show (the speaker body is the first path and always visible) */
        #icon[level=mute] path:nth-child(2),
        #icon[level=mute] path:nth-child(3) {
          display: none;
        }
        #icon[level=low] path:nth-child(3),
        #icon[level=low] path:nth-child(4) {
          display: none;
        }
        #icon[level=high] path:nth-child(4) {
          display: none;
        }
      </style>
      <div id="volume">
        <progress-view id="sound"></progress-view>
        <svg id="icon" level="low" viewBox="0 0 48 48">
          <path d="M14 18v12h8l10 10V8L22 18h-8z"/>
          <path d="M37.5 24c0-3.54-2.04-6.58-4-7.4v14.8c1.96-.82 4-3.86 4-7.4z"/>
          <path d="M33.5 6.5v4.1c5.8 1.7 10.5 7.1 10.5 13.4s-4.42 11.7-10.5 13.4v4.1c8-1.8 13.5-9 13.5-17.5s-6.02-15.7-13.5-17.5z"/>
          <path d="M36.74 18.06l9.2 9.2-2.68 2.68-9.2-9.2zM45.94 20.74l-9.2 9.2-2.68-2.68 9.2-9.2z"/>
          <path d="M0 0h48v48H0z" fill="none"/>
        </svg>
      </div>
    `;
    // the level that the mute toggle restores
    this.lastVolume = 1;
  }
  connectedCallback() {
    // the icon follows the startup volume (the slider defaults to 50%)
    this.#level(this.volume);
    const sound = this.shadowRoot.getElementById('sound');
    // a slider click is a user change; the host funnels it like the toggle
    sound.addEventListener('seek', e => {
      this.volume = e.detail / 50;
      this.#report();
    });
    // the icon mutes and unmutes; the remembered level is restored
    this.shadowRoot.getElementById('icon').addEventListener('click', () => this.toggleMute());
  }
  /* report a change that started here; the host decides what it means for
     the gain node and re-reflects the value without another event */
  #report() {
    this.dispatchEvent(new CustomEvent('volumechange', {
      detail: this.volume
    }));
  }
  /* the level of the icon: the speaker carries a cross at zero volume, one
     wave up to 100% and a second wave in the boosted range above it */
  #level(v) {
    const level = v === 0 ? 'mute' : (v <= 1 ? 'low' : 'high');
    this.shadowRoot.getElementById('icon').setAttribute('level', level);
  }
  get volume() {
    return this.shadowRoot.getElementById('sound').percent / 50;
  }
  /* the silent reflect of the host; it must not report or the funnel of
     the host would loop */
  set volume(v) {
    v = Math.max(0, Math.min(2, v));
    if (v > 0) {
      this.lastVolume = v;
    }
    this.shadowRoot.getElementById('sound').seek(v * 50);
    this.#level(v);
  }
  toggleMute() {
    this.volume = this.volume > 0 ? 0 : this.lastVolume;
    this.#report();
  }
}
window.customElements.define('volume-view', VolumeView);
