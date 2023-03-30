import ui from './ui.js';
import logStamp from '../util/log.js';
import session from './session.js';
import { zafClient } from './zafClient.js';
import { containerId as callControlsContainerId, resizeId as callControlsResizeId } from '../constants/callControls.js';
import { dialableNumber } from './phoneNumbers.js'

export const resize = (size) => {
    let height = 630;
    const expand = size === 'full' && !session.ticketAssigned;

    if (size !== callControlsResizeId) {
        if (expand) {
            ui.show('newTicketContainer');
            height += 80;
        } else {
            ui.hide('newTicketContainer');
        }
        const callControlsElement = document.getElementById(callControlsContainerId);
        if (callControlsElement && callControlsElement.style.display === 'flex') {
            height += 70;
        }
    }

    if (size === callControlsResizeId) {
        const newTicketContainer = document.getElementById('newTicketContainer');
        if (newTicketContainer && newTicketContainer.style.display === 'block') {
            height += 80;
        }
        ui.show(callControlsContainerId, 'flex')
        height += 70;
    }

    if (size === 'contactEnded') {
        ui.hide('newTicketcontainer')
        ui.hide(callControlsContainerId)
        height = 630;
    }

    zafClient.invoke('resize', {
        width: '900px',
        height: `${height}px`,
    });
}

export const determineAssignmentBehavior = () => {
    const appSettings = session.zafInfo.settings;
    return appSettings.createAssignTickets === 'auto';
}

export const popUser = async (agentId, userId) => {
    if (!userId) return;

    const data = await zafClient.request({
        url: `/api/v2/channels/voice/agents/${agentId}/users/${userId}/display.json`,
        type: 'POST',
        contentType: 'application/json',
        data: null
    }).catch(err => { console.error(logStamp('popUser'), err); });
    console.log(logStamp('user popped'), userId);
}

export const getFromZD = async (path, target, defaultValue = null) => {
    const data = await zafClient.request({
        url: `/api/v2/${path}`,
        type: 'GET',
        contentType: 'application/json',
    }).catch((err) => { console.error(logStamp(`getting ${target} by ${path} from Zendesk API: `), err) });
    const returnValue = data && data[target] ? data[target] : defaultValue;
    console.log(logStamp(`returning ${target} value obtained from Zendesk API query [${path}]: `), returnValue);
    return returnValue;
}

export const popTicket = async (agentId, ticketId) => {
    const data = await zafClient.request({
        url: `/api/v2/channels/voice/agents/${agentId}/tickets/${ticketId}/display.json`,
        type: 'POST',
        contentType: 'application/json',
        data: null
    }).catch(err => { console.error(logStamp('popTicket'), err); });
    console.log(logStamp('ticket popped: '), ticketId);
}

export const findTicket = async (query) => {
    console.log(logStamp('Searching for ticket by query: '), query);
    const tickets = await getFromZD(`search.json?query=type%3Aticket+%22${query}%22`, 'results', []);
    if (tickets.length) {
        const ticket = tickets[0];
        console.log(logStamp('Found matching ticket: '), ticket);
        return ticket.id;
    }
}

const findUser = async (query, requester = null, searchBy = 'phone') => {
    console.log(logStamp('Searching for user: '), { query, requester, searchBy });
    if (!(query && query.trim()))
        return null;

    if (searchBy === 'phone') {
        const prefix = session.zafInfo.settings.defaultCountryPrefix;
        console.log(logStamp('prefix: '), prefix);
        if (prefix && query.startsWith(prefix))
            query = query.substring(prefix.length);
    }

    console.log(logStamp('Searching for user by query: '), searchBy, query);
    const zdSearchQuery = `${searchBy}%3A${searchBy === 'phone' ? '*' : ''}${encodeURIComponent(query)}`;
    const users = await getFromZD(`search.json?query=type%3Auser%20${zdSearchQuery}`, 'results', []);
    if (users.length) {
        console.log(logStamp('Found matching user(s): '), users);
        if (requester) {
            const foundAsReqester = users.find((user) => user.id === requester);
            if (foundAsReqester) {
                console.log(logStamp('Ticket requester matched'), foundAsReqester.name);
                return foundAsReqester;
            } else {
                console.warn(logStamp(`No requester (${requester}) match!`));
                const message = `No user with this ${searchBy}: ${query} matches the requested ticket`;
                zafClient.invoke('notify', message, 'alert', { sticky: true })
                return null;
            }
        }
        let user;
        if (searchBy === 'phone') {
            user = await Promise.any(users.map((user) => (async (user, query) => {
                const userIdentities = await getFromZD(`users/${user.id}/identities`, 'identities', []);
                if (userIdentities.some((identity) => identity.type === 'phone_number' && dialableNumber(identity.value).endsWith(query))) {
                    console.log(logStamp(`Matched query ${query} with user `), user);
                    return user;
                } else return Promise.reject();
            })(user, query))).catch(() => null);
            if (!user) {
                console.log(logStamp('None of the returned user identities matched the query '), query);
                return null;
            }
            session.userPhone = query;
        } else {
            if (users.length > 1) {
                session.zafInfo.settings.createAssignTickets = 'agent';
                console.warn(logStamp(`multiple matches found for ${searchBy} ${query}. Turning on agent (manual) assignment mode!`));
                const message = `Multiple users with the ${searchBy} ${query} exist. Switching to manual assignment mode`;
                zafClient.invoke('notify', message, 'alert', { sticky: true });
                return null;
            }
            user = users[0];
        }
        return user;
    }
    console.log(logStamp(`User with ${searchBy} ${query} not found`), users);
    return null;
}

