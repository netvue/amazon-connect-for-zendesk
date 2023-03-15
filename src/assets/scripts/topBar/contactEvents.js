import logStamp from '../util/log.js';
import session from './session.js';
import { zafClient } from './zafClient.js';
import appConfig from './appConfig.js';
import appendTicketComments from './appendTicketComments.js';
import newTicket from './newTicket.js';
import ui from './ui.js';
import { resize, determineAssignmentBehavior, popTicket, getFromZD } from './core.js';
import { processOutboundCall } from './outbound.js';
import { processInboundCall } from './inbound.js';
import setAWSCredentials from '../util/credentials.js';
import { displayCallControls } from './callControls.js';
import getChatTranscript from './getChatTranscript.js';
import { convertChatMessage } from './getChatTranscript.js';


let appSettings = {};
let speechAnalysis;

// speech analysis is loaded dynamically in preparation for decoupling in version 2.2
import('../sideBar/speechAnalysis.js')
    .then((module) => { speechAnalysis = module.default })
    .catch((err) => console.log(logStamp('real-time speech analysis is not present and will not be used')));

const setProcessingTab = () => {
    let focusedTab = localStorage.getItem('vf.tabInFocus');
    if (!focusedTab) {
        // user must have cleared the cache or something else unexpected happen
        focusedTab = session.windowId;
        localStorage.setItem('vf.tabInFocus', focusedTab);
        console.error(logStamp('No focused tab! Elected the current one: '), focusedTab);
    }
    if (focusedTab !== session.windowId) {
        console.log(logStamp("Contact will be processed in another, focused tab: "), focusedTab);
        return focusedTab;
    }
    localStorage.setItem('vf.processingTab', session.windowId);
    console.log(logStamp('Claimed contact processing in tab: '), session.windowId);
    return session.windowId;
}

const handleContactConnecting = async () => {
    zafClient.invoke('popover', 'show');
    console.log(logStamp('Contact connecting: '), session.contact);
    if (session.isMonitoring) return;

    session.ticketId = null;

    if (session.contact.inboundConnection) {
        await appConfig.applyAttributes(session);
        appSettings = session.zafInfo.settings;
        console.log(logStamp('handleContactIncoming, pop before connected: '), appSettings.popBeforeCallConnected);
        if (appSettings.popBeforeCallConnected) {
            session.popCompleted = false;
            await processInboundCall(session.contact);
        }
    }
    if (session.contact.outboundConnection) setProcessingTab();
}

const handleContactConnected = async () => {
    if (session.isMonitoring) return;

    if (session.contact.outboundConnection || session.callInProgress)
        await appConfig.applyAttributes(session);
    appSettings = session.zafInfo.settings;

    // enabling pause/resume recording
    if (appSettings.pauseRecording) {
        const errorMessage = await setAWSCredentials(session.contact, appSettings);
        if (!errorMessage) {
            const isCurrentlyRecording = session.callInProgress
                ? localStorage.getItem('vf.currentlyRecording') === 'true'
                : appSettings.pauseRecording;
            displayCallControls({ isCurrentlyRecording });
            console.log(logStamp('pause/resume recording is enabled'));
        } else {
            const message = `${errorMessage}. Pause and resume recording feature will be disabled for this call`;
            zafClient.invoke('notify', message, 'error', { sticky: true });
        }
    }

    if (session.callInProgress) {
        const assignedTicketId = localStorage.getItem('vf.assignedTicketId');
        const userId = localStorage.getItem('vf.viewingUserId');
        console.log(logStamp("Call in progress: "), {
            assignedTicket: assignedTicketId,
            user: userId
        });
        const message = 'Call in progress. Resuming...';
        zafClient.invoke('notify', message, 'notice');
        if (userId) session.user = await getFromZD(`users/${userId}.json`, 'user');
        if (assignedTicketId) {
            session.ticketId = assignedTicketId;
            session.ticketAssigned = true;
            session.contactDetailsAppended = true;
        } else
            zafClient.invoke('popover', 'show');
        const storedAttributes = localStorage.getItem('vf.storedAttributes');
        if (storedAttributes) session.appendedAttributes = JSON.parse(storedAttributes);
    }

    console.log(logStamp('handleContactConnected, pop before connected: '), appSettings.popBeforeCallConnected);

    // check real-time speech analysis support and config
    appSettings.speechAnalysisEnabled = false;
    if (appSettings.speechAnalysis) {
        if (!speechAnalysis) {
            const message = `
                This version of AWS Connector App <br/>
                doesn't supports real-time speech analysis.<br/> 
                Please notify your administrator.
                `;
            zafClient.invoke('notify', message, 'error', { sticky: true });
        } else {
            speechAnalysis.verifyConfig(session.contact);
            if (appSettings.speechAnalysisEnabled) {
                // open speech analysis session
                speechAnalysis.sessionOpen(session.contact);
            }
        }
    }

    if (session.contact.outboundConnection) {
        // console.log(logStamp('handleContactConnected'), "outbound");
        await processOutboundCall(session.contact);
    }

    if (session.contact.inboundConnection) {
        // console.log(logStamp('handleContactConnected'), "inbound");

        if (!appSettings.popBeforeCallConnected)
            await processInboundCall(session.contact);
        else if (session.popCompleted || session.callInProgress) {
            const setupAgentMode = async (noChatUser = false) => {
                if (!session.ticketId) {
                    const userId = localStorage.getItem('vf.viewingUserId');
                    const ticketId = localStorage.getItem('vf.viewingTicketId');
                    if (ticketId || userId || noChatUser)
                        await newTicket.refreshUser(ticketId ? 'ticket' : 'user', ticketId || userId)
                }
                resize('full');
            }
            
            const autoAssignTickets = determineAssignmentBehavior();
            if (autoAssignTickets) {
                if (!session.user)
                    // create new user if necessary
                    await newTicket.handleNewUser(session.contact);
                    if (session.contact.mediaType === "chat" && !session.user) 
                        return setupAgentMode(true);
                if (!session.ticketId)
                    // create new ticket if necessary
                    session.ticketId = await newTicket.createTicket().catch((err) => null); //TODO: handle these errors
                if (session.ticketId) {
                    // assign this ticket to call and attach contact details automatically
                    if (!session.callInProgress)
                        await appendTicketComments.appendContactDetails(session.contact, session.ticketId);
                    await popTicket(session.zenAgentId, session.ticketId);
                    if (session.contact.mediaType !== "chat")
                        zafClient.invoke('popover', 'hide');
                }
            } else {
                setupAgentMode();
            }

        }
    }
}

