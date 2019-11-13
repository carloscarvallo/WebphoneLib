import { EventEmitter } from 'events';
import pTimeout from 'p-timeout';

import {
  C as SIPConstants,
  Core,
  Grammar,
  IncomingResponse,
  NameAddrHeader,
  SessionDescriptionHandlerModifiers,
  TypeStrings as SIPTypeStrings,
  Utils
} from 'sip.js';

import { Invitation } from 'sip.js/lib/api/invitation'; // not available in pre-combiled bundles just yet
import { Inviter } from 'sip.js/lib/api/inviter'; // not available in pre-combiled bundles just yet
import { InviterInviteOptions } from 'sip.js/lib/api/inviter-invite-options'; // not available in pre-combiled bundles just yet
import { Session as UserAgentSession } from 'sip.js/lib/api/session'; // not available in pre-combiled bundles just yet
import { SessionState } from 'sip.js/lib/api/session-state'; // not available in pre-combiled bundles just yet
import { SessionStatus } from './enums';
import { createFrozenProxy } from './lib/freeze';
import { log } from './logger';
import { checkAudioConnected } from './session-health';
import { InternalSession, SessionMedia } from './session-media';
import { SessionStats } from './session-stats';
import * as Time from './time';
import { IMedia, IRemoteIdentity } from './types';
import { WrappedInviteClientContext, WrappedInviteServerContext } from './ua';

export interface ISession {
  readonly id: string;
  readonly media: SessionMedia;
  readonly stats: SessionStats;
  readonly audioConnected: Promise<void>;
  readonly isIncoming: boolean;
  saidBye: boolean;
  holdState: boolean;
  status: SessionStatus;

  /**
   * The remote identity of this session.
   * @returns {IRemoteIdentity}
   */
  remoteIdentity: IRemoteIdentity;

  /**
   * @returns {boolean} if auto answer is on for this session.
   */
  autoAnswer: boolean;

  /**
   * @returns {string} Phone number of the remote identity.
   */
  phoneNumber: string;

  /**
   * @returns {Date} Starting time of the call.
   */
  startTime: any;

  /**
   * @returns {Date} End time of the call.
   */
  endTime: any;

  // TODO
  //accept(): Promise<void>;
  //reject(): Promise<void>;
  /**
   * Terminate the session.
   */
  //terminate(): Promise<void>;

  /**
   * Promise that resolves when the session is accepted or rejected.
   * @returns Promise<ISessionAccept>
   */
  accepted(): Promise<ISessionAccept>;

  /**
   * Promise that resolves when the session is terminated.
   */
  terminated(): Promise<void>;

  reinvite(): Promise<void>;

  /**
   * Put the session on hold.
   */
  hold(): Promise<boolean>;

  /**
   * Take the session out of hold.
   */
  unhold(): Promise<boolean>;

  /**
   * Blind transfer the current session to a target number.
   * @param {string} target - Number to transfer to.
   */
  // TODO
  //blindTransfer(target: string): Promise<boolean>;
  bye(): void;

  /**
   * Send one or more DTMF tones.
   * @param tones May only contain the characters `0-9A-D#*,`
   */
  dtmf(tones: string): void;

  /* tslint:disable:unified-signatures */
  on(event: 'terminated', listener: ({ id: string }) => void): this;
  on(event: 'statusUpdate', listener: (session: { id: string; status: string }) => void): this;
  on(event: 'callQualityUpdate', listener: ({ id: string }, stats: SessionStats) => void): this;
  on(
    event: 'remoteIdentityUpdate',
    listener: ({ id: string }, remoteIdentity: IRemoteIdentity) => void
  ): this;
  /* tslint:enable:unified-signatures */
}

export enum SessionCause {
  BUSY = 'busy',
  REJECTED = 'rejected',
  UNAVAILABLE = 'unavailable',
  CANCELLED = 'cancelled',
  CALL_COMPLETED_ELSEWHERE = 'call_completed_elsewhere',
  NOT_FOUND = 'not_found',
  REDIRECTED = 'redirected',
  NO_ANSWER = 'no_answer',
  REQUEST_TERMINATED = 'request_terminated',
  TEMPORARILY_UNAVAILABLE = 'temporarily_unavailable'
}

