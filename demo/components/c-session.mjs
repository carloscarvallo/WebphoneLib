import { ActionsProxy, NodesProxy } from '../utils/elementProxies.mjs';
import * as sipClient from '../lib/calling.mjs';
import './c-transfer.mjs';
import { Logger } from '../lib/logging.mjs';
import { empty } from '../lib/dom.mjs';

const logger = new Logger('c-session');

function handleSessionStatusUpdate({ status }) {
  this.status = status;
}

let toggled = 0;
window.customElements.define(
  'c-session',
  class extends HTMLElement {
    static get observedAttributes() {
      return ['session-id'];
    }

    set status(_status) {
      this._status = _status;
      this.className = `status-${_status}`;

      this.nodes.sessionStatus.textContent = _status;
    }

    get status() {
      return this._status;
    }

    constructor() {
      super();

      this.actions = new ActionsProxy(this);
      this.nodes = new NodesProxy(this);
    }

    async handleEvent(e) {
      const {
        target: { dataset }
      } = e;

      if (dataset.action) {
        logger.info(`Clicked ${dataset.action}`);

        switch (dataset.action) {
          case 'accept':
            this.session && (await this.session.accept());
            break;
          case 'reject':
            this.session && (await this.session.reject());
            break;
          case 'cancel':
            this.session && (await this.session.cancel());
            break;
          case 'toggleTransfer':
            if (!this.querySelectorAll('c-transfer').length > 0) {
              const transfer = document.createElement('c-transfer');
              transfer.setAttribute('session-id', this.session.id);
              this.appendChild(transfer);

              this.session.hold();
            } else {
              empty(this.nodes.additionalInterface);
            }
            break;
          case 'toggleDTMF':
            if (!this.querySelectorAll('c-keypad').length > 0) {
              const node = document.createElement('c-keypad');
              node.setAttribute('session-id', this.session.id);
              this.nodes.additionalInterface.appendChild(node);
            } else {
              empty(this.nodes.additionalInterface);
            }
            break;
          case 'hold':
            this.session && this.session.hold();
            break;
          case 'unhold':
            this.session && this.session.unhold();
            break;
          case 'reinvite':
            this.session &&
              (await this.session.reinvite([
                sdp => {
                  //const newSdp = sdp.sdp.replace(
                  //  'a=rtpmap:111 opus/48000/2',
                  //  'a=rtpmap:111 opus/24000/2'
                  //);
                  //

                  const newThingy = { ...sdp, sdp: this.getNewSDP(sdp) };

                  return newThingy;
                }
              ]));
            break;
          case 'hangup':
            this.session && (await this.session.terminate());
            break;
          default:
            break;
        }
      } else if (dataset.key) {
        logger.info(`Pressed: ${dataset.key}`);
        this.session && this.session.dtmf(dataset.key);
      }
    }

    getNewSDP(sdp) {
      console.log(toggled);
      if (toggled >= 2) {
        toggled += 1;

        if (toggled === 4) {
          toggled = 0;
        }
        console.log(sdp.sdp);
        //return sdp.sdp;
        return sdp.sdp.replace('maxaveragebitrate=6000', ' ');
      }

      toggled += 1;
      return sdp.sdp.replace(
        'a=fmtp:111 minptime=10;useinbandfec=1',
        'a=fmtp:111 minptime=10;maxaveragebitrate=6000;useinbandfec=1'
      );
    }

    connectedCallback() {
      const template = document.querySelector('[data-component=c-session]');
      this.appendChild(template.content.cloneNode(true));

      this.nodes.phoneNumber.innerText = this.session.phoneNumber;
      this.nodes.sessionDirection.innerText = this.session.isIncoming
        ? 'incoming call'
        : 'outgoing call';

      [
        this.actions.accept,
        this.actions.reject,
        this.actions.cancel,
        this.actions.toggleTransfer,
        this.actions.toggleDTMF,
        this.actions.hold,
        this.actions.unhold,
        this.actions.reinvite,
        this.actions.hangup,
        this.nodes.additionalInterface
      ].forEach(n => {
        n.addEventListener('click', this);
      });

      this.session.on('statusUpdate', handleSessionStatusUpdate.bind(this));
    }

    disconnectedCallback() {
      [
        this.actions.accept,
        this.actions.reject,
        this.actions.cancel,
        this.actions.toggleTransfer,
        this.actions.toggleDTMF,
        this.actions.hold,
        this.actions.unhold,
        this.actions.reinvite,
        this.actions.hangup,
        this.nodes.additionalInterface
      ].forEach(n => {
        n.removeEventListener('click', this);
      });

      this.session.removeListener('statusUpdate', handleSessionStatusUpdate.bind(this));
    }

    attributeChangedCallback(name, oldValue, newValue) {
      this.session = sipClient.getSession(newValue);
    }
  }
);