const handleContactEnded = async () => {
    console.log(logStamp('handleContactEnded, session.state.connected: '), session.state.connected);
    if (!session.state.connected) {
        // clear session for any rejected or missed calls
        session.clear();
        return;
    }

    session.state.connected = false;
    // cleanup session data for the next call
    if (appSettings.speechAnalysisEnabled) {
        console.log(logStamp('handleContactEnded'), 'attempting to close webSocket session');
        await speechAnalysis.sessionClose();
    }

    const outbound = session.contact.outboundConnection;
    const unassignedOutboundCall = outbound && !session.user && !appSettings.createOnAllOutbound;
    console.log(logStamp('handleContactEnded'), outbound
        ? 'outbound'
        : (session.contact.inboundConnection
            ? 'inbound'
            : 'monitoring'));

    if (session.ticketId && session.ticketAssigned) {
        // add assembled information and analysis to ticket
        await appendTicketComments.appendTheRest(session.contact, session.ticketId);
        if (appSettings.speechAnalysisEnabled)
            speechAnalysis.updateTicketAttribute(session.ticketId.toString());
    } else if (appSettings.forceTicketCreation && !session.isMonitoring && !unassignedOutboundCall) {
        // manual assignment mode, the agent has forgotten to assign - force ticket creation (if configured)
        // set the agent as a requester
        session.user = { name: session.contact.customerNo, id: null }
        const ticketId = await newTicket.createTicket().catch((err) => null); //TODO: handle these errors
        if (ticketId) {
            await appendTicketComments.appendContactDetails(session.contact, ticketId, false); // don't open the apps tray here
            await appendTicketComments.appendTheRest(session.contact, ticketId);
            if (appSettings.speechAnalysisEnabled)
                speechAnalysis.updateTicketAttribute(ticketId.toString());
        }
    }

    resize('contactEnded');
    newTicket.setRequesterName(null);
    ui.enable('attachToCurrentBtn', false);
    zafClient.invoke('popover', 'show');
    // initialize new session
    session.clear();
}

const handleIncomingCallback = async () => {
    // console.log(logStamp(`handleIncomingCallback`));
    zafClient.invoke('popover', 'show');
}

const handleContactAccepted = async () => {
    // console.log(logStamp(`handleContactAccepted`));
    setProcessingTab();
}

const logContactState = (contact, handlerName, description) => {
    if (contact)
        console.log(logStamp(handlerName), `${description}. Contact state is ${contact.getStatus ? contact.getStatus().type : 'undefined'}`);
    else
        console.error(logStamp(handlerName), `${description}. Null contact passed to event handler`);
}