const CAUSE_MAPPING = {
  [SIPConstants.causes.BUSY]: SessionCause.BUSY,
  [SIPConstants.causes.REJECTED]: SessionCause.REJECTED,
  [SIPConstants.causes.UNAVAILABLE]: SessionCause.UNAVAILABLE,
  [SIPConstants.causes.NOT_FOUND]: SessionCause.NOT_FOUND,
  [SIPConstants.causes.REDIRECTED]: SessionCause.REDIRECTED,
  [SIPConstants.causes.CANCELED]: SessionCause.CANCELLED,
  [SIPConstants.causes.NO_ANSWER]: SessionCause.NO_ANSWER,
  'Temporarily Unavailable': SessionCause.TEMPORARILY_UNAVAILABLE
};

const CAUSE_ERRORS: string[] = [
  SIPConstants.causes.CONNECTION_ERROR,
  SIPConstants.causes.INTERNAL_ERROR,
  SIPConstants.causes.REQUEST_TIMEOUT,
  SIPConstants.causes.AUTHENTICATION_ERROR,
  SIPConstants.causes.ADDRESS_INCOMPLETE,
  SIPConstants.causes.DIALOG_ERROR,
  SIPConstants.causes.INCOMPATIBLE_SDP,
  SIPConstants.causes.BAD_MEDIA_DESCRIPTION,
  SIPConstants.causes.EXPIRES,
  SIPConstants.causes.NO_ACK,
  SIPConstants.causes.NO_PRACK,
  SIPConstants.causes.RTP_TIMEOUT,
  SIPConstants.causes.USER_DENIED_MEDIA_ACCESS,
  SIPConstants.causes.WEBRTC_ERROR,
  SIPConstants.causes.WEBRTC_NOT_SUPPORTED,
  SIPConstants.causes.SIP_FAILURE_CODE
];

interface ISessionAccept {
  accepted: boolean;
  rejectCause?: SessionCause;
}

/**
 * @hidden
 */
export class SessionImpl extends EventEmitter implements ISession {
  public readonly id: string;
  public readonly media: SessionMedia;
  public readonly stats: SessionStats;
  public readonly audioConnected: Promise<void>;
  public readonly isIncoming: boolean;
  public saidBye: boolean;
  public holdState: boolean;
  public status: SessionStatus = SessionStatus.RINGING;

  private session: Inviter | Invitation;
  private acceptedSession: any;
  private inviteOptions: InviterInviteOptions;

  private acceptedPromise: Promise<ISessionAccept>;
  private acceptPromise: Promise<void>;
  private progressedPromise: Promise<void>;
  private rejectPromise: Promise<void>;
  private terminatedPromise: Promise<void>;
  private reinvitePromise: Promise<boolean>;

  private onTerminated: (sessionId: string) => void;
  private _remoteIdentity: IRemoteIdentity;

  constructor({
    session,
    media,
    onTerminated,
    isIncoming
  }: {
    session: Inviter;
    media: IMedia;
    onTerminated: (sessionId: string) => void;
    isIncoming: boolean;
  }) {
    super();
    this.session = session;
    this.id = session.request.callId;
    this.media = new SessionMedia(this.session, media);
    this.media.on('mediaFailure', () => {
      // TODO: fix this so it doesn't `reject` the `terminatedPromise`?
      //this.session.terminate();
    });
    this.onTerminated = onTerminated;
    this.isIncoming = isIncoming;

    this.progressedPromise = new Promise(progressResolve => {
      this.acceptedPromise = new Promise((acceptedResolve, acceptedReject) => {
        this.inviteOptions = this.makeInviteOptions({
          onAccept: acceptedResolve,
          onReject: acceptedResolve,
          onRejectThrow: acceptedReject,
          onProgress: progressResolve
        });
      });
    });

    // Terminated promise will resolve when the session is terminated. It will
    // be rejected when there is some fault is detected with the session after it
    // has been accepted.
    this.terminatedPromise = new Promise((resolve, reject) => {
      this.session.stateChange.on((newState: SessionState) => {
        console.log(`State changed to ${newState}`);
        if (newState === SessionState.Terminated) {
          this.onTerminated(this.id);
          this.emit('terminated', { id: this.id });
          this.status = SessionStatus.TERMINATED;
          this.emit('statusUpdate', { id: this.id, status: this.status });

          resolve();
        }
      });

      //this.session.once('terminated', (message, cause) => {
      //  this.onTerminated(this.id);
      //  this.emit('terminated', { id: this.id });
      //  this.status = SessionStatus.TERMINATED;
      //  this.emit('statusUpdate', { id: this.id, status: this.status });

      //  // Asterisk specific header that signals that the VoIP account used is not
      //  // configured for WebRTC.
      //  if (cause === 'BYE' && message.getHeader('X-Asterisk-Hangupcausecode') === '58') {
      //    reject(new Error('misconfigured_account'));
      //  } else {
      //    resolve();
      //  }
      //});
    });

    this._remoteIdentity = this.getRemoteIdentity(this.session.request);

    // TODO
    //this.session.on('reinvite', (_, request) => {
    //  this._remoteIdentity = this.getRemoteIdentity(request);
    //  this.emit('remoteIdentityUpdate', this, this._remoteIdentity);
    //});

    // Track if the other side said bye before terminating.
    this.saidBye = false;
    this.session.once('bye', () => {
      this.saidBye = true;
    });

    this.holdState = false;

    // Session stats will calculate a MOS value of the inbound channel every 5
    // seconds.
    // TODO: make this setting configurable.
    this.stats = new SessionStats(this.session, {
      statsInterval: 5 * Time.second
    });
    this.stats.on('statsUpdated', () => {
      this.emit('callQualityUpdate', { id: this.id }, this.stats);
    });

    // Promise that will resolve when the session's audio is connected.
    // TODO: make these settings configurable.
    this.audioConnected = checkAudioConnected(this.session, {
      checkInterval: 0.5 * Time.second,
      noAudioTimeout: 10 * Time.second
    });
  }

