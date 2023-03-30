import logStamp from '../util/log.js';

let previousMessageId;

const getChatTranscript = async (controller) => {
    try {
        const result = await controller.getTranscript({ maxResults: 100 }).then(({ data }) => data);
        if (result) {
            return result.Transcript.reduce((carry, payload) => {
                const item = convertChatMessage(payload);
                item && carry.push(item);
                return carry;
            }, []);
        }
    } catch (error) {
        console.error(logStamp("Failed to getTranscript:"), error);
    }
    return [];
};

export const convertChatMessage = (payload) => {
    // build transcript HTML

    console.log(logStamp("item payload"), payload);
    const { Id, AbsoluteTime, ContentType, Content, DisplayName, ParticipantRole, Type } = payload;
    
    // prevent duplicate messages in transcript
    if (previousMessageId === Id) {
        return null;
    } else {
        previousMessageId = Id;
    }

    let event;
    const side = ParticipantRole && ParticipantRole.toLowerCase() === "customer" ? "customer" : "agent";
    switch (ContentType) {
        case "application/vnd.amazonaws.connect.event.participant.joined":
            event = `${DisplayName} joined the conversation`;
            break;
        case "application/vnd.amazonaws.connect.event.participant.left":
            event = `${DisplayName} left the conversation`;
            break;
        case "application/vnd.amazonaws.connect.event.transfer.succeeded":
            event = 'Transfer succeeded'
            break;
        case "application/vnd.amazonaws.connect.event.transfer.failed":
            event = 'Transfer failed'
            break;
        default:
            event = 'other/unknown';
    }

    if (side == "customer") {
        let soundPlayer = document.getElementById("messageIncomingSound"); 
        soundPlayer.play(); 
    }

    let name = DisplayName;
    let content = Content;
    if (DisplayName === "SYSTEM_MESSAGE") {
        name = 'Chat bot';
        content = `<em>${Content}</em>`;
    }
    const timeFormatted = (new Date(AbsoluteTime)).toLocaleTimeString();
    let chatMessageHTML = `<div class="${side}-time">${timeFormatted} &#183; ${(Type === "EVENT" ? event : name)}</div>`;
    if (Type !== "EVENT") {
        chatMessageHTML += `<div class="${side}-turn"><div class="turn-bubble">${content}</div></div>`;
    }

    return chatMessageHTML;
}

export default getChatTranscript;
