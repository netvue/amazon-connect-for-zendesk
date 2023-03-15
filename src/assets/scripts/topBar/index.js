import logStamp from '../util/log.js';
import session from './session.js';
import initializeCCP from './initCCP.js';
import { zafClient, zafInit } from './zafClient.js';
import appendTicketComments from './appendTicketComments.js';
import { dialableNumber } from './phoneNumbers.js'
import newTicket from './newTicket.js';
import { resize, popTicket, determineAssignmentBehavior } from './core.js';
import ui from './ui.js'
import { buttons } from '../constants/callControls.js';
import { displayCallControls } from './callControls.js';
import unavailableAgentStates from './unavailableAgentStates.js';

window.onload = (event) => {
    // first, establish the window (tab) id
    const windowIdKey = 'vf.windowId';
    let windowId = sessionStorage.getItem(windowIdKey);
    if (!windowId) {
        windowId = uuidv4();
        console.log(logStamp('new window/tab opened'), windowId);
    }
    else {
        sessionStorage.removeItem(windowIdKey);
        console.log(logStamp('reloaded window/tab'), windowId);
    }
    session.windowId = windowId;
    window.addEventListener('beforeunload', () => {
        sessionStorage.setItem(windowIdKey, windowId);
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === 'visible') {
            localStorage.setItem('vf.tabInFocus', session.windowId);
        }
    }, false);

    window.vfConnectTimeout = window.setTimeout(() => {
        // ui.swapImage('loadingImg', 'prohibited.png');
        ui.show('whitelisting');
    }, 8000); // wait for 8 seconds for CCP to load and agent to authenticate

    ui.onClick('newTicketCreateBtn', async () => {
        const ticketId = await newTicket.createTicket().catch((err) => null); //TODO: handle this error
        if (ticketId) {
            // immediately update with call attributes, before popping to the agent
            resize('down');
            await appendTicketComments.appendContactDetails(session.contact, ticketId);
            await popTicket(session.zenAgentId, ticketId);
            if (session.contact.mediaType !== "chat")
                zafClient.invoke('popover', 'hide');
        }
    });

    ui.onClick('attachToCurrentBtn', async () => {
        const ticketId = session.ticketId;
        if (ticketId) {
            // immediately update with call attributes, before popping to the agent
            resize('down');
            await appendTicketComments.appendContactDetails(session.contact, ticketId);
            if (session.contact.mediaType !== "chat")
                zafClient.invoke('popover', 'hide');
        }
    });

    ui.onClick(buttons.SUSPEND, async () => {
        console.log(logStamp('Suspending call'), windowId);
        const connectAPI = new AWS.Connect({ apiVersion: '2017-08-08' });
        const params = {
            ContactId: session.contact.getContactId(),
            InitialContactId: session.contact.getInitialContactId(),
            InstanceId: session.zafInfo.settings.connectInstanceId,
        };
        await connectAPI.suspendContactRecording(params).promise().catch((err) => {
            console.error(logStamp('error calling suspendContactRecording: '), err);
        });
        localStorage.setItem('vf.currentlyRecording', 'false');
        displayCallControls({ isCurrentlyRecording: false });
    })

    ui.onClick(buttons.RESUME, async () => {
        console.log(logStamp('Resuming call'), windowId);
        const connectAPI = new AWS.Connect({ apiVersion: '2017-08-08' });
        const params = {
            ContactId: session.contact.getContactId(),
            InitialContactId: session.contact.getInitialContactId(),
            InstanceId: session.zafInfo.settings.connectInstanceId,
        };
        await connectAPI.resumeContactRecording(params).promise().catch((err) => {
            console.error(logStamp('error calling resumeContactRecording: '), err);
        });
        localStorage.setItem('vf.currentlyRecording', 'true');
        displayCallControls({ isCurrentlyRecording: true });
    })

    try {
        zafInit();
        zafClient.metadata().then((metadata) => {
            session.zafInfo = metadata;
            // console.log(logStamp('zafClient metadata'), metadata);
            const appSettings = session.zafInfo.settings;
            // console.log(logStamp('app settings'), appSettings);

            zafClient.context().then((context) => {
                // console.log(logStamp('zafClient context'), context);
                appSettings.subdomain = context.account.subdomain;
                initializeCCP(appSettings, 'ccpContainer');
                // console.log(logStamp('CCP loaded'));
                zafClient.on('instance.registered', onInstanceRegistered);
                zafClient.on("voice.dialout", onDialout);
                zafClient.on('vf.tab_switched', onTabSwitched);
                zafClient.on('app.deactivated', async () => {
                    console.log(logStamp("unloading topbar"));
                    sessionStorage.setItem(windowIdKey, windowId)
                });
            });

        });
        zafClient.get('currentUser').then((data) => {
            session.zenAgentId = data.currentUser.id;
            // console.log(logStamp('zendesk agent id'), session.zenAgentId);
        });
        // console.log(logStamp('ZAF initialized successfully'));
    }
    catch (error) {
        console.error(logStamp('ZAF initialization error'), error);
    }
};


// ----------------------- ZAF event hadlers ------------------------------------------------------

const onDialout = (dialOut) => {
    console.log(logStamp('dialing out'), dialOut);


    const agentState = session.agent.getState();
    console.log(logStamp("Agent's state"), agentState);
    if (unavailableAgentStates.includes(agentState.name)) {
        const message = "Please make sure you're in an available status first.";
        zafClient.invoke('notify', message, 'error', { sticky: true });
        zafClient.invoke('popover', 'show');
        return;
    }

    session.dialOut = dialOut;
    // number pad supported via softphone only
    if (!dialOut.number) {
        const message = "Please dial from the softphone's number pad.";
        zafClient.invoke('notify', message, 'notice');
        zafClient.invoke('popover', 'show');
        return;
    }

    const number = dialableNumber(dialOut.number);
    console.log(logStamp('Attempting to call'), number);

    const endpoint = connect.Endpoint.byPhoneNumber(number);
    session.agent.connect(endpoint, {
        success: () => {
            // console.log(logStamp('Succesfully called'), dialOut.number);
        },
        failure: (err) => {
            console.error(logStamp(`Couldn't call ${number} because of:`), err);
        }
    });
};

const onInstanceRegistered = async (context) => {
    // console.log(logStamp('onInstanceRegistered'), context);

    const contact = session.contact;
    if (!contact.contactId)
        return;

    const appSettings = session.zafInfo.settings;
    if (session.state.connected && !session.state.callEnded) {
        if (appSettings.speechAnalysisEnabled) {
            localStorage.setItem('vf.transcript-init', session.transcriptHtml);
        }

        const autoAssignTickets = determineAssignmentBehavior();
        if (context.location === 'new_ticket_sidebar' && !autoAssignTickets) {
            const message = 'During a call please create new tickets via your softphone.';
            zafClient.invoke('notify', message, 'alert', { sticky: true });
            zafClient.invoke('popover', 'show');
            resize('full');
        }
    }

};

const onTabSwitched = async (context) => {
    console.log(logStamp('onTabSwitched'), context);

    // if new tab is a ticket then save the id for possible outbound dialing to unrecognised number
    session.dialOut = null;
    session.currentTabTicket = context.tabType === 'ticket' ? context.itemId : null;

    const contact = session.contact;
    if (!contact.contactId)
        return;

    const autoAssignTickets = determineAssignmentBehavior();
    // only refresh user/ticket in agent mode while connected and not yet assigned
    if (!autoAssignTickets 
        && (session.state.callback || session.state.connected)
        && !session.state.callEnded
        && !session.ticketAssigned
    ) 
        newTicket.refreshUser(context.tabType, context.itemId);

};