  get remoteIdentity(): IRemoteIdentity {
    return this._remoteIdentity;
  }

  get autoAnswer(): boolean {
    const callInfo = this.session.request.headers['Call-Info'];
    if (callInfo && callInfo[0] && callInfo[0]) {
      // ugly, not sure how to check if object with TS agreeing on my methods
      return (callInfo[0] as { parsed?: any; raw: string }).raw.includes('answer-after=0');
    }

    return false;
  }

  get phoneNumber(): string {
    if (this.isIncoming) {
      return this.remoteIdentity.phoneNumber;
    } else {
      return this.session.request.to.uri.user;
    }
  }

  get startTime(): Date {
    return this.session.startTime;
  }

  get endTime(): Date {
    return this.session.endTime;
  }

  // TODO
  //public accept(): Promise<void> {
  //  if (this.rejectPromise) {
  //    throw new Error('invalid operation: session is rejected');
  //  }

  //  if (this.acceptPromise) {
  //    return this.acceptPromise;
  //  }

  //  this.acceptPromise = new Promise((resolve, reject) => {
  //    const handlers = {
  //      onAnswered: () => {
  //        this.session.removeListener('failed', handlers.onFail);
  //        resolve();
  //      },
  //      onFail: (response: IncomingResponse, cause: string) => {
  //        this.session.removeListener('accepted', handlers.onAnswered);
  //        try {
  //          reject(this.findCause(response, cause));
  //        } catch (e) {
  //          log.error(`Accepting session failed: ${e}`, this.constructor.name);
  //          reject(e);
  //        }
  //      }
  //    };
  //    this.session.once('accepted', handlers.onAnswered);
  //    this.session.once('failed', handlers.onFail);

  //    this.session.accept();
  //  });

  //  return this.acceptPromise;
  //}
  //
  //public reject(): Promise<void> {
  //  if (this.acceptPromise) {
  //    throw new Error('invalid operation: session is accepted');
  //  }

  //  if (this.rejectPromise) {
  //    return this.rejectPromise;
  //  }

  //  this.rejectPromise = new Promise(resolve => {
  //    this.session.once('rejected', () => resolve());
  //    // reject is immediate, it doesn't fail.
  //    this.session.reject();
  //  });

  //  return this.rejectPromise;
  //}

  public progressed(): Promise<void> {
    return this.progressedPromise;
  }

  public accepted(): Promise<ISessionAccept> {
    return this.acceptedPromise;
  }

  public terminated(): Promise<void> {
    return this.terminatedPromise;
  }

  //public terminate(): Promise<void> {
  //  this.session.terminate();
  //  return this.terminatedPromise;
  //}

  public invite(): Promise<Core.OutgoingInviteRequest> {
    this.acceptedSession = this.session.invite(this.inviteOptions);
    return this.acceptedSession;
  }