export default (contact) => {

    try {

        if (session.contact && session.contact.mediaType === 'chat') {
            console.error(logStamp('agent is already handling another chat, aborting! '));
            const message = `Multiple concurrent chats are not supported.
            Please reject this chat and reconfigure your routing profile in Connect accordingly.`;
            zafClient.invoke('notify', message, 'error', { sticky: true });
            return;
        }

        const agentStatus = session.agent.getStatus().name;
        // abort if loaded into after call work
        if (agentStatus.toLowerCase() === "aftercallwork") {
            console.warn(logStamp('agent is in After Call Work, aborting! '));
            return;
        }    

        if (agentStatus.toLowerCase() === 'busy') {
            // call in progress
            console.warn(logStamp('call in progress!'));
            session.callInProgress = true;
        }    

        session.contact = contact;
        const currentContact = session.contact;
        currentContact.contactId = contact.getContactId();

        currentContact.snapshot = contact.toSnapshot();
        const contactData = currentContact.snapshot.contactData;
        currentContact.inboundConnection = contactData.connections.find((connection) => connection.type === 'inbound');
        currentContact.outboundConnection = contactData.connections.find((connection) => connection.type === 'outbound');

        // don't create tickets for supervisors monitoring calls
        session.isMonitoring = !(currentContact.outboundConnection || currentContact.inboundConnection);
        console.log(logStamp('is it monitoring? '), session.isMonitoring);

        const connection = contact.getConnections()
            .find((connection) => (
                connection.connectionId === currentContact.inboundConnection?.connectionId ||
                connection.connectionId === currentContact.outboundConnection?.connectionId
            ));
        currentContact.mediaType = connection?.getMediaType();

        // check that the region has been configured for chats
        appSettings = session.zafInfo.settings;
        if (currentContact.mediaType === "chat" && !appSettings.region) {
            console.error(logStamp(`region hasn't been configured, aborting! `));
            const message = `AWS region needs to be configured for chat support.
            Please ask your administrator to update your app configuration.`;
            zafClient.invoke('notify', message, 'error', { sticky: true });
            return;
        }

        // is this call a transfer?
        session.isTransfer = 
            contactData.type !== "queue_callback" &&
            contactData.initialContactId &&
            contactData.initialContactId !== contactData.contactId;
        currentContact.initialContactId = contactData.initialContactId;
        console.log(logStamp('is it a transfer? '), session.isTransfer);

        const endpoint = currentContact.mediaType && currentContact.mediaType !== "chat" && connection?.getEndpoint();
        currentContact.customerNo = endpoint?.phoneNumber;
        if (!(session.isTransfer || currentContact.mediaType === "chat") && !currentContact.customerNo) {
            console.error(logStamp('No phoneNumber on endpoint:'), endpoint);
            const message = 'No phone number detected, defaulting to anonymous.';
            zafClient.invoke('notify', message, 'error', { sticky: true });
            currentContact.customerNo = 'anonymous';
        }

        if (currentContact.mediaType === "chat") {
            console.log(logStamp('Incoming chat:'), contactData);
            currentContact.getAgentConnection().getMediaController().then(async (controller) => {
                session.chatTranscript = await getChatTranscript(controller);
                controller.onMessage(({ data }) => {
                    session.chatTranscript.push(convertChatMessage(data));
                });
            });

        }

    } catch (err) {
        console.error(logStamp("Error on new contact: "), err);
        session.clear();
        const message = 'Unexpected technical error with the new contact. Aborting.';
        zafClient.invoke('notify', message, 'error', { sticky: true });
        return;
    }

    session.state = { connecting: false, callback: false, connected: false, callEnded: false };

    contact.onConnecting((contact) => {
        logContactState(contact, 'handleContactConnecting', 'Contact connecting to agent');
        if (!session.state.connecting) {
            session.state.connecting = true;
            handleContactConnecting()
                .then((result) => result)
                .catch((err) => { console.error(logStamp('handleContactConnecting'), err) });
        }
    });

    contact.onIncoming((contact) => {
        logContactState(contact, 'handleIncomingCallback', 'Contact is incoming as a callback');
        if (!session.state.callback) {
            session.state.callback = true;
            handleIncomingCallback()
                .then((result) => result)
                .catch((err) => { console.error(logStamp('handleIncomingCallback'), err) });
        }
    });

    contact.onAccepted((contact) => {
        logContactState(contact, 'handleContactAccepted', 'Contact accepted by the agent');
        handleContactAccepted()
            .then((result) => result)
            .catch((err) => { console.error(logStamp('handleContactAccepted'), err) });
    });

    contact.onConnected((contact) => {
        let processingTab = localStorage.getItem('vf.processingTab');
        // should have had the processing tab by now, unless agent is using a desk phone
        if (!processingTab) {
            processingTab = setProcessingTab();
        }
        if (processingTab !== session.windowId) {
            return;
        }

        logContactState(contact, 'handleContactConnected', 'Contact connected to agent');
        if (!session.state.connected) {
            session.state.connected = true;
            session.callStarted = contact.toSnapshot().contactData.state.timestamp;
            handleContactConnected()
                .then((result) => result)
                .catch((err) => { console.error(logStamp('handleContactConnected'), err) });
        }
    });

    contact.onEnded((contact) => {
        const processingTab = localStorage.getItem('vf.processingTab');
        if (processingTab !== session.windowId) {
            if (processingTab)
                console.log(logStamp('onEnded is processed in the other tab: '), processingTab)
            else
                console.log(logStamp('onEnded ignored, no processing tab active'))
            session.clear(false);
            return;
        }
        logContactState(contact, 'handleContactEnded', 'Contact has ended successfully');
        if (!session.state.callEnded) {
            session.state.callEnded = true;
            handleContactEnded()
                .then((result) => result)
                .catch((err) => {
                    console.error(logStamp('handleContactEnded'), err);
                    session.clear();
                });
        }
    });

}
