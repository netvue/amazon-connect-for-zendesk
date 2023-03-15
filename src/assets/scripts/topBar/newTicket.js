import { zafClient } from './zafClient.js';
import session from './session.js';
import logStamp from '../util/log.js';
import { getFromZD } from './core.js';
import ui from './ui.js';

const newRequester = '(New user will be created)';
const noRequester = '(please create or search for the user)';

const setRequesterName = (name) => {
    ui.setText('newTicketRequester', name || newRequester);
}

const capitaliseFirst = (phrase) => phrase.charAt(0).toUpperCase() + phrase.slice(1);

const extractNameFromEmail = (email) => {
    // first part before @
    let name = email.split('@')[0];
    // remove trailing numbers
    const i = name.indexOf(name.match(/\d+/));
    if (i >= 0)
        name = name.slice(0, i);
    const s = name.match(/[\._-]+/);
    if (s) {
        const parts = name.split(s);
        name = capitaliseFirst(parts[0]) + ' ' + capitaliseFirst(parts[1]);
    }
    return name;
}

const createUser = async () => {
    console.log(logStamp('Creating new user in Zendesk'));
    const appSettings = session.zafInfo.settings;
    const name = appSettings.userName || (appSettings.userEmail
        ? extractNameFromEmail(appSettings.userEmail)
        : `new user at ${session.phoneNo}`
    );
    const data = await zafClient.request({
        url: '/api/v2/users.json',
        type: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            user: {
                name: name,
                phone: session.phoneNo,
                ... (appSettings.userEmail && { email: appSettings.userEmail }),
            }
        })
    }).catch((err) => err);

    if (data.user) {
        console.log(logStamp('New user created'), data);
        session.user = data.user;
        setRequesterName(appSettings.userName || session.phoneNo);
    } else {
        console.error(logStamp('Error creating new user: '), data);
    }
}

const handleNewUser = async (contact) => {
    const appSettings = session.zafInfo.settings;
    if (contact.mediaType !== "chat") {
        await createUser();
        return session.user;
    }
    else if (appSettings.userEmail || appSettings.userPhone || appSettings.userName) {
        await createUser();
        return session.user;
    } else {
        // New chat user cannot be created. This is due to contact flow not setting any of customer identifying attributes
        // We will switch to agent (manual) assignment mode.
        session.zafInfo.settings.createAssignTickets = 'agent';
        const message = 'No customer data was passed through.\n Reverting to manual mode';
        zafClient.invoke('notify', message, 'alert', { sticky: true });
        return null;
    }
}

export default {

    setRequesterName,
    createUser,
    handleNewUser,

    refreshUser: async (type, id) => {
        console.log(logStamp(`refreshing user based on ${type}: ${id}`));
        ui.enable('attachToCurrentBtn', type === 'ticket');
        if (type === 'other') return;

        // search in existing tab stash
        ui.enable('newTicketCreateBtn');
        let requester = session.visitedTabs[type.substring(0, 1) + id];
        if (!requester) {
            // if not found, create a new entry
            let requesterKey;
            let userId = id;
            if (id) {
                if (type === 'ticket') {
                    const ticket = await getFromZD(`tickets/${id}.json`, 'ticket');
                    if (!ticket) return;
                    requesterKey = `t${id}`;
                    userId = ticket.requester_id;
                }
                const user = await getFromZD(`users/${userId}.json`, 'user');
                if (!user) return;
                requester = { user, name: user.name };
                requesterKey = requesterKey || `u${userId}`;
                session.visitedTabs[requesterKey] = requester;
            } else {
                console.log(logStamp(`media type: ${session.contact.mediaType}`));
                const isChat = session.contact.mediaType === "chat";
                ui.enable('newTicketCreateBtn', !isChat);
                requester = { name: isChat ? noRequester : newRequester };
            }
        }
        if (requester.user) {
            session.user = requester.user;
            localStorage.setItem('vf.viewingUserId', requester.user.id);
            if (type === 'ticket') {
                session.ticketId = id;
                localStorage.setItem('vf.viewingTicketId', id);
            } else
                localStorage.removeItem('vf.viewingTicketId');
        }

        setRequesterName(requester.name);
    },

    createTicket: async () => {

        // create new user on the fly if necessary
        if (!session.user)
            await createUser();
        if (!session.user)
            return null;

        const user = session.user;
        const eventType = session.contact.mediaType === "chat"
            ? 'incoming chat from'
            : (session.outbound ? "outgoing call to" : 'incoming call from')
        const ticket = {
            via_id: session.outbound ? 46 : 45,
            subject: `${capitaliseFirst(eventType)} ${user.name}`,
            requester_id: user.id || session.zenAgentId,
            submitter_id: session.zenAgentId,
            assignee_id: session.zenAgentId,
            comment: {
                body: `Ticket created by an ${eventType} ${user.name}`,
                public: false
            }
        };
        console.log(logStamp('creating ticket: '), ticket);

        const data = await zafClient.request({
            url: `/api/v2/channels/voice/tickets.json`,
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                // display_to_agent: session.zenAgentId,
                ticket
            })
        }).catch((err) => { console.error(logStamp('createTicket'), err); });
        console.log(logStamp('ticket created: '), data);
        return data && data.ticket ? data.ticket.id : null;
    }
}