  public async reinvite(modifiers: SessionDescriptionHandlerModifiers = []): Promise<void> {
    console.log('trying to invite again');

    await new Promise((resolve, reject) => {
      this.session.invite(
        this.makeInviteOptions({
          onAccept: resolve,
          onReject: reject,
          onRejectThrow: reject,
          onProgress: resolve,
          sessionDescriptionHandlerModifiers: modifiers
        })
      );
    });
    console.log('invited again!');
  }

  public hold(): Promise<boolean> {
    return this.setHoldState(true);
  }

  public unhold(): Promise<boolean> {
    return this.setHoldState(false);
  }

  // TODO
  //public async blindTransfer(target: string): Promise<boolean> {
  //  return this.transfer(target);
  //}

  public async attendedTransfer(target: SessionImpl): Promise<boolean> {
    return this.transfer(target.session);
  }

  /**
   * Reconfigure the WebRTC peerconnection.
   */
  public rebuildSessionDescriptionHandler() {
    console.log('rebuilding');
    (this.session as any)._sessionDescriptionHandler = undefined;
    (this.session as any).setupSessionDescriptionHandler();
  }

  /**
   * Function this.session.bye triggers terminated, so nothing else has to be
   * done here.
   */
  public bye() {
    this.session.bye();
  }

  public dtmf(tones: string): void {
    // Unfortunately there is no easy way to give feedback about the DTMF
    // tones. SIP.js uses one of two methods for sending the DTMF:
    //
    // 1. RTP (via the SDH)
    // Internally returns a `boolean` for the whole strong.
    //
    // 2. INFO (websocket)
    //
    // Sends one tone after the other where the timeout is determined by the kind
    // of tone send. If one tone fails, the entire sequence is cleared. There is
    // no feedback about the failure.
    // TODO
    //this.session.dtmf(tones);
  }

  public freeze(): ISession {
    return createFrozenProxy({}, this, [
      'audioConnected',
      'autoAnswer',
      'endTime',
      'holdState',
      'id',
      'isIncoming',
      'media',
      'phoneNumber',
      'remoteIdentity',
      'saidBye',
      'startTime',
      'stats',
      'status',

      // TODO 'accept',
      'accepted',
      'attendedTransfer',
      // TODO 'blindTransfer',
      'bye',
      'dtmf',
      'freeze',
      'hold',
      'reinvite',
      // TODO 'reject',
      // TODO 'terminate',
      'terminated',
      'unhold',

      'on',
      'once',
      'removeAllListeners',
      'removeListener'
    ]);
  }

  private makeInviteOptions({
    onAccept,
    onReject,
    onRejectThrow,
    onProgress,
    sessionDescriptionHandlerModifiers = []
  }) {
    return {
      requestDelegate: {
        onAccept: response => {
          console.log('session is accepted1!');
          this.status = SessionStatus.ACTIVE;
          this.emit('statusUpdate', { id: this.id, status: this.status });
          onAccept({ accepted: true });
        },
        onReject: ({ message }: Core.IncomingResponse) => {
          console.log('session is rejected');
          try {
            const cause = Utils.getReasonPhrase(message.statusCode);
            onReject({
              accepted: false,
              rejectCause: this.findCause(message, cause)
            });
          } catch (e) {
            console.log(message);
            log.error(`Session failed: ${e}`, this.constructor.name);
            onReject(e);
          }
        },
        onProgress: inviteResponse => {
          console.log('session is in progress');
          console.log(inviteResponse);
          onProgress();
        }
      },
      sessionDescriptionHandlerOptions: {
        constraints: {
          audio: true,
          video: false
        }
      },
      sessionDescriptionHandlerModifiers
    };
  }

  private async setHoldState(flag: boolean) {
    if (this.holdState === flag) {
      return this.reinvitePromise;
    }

    const modifiers = [];
    if (flag) {
      log.debug('Hold requested', this.constructor.name);
      modifiers.push(this.session.sessionDescriptionHandler.holdModifier);
    } else {
      log.debug('Unhold requested', this.constructor.name);
    }

    await this.reinvite(modifiers);

    this.holdState = flag;

    this.status = flag ? SessionStatus.ON_HOLD : SessionStatus.ACTIVE;
    this.emit('statusUpdate', { id: this.id, status: this.status });

    return this.reinvitePromise;
  }