export const findMostRecentTicket = async (userId) => {
    const timeSpan = session.zafInfo.settings.createTicketAfterMinutes;
    // console.log(logStamp('time span in minutes: '), timeSpan);
    if (timeSpan == 0) return {};
    const tickets = await getFromZD(`users/${userId}/tickets/requested.json?sort_by=updated_at&sort_order=desc`, 'tickets', []);
    if (tickets.length) {
        const openTickets = tickets.filter((ticket) => ticket.status !== 'closed');
        if (openTickets.length) {
            const ticket = openTickets[0];
            console.log(logStamp('Found most recent ticket'), ticket);
            const timePassed = Math.floor((new Date() - new Date(ticket.updated_at).getTime()) / 1000 / 60);
            console.log(logStamp(`minutes passed since last update: `), timePassed);
            return timePassed <= timeSpan ? ticket : {};
        } else
            console.log(logStamp(`User ${userId} doesn't have any active tickets`));
    } else
        console.log(logStamp(`User ${userId} doesn't exist or has no tickets`));

    return {};
}

export const setSessionPhone = (contact) => {
    const appSettings = session.zafInfo.settings;
    const normalizedUserPhone = appSettings.userPhone?.replace(/[ \.\(\)-]/g, '');
    session.phoneNo = dialableNumber(normalizedUserPhone) || contact.customerNo;
    console.log(logStamp('setting session phoneNo to: '), session.phoneNo);
}

export const resolveUser = async (contact, requester = null, dialOut = null) => {

    // obtained from dial-out event?
    if (dialOut) {
        if (!dialOut.userId)
            return null;

        console.log(logStamp('Searching for user by dialout'), dialOut.userId);
        return getFromZD(`users/${dialOut.userId}.json`, 'user');
    }

    const appSettings = session.zafInfo.settings;
    // id obtained from the contact flow attribute?
    const userId = appSettings.zendeskUser;
    let user;
    if (userId) {
        console.log(logStamp('Searching for user by id via zendesk_user attribute'), userId);
        user = await getFromZD(`users/${userId}.json`, 'user');
        if (!user) {
            const message = `A user with the specified user id #${userId} was not found`;
            zafClient.invoke('notify', message, 'alert', { sticky: true });
            return null;
        }
        if (requester != null && user.id !== requester) {
            const message = `Requested ticket doesn't belong to this user`;
            zafClient.invoke('notify', message, 'alert', { sticky: true })
            return null;
        }
        return user;
    }

    const normalizedUserPhone = appSettings.userPhone?.replace(/[ \.\(\)-]/g, '');
    console.log(logStamp('trying to find the user by email, phone or name'));
    switch (contact.mediaType) {
        case "chat":
            user = await findUser(appSettings.userEmail, requester, 'email');
            if (user) return user;
            user = await findUser(normalizedUserPhone, requester, 'phone');
            if (user) return user;
            return findUser(appSettings.userName, requester, 'name');
        case "task":
            break;
        default: // softphone or deskphone - try just the phone number
            const phoneNo = normalizedUserPhone || contact.customerNo;
            if (!phoneNo || ['anonymous', 'private', 'unknown'].includes(phoneNo.toLowerCase().trim()))
                return { id: null, name: 'anonymous' };
            return findUser(phoneNo, requester, 'phone');
    }
}

export const validateTicket = async (ticketId) => {
    console.log(logStamp('Searching for ticket by number: '), ticketId);
    const ticket = await getFromZD(`tickets/${ticketId}.json`, 'ticket');
    return ticket
        ? {
            ticketId: ticket.id,
            requester: ticket.requester_id
        }
        : {}
}