  /**
   * Generic transfer function that either does a blind or attended
   * transfer. Which kind of transfer is done is dependent on the type of
   * `target` passed.
   *
   * In the case of a BLIND transfer, a string can be passed along with a
   * number.
   *
   * In the case of an ATTENDED transfer, a NEW call should be made. This NEW
   * session (a.k.a. InviteClientContext/InviteServerContext depending on
   * whether it is outbound or inbound) should then be passed to this function.
   *
   * @param {UserAgentSession | string} target - Target to transfer this session to.
   * @returns {Promise<boolean>} Promise that resolves when the transfer is made.
   */
  private async transfer(target: UserAgentSession): Promise<boolean> {
    return pTimeout(this.isTransferredPromise(target), 20000, () => {
      log.error('Could not transfer the call', this.constructor.name);
      return Promise.resolve(false);
    });
  }

  private async isTransferredPromise(target: UserAgentSession) {
    const { referContext, options } = await new Promise((resolve, reject) => {
      this.session.once('referRequested', context => {
        log.debug('Refer is requested', this.constructor.name);
        resolve(context);
      });

      try {
        // TODO
        //this.session.refer(target);
      } catch (e) {
        log.error(e, this.constructor.name);
        // When there are multiple attended transfer requests, it could occur
        // that the status of this session is set by another one of these requests
        // is set to an unexpected state.
        if (e.type === SIPTypeStrings.InvalidStateError) {
          reject();
        }

        throw e;
      }
    });

    return new Promise<boolean>(resolve => {
      const handlers = {
        onReferAccepted: () => {
          log.debug('Refer is accepted', this.constructor.name);
          referContext.removeListener('referRejected', handlers.onReferRejected);
          resolve(true);
        },
        // Refer can be rejected with the following responses:
        // - 503: Service Unavailable (i.e. server can't handle one-legged transfers)
        // - 603: Declined
        onReferRejected: () => {
          log.debug('Refer is rejected', this.constructor.name);
          referContext.removeListener('referAccepted', handlers.onReferAccepted);
          resolve(false);
        }
      };

      referContext.once('referAccepted', handlers.onReferAccepted);
      referContext.once('referRejected', handlers.onReferRejected);

      // Refer after the handlers have been set.
      referContext.refer(options);
    });
  }

  private findCause(response: IncomingResponse, cause: string): SessionCause {
    if (cause === SIPConstants.causes.CANCELED) {
      const reason = parseReason(response.getHeader('Reason'));
      if (reason && reason.get('text') === 'Call completed elsewhere') {
        return SessionCause.CALL_COMPLETED_ELSEWHERE;
      }
    } else if (cause === SIPConstants.causes.SIP_FAILURE_CODE) {
      if (response.statusCode === 487) {
        return SessionCause.REQUEST_TERMINATED;
      } else {
        log.warn(
          `Unknown error: ${response.statusCode} (${response.reasonPhrase})`,
          this.constructor.name
        );
      }
    }

    if (CAUSE_ERRORS.includes(cause)) {
      throw new Error(`Session error: ${cause}`);
    }

    const result = CAUSE_MAPPING[cause];
    if (result) {
      return result;
    }

    log.warn(`Unknown cause: ${cause}`, this.constructor.name);
    return undefined;
  }

  private getRemoteIdentity(request): IRemoteIdentity {
    let identity: NameAddrHeader;
    ['P-Asserted-Identity', 'Remote-Party-Id', 'From'].some(header => {
      if (request.hasHeader(header)) {
        identity = Grammar.nameAddrHeaderParse(request.getHeader(header));
        return true;
      }
    });

    let phoneNumber = this.session.remoteIdentity.uri.user;
    let displayName: string;

    if (identity) {
      phoneNumber = (identity.uri as any).normal.user;
      displayName = identity.displayName;
    }

    return { phoneNumber, displayName };
  }
}

/**
 * Convert a comma-separated string like:
 * `SIP;cause=200;text="Call completed elsewhere` to a Map.
 * @param {string} header - The header to parse.
 * @returns {Map} - A map of key/values of the header.
 */
function parseReason(header?: string): Map<string, string> {
  if (header) {
    return new Map(
      header
        .replace(/"/g, '')
        .split(';')
        .map(i => i.split('=') as [string, string])
    );
  } else {
    return undefined;
  }
}
